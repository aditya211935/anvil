import type { LegacyModernizationScorecard } from "./scorecard.js";

type Row = readonly (string | number)[];

function table(header: Row, rows: readonly Row[]): string[] {
  if (rows.length === 0) return ["_none_", ""];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => code(cell)).join(" | ")} |`),
    "",
  ];
}

/** Escape pipes so a value never breaks the table it is in. */
function code(cell: string | number): string {
  return typeof cell === "number" ? String(cell) : cell.replaceAll("|", "\\|");
}

function counts(record: Record<string, number>, prefix: string): Row[] {
  return Object.entries(record).map(([key, total]) => [`${prefix}${key}`, total]);
}

/**
 * Render a scorecard as deterministic Markdown: the same report always yields
 * the same text, with no timestamps, paths, or generated prose beyond the
 * fixed `nextAction` sentence each blocker code carries. The heading is the
 * content-addressed scorecard id so a printed copy can be matched to the
 * JSON it came from.
 */
export function renderLegacyModernizationScorecard(report: LegacyModernizationScorecard): string {
  const { estate, capabilities, coverage, review, blockers } = report;
  const lines: string[] = [
    `# Legacy modernization scorecard \`${report.scorecardId}\``,
    "",
    `Estate \`${estate.id}\`${estate.name ? ` (${estate.name})` : ""} · inventory \`${estate.inventoryId}\` · content hash \`${report.contentHash}\``,
    "",
    "Every figure below is a count over inventory or binding records. The scorecard proposes no approval, asserts no idempotency, and reports no capability as ready; `executable_shape` means only that the queue bridge can conformance-test that transport shape.",
    "",
    "## Estate",
    "",
    ...table(
      ["Measure", "Count"],
      [
        ["deployment coordinates (environment/application)", estate.coordinates],
        ["artifacts", estate.artifacts],
        ["evidence records", estate.evidence],
        ["invocation observations", estate.observations],
        ["diagnostics: error", estate.diagnostics.error],
        ["diagnostics: warning", estate.diagnostics.warning],
        ["diagnostics: info", estate.diagnostics.info],
        ["safety refusals", estate.safetyRefusals],
      ],
    ),
    "## Capabilities",
    "",
    `${capabilities.total} candidate(s).`,
    "",
    "### By invocation kind",
    "",
    ...table(
      ["Kind", "Count"],
      capabilities.byInvocationKind.map((entry) => [entry.key, entry.count]),
    ),
    "### By protocol",
    "",
    ...table(
      ["Kind/protocol", "Count"],
      capabilities.byProtocol.map((entry) => [entry.key, entry.count]),
    ),
    "### Disposition and business semantics",
    "",
    ...table(
      ["State", "Count"],
      [
        ...counts(capabilities.byDisposition, "disposition: "),
        ...counts(capabilities.businessSemantics, "business semantics: "),
      ],
    ),
    "### Conflicts",
    "",
    `${capabilities.withConflicts.candidates} candidate(s) carry ${capabilities.withConflicts.conflicts} conflict(s).`,
    "",
    ...table(
      ["Dimension in conflict", "Candidates"],
      capabilities.withConflicts.byDimension.map((entry) => [entry.key, entry.count]),
    ),
    "### Unknown claim dimensions",
    "",
    "Candidates with no evidenced claim for the dimension, most often absent first.",
    "",
    ...table(
      ["Dimension", "Candidates without a claim"],
      capabilities.unknownDimensions.map((entry) => [entry.key, entry.count]),
    ),
    "## Coverage",
    "",
    `Coverage report \`${coverage.reportId}\`${coverage.planId ? ` against plan \`${coverage.planId}\`` : " against the default requirements"}.`,
    "",
    ...table(
      ["Measure", "Value"],
      [
        ["outcome", coverage.outcome],
        ["semantic completeness", coverage.semanticComplete ? "complete" : "incomplete"],
        ["requirements satisfied", coverage.requirements.satisfied],
        ["requirements partial", coverage.requirements.partial],
        ["requirements missing", coverage.requirements.missing],
        ["requirements not applicable", coverage.requirements.not_applicable],
        [
          "unsatisfied",
          coverage.unsatisfied.length === 0 ? "none" : coverage.unsatisfied.join(", "),
        ],
      ],
    ),
    "## Review",
    "",
    `${review.bindingsSupplied} reviewed binding(s) supplied; ${review.candidatesReviewed} candidate(s) reviewed, ${review.candidatesUnreviewed} unreviewed.`,
    "",
    ...table(
      ["Measure", "Count"],
      [
        ...counts(review.byLineage, "lineage: "),
        ...counts(review.byRuntimeStatus, "runtime: "),
        ...counts(review.byShape, "shape: "),
      ],
    ),
    "### Adapter families still required",
    "",
    ...table(
      ["Family", "Bindings"],
      review.needsDriverFamilies.map((entry) => [entry.key, entry.count]),
    ),
    "### Bindings",
    "",
    ...table(
      ["Binding", "Operation", "Transport", "Runtime", "Shape", "Family", "Lineage"],
      review.bindings.map((binding) => [
        binding.bindingId,
        binding.operationName,
        binding.transport,
        binding.runtimeStatus,
        binding.shape,
        binding.family ?? "—",
        binding.lineage,
      ]),
    ),
    "## Blockers",
    "",
    ...table(
      ["Code", "Count", "Detail", "Next action"],
      blockers.map((item) => [
        item.family ? `${item.code} (${item.family})` : item.code,
        item.count,
        item.detail,
        item.nextAction,
      ]),
    ),
    "## What this scorecard does not say",
    "",
    "- It does not approve, rank, or recommend any candidate; approval is a separate human decision bound to one proposal.",
    "- It does not assert idempotency, retry safety, or business completion for any operation.",
    "- `executable_shape` is the shape `anvil legacy bridge conformance` can test against a broker double, not a statement that the binding runs or that a broker was reached.",
    "- `conformance_passed` is a statement about the bridge's own code against a double; live readiness is unverified for every binding.",
  ];
  return `${lines.join("\n")}\n`;
}
