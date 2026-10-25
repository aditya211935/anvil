import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-mainframe-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

const FIXTURE = fileURLToPath(
  new URL("../../../examples/legacy-batch-mainframe/export", import.meta.url),
);

describe("anvil legacy inventory --collector mainframe", () => {
  it("inventories the synthetic JCL fixture into batch_job candidates", async () => {
    const output = join(work, "reports", "inventory.json");
    const result = await anvil(
      "legacy",
      "inventory",
      FIXTURE,
      "--estate",
      "payroll-example",
      "--environment",
      "prod",
      "--application",
      "payroll",
      "--source-kind",
      "source_repository",
      "--source-id",
      "jcl-example",
      "--revision",
      "fixture-v1",
      "--collector",
      "mainframe",
      "--out",
      output,
      "--json",
    );

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      reportType: "anvil.legacy-estate-inventory",
      collectors: [{ collector: "mainframe", inputMembers: 3, observations: 2 }],
      summary: { artifacts: 3, candidates: 2, conflicts: 0, diagnostics: { error: 0 } },
    });
    const invocations = report.candidates.map(
      (candidate: { invocation: unknown }) => candidate.invocation,
    );
    expect(invocations).toContainEqual({
      kind: "batch_job",
      schedulerRef: "jcllib:PROD.PROCLIB",
      job: "PAYROLL1",
    });
    expect(invocations).toContainEqual({
      kind: "batch_job",
      schedulerRef: "proclib",
      job: "PAYRPT",
    });
    for (const candidate of report.candidates) {
      expect(candidate.businessSemantics).toBe("unknown");
      expect(candidate.disposition).toBe("triage");
      expect(candidate.claims.map((claim: { dimension: string }) => claim.dimension)).not.toContain(
        "idempotency",
      );
    }
    expect(result.out).not.toContain("SELECT DEPT=FIN");
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);

    const second = await anvil(
      "legacy",
      "inventory",
      FIXTURE,
      "--estate",
      "payroll-example",
      "--environment",
      "prod",
      "--application",
      "payroll",
      "--source-kind",
      "source_repository",
      "--source-id",
      "jcl-example",
      "--revision",
      "fixture-v1",
      "--collector",
      "mainframe",
      "--json",
    );
    expect(second.out).toBe(result.out);
  });

  it("accepts the mainframe lane in the --collector option and surfaces secret refusals", async () => {
    const source = join(work, "jcl-export");
    mkdirSync(join(source, "JCL"), { recursive: true });
    writeFileSync(
      join(source, "JCL", "FTPJOB.jcl"),
      "//FTPJOB   JOB (ACCT),'FTP',USER=OPER1,PASSWORD=HUNTER2\n//S1       EXEC PGM=FTP\n",
    );
    const result = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "payroll",
      "--collector",
      "mainframe",
      "--json",
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.summary).toMatchObject({ candidates: 0, diagnostics: { error: 1 } });
    expect(report.inventory.diagnostics[0]).toMatchObject({
      code: "legacy/mainframe/secret_like_value",
      collectorId: "mainframe",
    });
    expect(result.out).not.toContain("HUNTER2");

    const invalid = await anvil(
      "legacy",
      "inventory",
      source,
      "--environment",
      "prod",
      "--application",
      "payroll",
      "--collector",
      "cobol",
      "--json",
    );
    expect(JSON.parse(invalid.out)).toMatchObject({
      code: "legacy/invalid_option",
      message: expect.stringContaining("mainframe"),
    });
  });
});
