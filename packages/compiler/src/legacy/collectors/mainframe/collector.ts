import {
  type JclStatement,
  parseJcl,
  resolveSymbols,
  splitOperands,
  subparameters,
  unquote,
} from "./jcl.js";
import type {
  MainframeArtifactInput,
  MainframeCollectorResult,
  MainframeDataset,
  MainframeDiagnostic,
  MainframeObservation,
  MainframeStep,
} from "./model.js";
import {
  type AcceptedMainframeArtifact,
  acceptMainframeArtifacts,
  isCopybookPath,
} from "./safety.js";

const MAX_STEPS = 255;
const MAX_DATASETS_PER_STEP = 512;
const MAX_TEXT = 512;

/**
 * Collect batch-job observations from JCL job and procedure members. The
 * collector reads cards as inert text: it never submits a job, resolves a
 * cataloged procedure, opens a dataset, or copies in-stream data.
 */
export function collectMainframeLegacy(
  inputs: readonly MainframeArtifactInput[],
): MainframeCollectorResult {
  const accepted = acceptMainframeArtifacts(inputs);
  const diagnostics = [...accepted.diagnostics];
  const observations: MainframeObservation[] = [];
  const copybooks = copybookIndex(accepted.artifacts);
  const linkedCopybooks = new Set<string>();

  for (const artifact of accepted.artifacts) {
    if (isCopybookPath(artifact.path)) continue;
    const parsed = parseJcl(artifact.text, artifact.path);
    diagnostics.push(...parsed.diagnostics);
    const projected = projectMember(artifact, parsed.statements, copybooks);
    diagnostics.push(...projected.diagnostics);
    for (const observation of projected.observations) {
      for (const dataset of allDatasets(observation)) {
        if (dataset.copybookPath) linkedCopybooks.add(dataset.copybookPath);
      }
    }
    observations.push(...projected.observations);
  }

  for (const artifact of accepted.artifacts) {
    if (!isCopybookPath(artifact.path) || linkedCopybooks.has(artifact.path)) continue;
    diagnostics.push({
      level: "info",
      code: "mainframe/copybook_recorded",
      message: `Recorded copybook '${artifact.path}' as a schema artifact; no DD referenced its member name. Convert it with 'anvil legacy schema copybook'.`,
      coordinate: { origin: artifact.path },
    });
  }

  return {
    collector: { kind: "mainframe", schemaVersion: 1 },
    evidence: accepted.artifacts.map((artifact) => artifact.evidence),
    observations: observations.sort((a, b) =>
      `${a.coordinate}:${a.id}`.localeCompare(`${b.coordinate}:${b.id}`),
    ),
    diagnostics: deduplicateDiagnostics(diagnostics).sort(diagnosticOrder),
  };
}

interface Projection {
  observations: MainframeObservation[];
  diagnostics: MainframeDiagnostic[];
}

interface Building {
  observation: MainframeObservation;
  symbols: Map<string, string>;
  lastDatasetName?: string;
}

function projectMember(
  artifact: AcceptedMainframeArtifact,
  statements: readonly JclStatement[],
  copybooks: ReadonlyMap<string, string>,
): Projection {
  const origin = artifact.path;
  const diagnostics: MainframeDiagnostic[] = [];
  const finished: MainframeObservation[] = [];
  const unknownOperations = new Set<string>();
  let job: Building | undefined;
  const procedureStack: Building[] = [];
  const pendingSymbols = new Map<string, string>();
  const pendingIncludes: string[] = [];

  const current = (): Building | undefined => procedureStack.at(-1) ?? job;
  const finish = (building: Building | undefined): void => {
    if (!building) return;
    building.observation.symbols = Object.fromEntries(
      [...building.symbols.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    building.observation.includes = [...new Set(building.observation.includes)].sort();
    finished.push(building.observation);
  };
  const start = (
    kind: MainframeObservation["kind"],
    name: string,
    statement: JclStatement,
    inStreamProcedure: boolean,
  ): Building => {
    const building: Building = {
      observation: {
        id: `${kind}:${name}`,
        kind,
        coordinate: `jcl:${origin}:${kind}:${name}`,
        name,
        schedulerRef: kind === "job" ? "jes" : "proclib",
        steps: [],
        libraryDatasets: [],
        symbols: {},
        includes: [...pendingIncludes],
        conditions: [],
        inStreamProcedure,
        evidence: [
          {
            origin,
            pointer: `${kind}:${name}`,
            span: { start: statement.line, end: statement.endLine },
          },
        ],
        confidence: "declared",
      },
      symbols: new Map(pendingSymbols),
    };
    pendingIncludes.length = 0;
    return building;
  };
  const implicitProcedure = (statement: JclStatement): Building => {
    const name = memberName(origin);
    diagnostics.push({
      level: "info",
      code: "mainframe/implicit_procedure",
      message: `'${origin}' has no JOB or PROC statement; its steps were recorded as procedure '${name}' named after the member.`,
      coordinate: { origin, span: { start: statement.line, end: statement.endLine } },
    });
    const building = start("procedure", name, statement, false);
    job = building;
    return building;
  };

  for (const statement of statements) {
    switch (statement.operation) {
      case "JOB": {
        for (const open of procedureStack.splice(0)) finish(open);
        finish(job);
        job = start("job", statement.name || "UNNAMED", statement, false);
        break;
      }
      case "PROC": {
        const name = statement.name || memberName(origin);
        if (job) {
          procedureStack.push(start("procedure", name, statement, true));
        } else {
          job = start("procedure", name, statement, false);
        }
        break;
      }
      case "PEND": {
        finish(procedureStack.pop());
        break;
      }
      case "EXEC": {
        const target = current() ?? implicitProcedure(statement);
        if (target.observation.steps.length >= MAX_STEPS) {
          diagnostics.push({
            level: "warning",
            code: "mainframe/too_many_steps",
            message: `'${origin}' declares more than ${MAX_STEPS} steps in '${target.observation.name}'; later steps were ignored.`,
            coordinate: { origin, span: { start: statement.line, end: statement.endLine } },
          });
          break;
        }
        target.observation.steps.push(buildStep(statement, target));
        target.observation.evidence.push({
          origin,
          pointer: `step:${target.observation.steps.length}:${statement.name || "unnamed"}`,
          span: { start: statement.line, end: statement.endLine },
        });
        target.lastDatasetName = undefined;
        break;
      }
      case "DD": {
        const target = current();
        if (!target) break;
        const dataset = buildDataset(statement, target, copybooks);
        if (!dataset) break;
        const step = target.observation.steps.at(-1);
        const bucket = step ? step.datasets : target.observation.libraryDatasets;
        if (bucket.length >= MAX_DATASETS_PER_STEP) break;
        bucket.push(dataset);
        if (dataset.copybookPath) {
          target.observation.evidence.push({ origin: dataset.copybookPath });
        }
        break;
      }
      case "SET": {
        const { keywords } = splitOperands(statement.operands);
        const target = current();
        for (const [symbol, value] of keywords) {
          (target ? target.symbols : pendingSymbols).set(symbol, bounded(unquote(value)));
        }
        break;
      }
      case "INCLUDE": {
        const member = splitOperands(statement.operands).keywords.get("MEMBER");
        if (!member) break;
        const target = current();
        (target ? target.observation.includes : pendingIncludes).push(bounded(unquote(member)));
        diagnostics.push({
          level: "info",
          code: "mainframe/include_not_followed",
          message: `'${origin}' includes member '${unquote(member)}'; included cards were not read.`,
          coordinate: { origin, span: { start: statement.line, end: statement.endLine } },
        });
        break;
      }
      case "JCLLIB": {
        const order = splitOperands(statement.operands).keywords.get("ORDER");
        const target = job;
        if (!order || !target) break;
        const libraries = subparameters(order).map(unquote).filter(Boolean);
        if (libraries.length > 0) {
          target.observation.schedulerRef = bounded(`jcllib:${libraries.join(",")}`);
        }
        break;
      }
      case "IF": {
        const target = current();
        if (!target) break;
        const expression = statement.operands.replace(/\s*THEN\s*$/i, "").trim();
        if (expression && target.observation.conditions.length < 64) {
          target.observation.conditions.push(bounded(expression));
        }
        break;
      }
      case "ELSE":
      case "ENDIF":
      case "OUTPUT":
      case "COMMAND":
      case "CNTL":
      case "ENDCNTL":
      case "EXPORT":
      case "NOTIFY":
      case "SCHEDULE":
      case "XMIT":
        break;
      default:
        unknownOperations.add(statement.operation);
    }
  }
  for (const open of procedureStack.splice(0)) finish(open);
  finish(job);

  if (unknownOperations.size > 0) {
    diagnostics.push({
      level: "warning",
      code: "mainframe/unknown_statement",
      message: `'${origin}' uses JCL operations this collector does not interpret: ${[...unknownOperations].sort().join(", ")}.`,
      coordinate: { origin },
    });
  }
  if (finished.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "mainframe/no_discoverable_job",
      message: `'${origin}' declares no JOB, PROC, or EXEC statement.`,
      coordinate: { origin },
    });
  }
  return { observations: finished, diagnostics };
}

function buildStep(statement: JclStatement, target: Building): MainframeStep {
  const { positional, keywords } = splitOperands(statement.operands);
  const ordinal = target.observation.steps.length + 1;
  const step: MainframeStep = {
    ordinal,
    name: statement.name || `STEP${ordinal}`,
    datasets: [],
    line: statement.line,
  };
  const program = keywords.get("PGM");
  const procedure = keywords.get("PROC") ?? positional[0];
  if (program) step.program = bounded(resolveSymbols(unquote(program), target.symbols));
  else if (procedure) step.procedure = bounded(resolveSymbols(unquote(procedure), target.symbols));
  const parm = keywords.get("PARM");
  if (parm !== undefined) step.parm = bounded(unquote(parm));
  const cond = keywords.get("COND");
  if (cond !== undefined) step.cond = bounded(cond);
  return step;
}

function buildDataset(
  statement: JclStatement,
  target: Building,
  copybooks: ReadonlyMap<string, string>,
): MainframeDataset | undefined {
  const { positional, keywords } = splitOperands(statement.operands);
  const ddName = statement.name || target.lastDatasetName;
  if (!ddName) return undefined;
  target.lastDatasetName = ddName;
  const dataset: MainframeDataset = {
    ddName,
    direction: "unknown",
    inStream: statement.inStreamData,
    line: statement.line,
  };
  const dsn = keywords.get("DSN") ?? keywords.get("DSNAME");
  if (dsn !== undefined && !statement.inStreamData) {
    dataset.dsn = bounded(resolveSymbols(unquote(dsn), target.symbols));
    const member = /^[^()]+\(([A-Z0-9@#$]{1,8})\)$/i.exec(dataset.dsn)?.[1];
    const copybook = member ? copybooks.get(member.toUpperCase()) : undefined;
    if (copybook) dataset.copybookPath = copybook;
  }
  const disposition = keywords.get("DISP");
  if (disposition !== undefined && positional[0]?.toUpperCase() !== "DUMMY") {
    const status = (subparameters(disposition)[0] ?? "").toUpperCase() || "NEW";
    dataset.disposition = status;
    if (status === "SHR" || status === "OLD") dataset.direction = "input";
    else if (status === "NEW" || status === "MOD") dataset.direction = "output";
  }
  return dataset;
}

function copybookIndex(artifacts: readonly AcceptedMainframeArtifact[]): Map<string, string> {
  const index = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (!isCopybookPath(artifact.path)) continue;
    const member = memberName(artifact.path);
    counts.set(member, (counts.get(member) ?? 0) + 1);
    if (!index.has(member)) index.set(member, artifact.path);
  }
  for (const [member, count] of counts) if (count > 1) index.delete(member);
  return index;
}

function memberName(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.[^.]+$/, "").toUpperCase();
}

function allDatasets(observation: MainframeObservation): MainframeDataset[] {
  return [...observation.libraryDatasets, ...observation.steps.flatMap((step) => step.datasets)];
}

function bounded(value: string): string {
  return value.trim().slice(0, MAX_TEXT);
}

function deduplicateDiagnostics(diagnostics: MainframeDiagnostic[]): MainframeDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.coordinate?.origin ?? ""}:${diagnostic.coordinate?.span?.start ?? ""}:${diagnostic.message}`,
        diagnostic,
      ]),
    ).values(),
  ];
}

function diagnosticOrder(left: MainframeDiagnostic, right: MainframeDiagnostic): number {
  return (
    (left.coordinate?.origin ?? "").localeCompare(right.coordinate?.origin ?? "") ||
    (left.coordinate?.span?.start ?? 0) - (right.coordinate?.span?.start ?? 0) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}
