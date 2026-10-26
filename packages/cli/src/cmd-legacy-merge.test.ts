import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-merge-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function javaFixture(environment: string, jndi: string): string {
  const source = join(work, `refunds-${environment}`);
  mkdirSync(join(source, "refunds", "META-INF"), { recursive: true });
  writeFileSync(
    join(source, "refunds", "META-INF", "ejb-jar.xml"),
    `<ejb-jar><enterprise-beans><session>
      <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
    </session></enterprise-beans></ejb-jar>`,
  );
  writeFileSync(
    join(source, "refunds", "META-INF", "weblogic-ejb-jar.xml"),
    `<weblogic-ejb-jar><weblogic-enterprise-bean>
      <ejb-name>RefundBean</ejb-name><jndi-name>${jndi}</jndi-name>
    </weblogic-enterprise-bean></weblogic-ejb-jar>`,
  );
  return source;
}

async function inventoryReport(environment: string, jndi: string): Promise<string> {
  const path = join(work, `${environment}.inventory.json`);
  const result = await anvil(
    "legacy",
    "inventory",
    javaFixture(environment, jndi),
    "--environment",
    environment,
    "--application",
    "refund-service",
    "--estate",
    "refunds",
    "--source-id",
    "offline-export",
    "--out",
    path,
    "--json",
  );
  expect(result.code, result.err).toBe(0);
  return path;
}

describe("anvil legacy merge", () => {
  it("merges two environment reports into one inventory report that downstream commands accept", async () => {
    const prod = await inventoryReport("prod", "ejb/refunds-prod");
    const uat = await inventoryReport("uat", "ejb/refunds-uat");
    const output = join(work, "merged", "estate.inventory.json");

    const merged = await anvil("legacy", "merge", prod, uat, "--out", output, "--json");
    expect(merged.code, merged.err).toBe(0);
    const report = JSON.parse(merged.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-estate-inventory",
      summary: { artifacts: 3, observations: 2, candidates: 2, conflicts: 0 },
      merge: {
        summary: {
          sources: 2,
          lineages: { consistent: 0, divergent: 1, singleOccurrence: 0 },
          crossSourceDisagreements: 1,
        },
      },
    });
    expect(report.inventory.inventoryId).toMatch(/^li_[a-f0-9]{64}$/);
    expect(report.inventory.estate).toEqual({ id: "refunds" });
    expect(report.merge.lineages[0].divergentDimensions).toEqual(["binding_target"]);
    expect(report.collectors).toEqual([
      { collector: "java-ee", inputMembers: 4, observations: 2, diagnostics: 0 },
    ]);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);

    // Identical rewrite is accepted; different content is refused.
    const rewrite = await anvil("legacy", "merge", uat, prod, "--out", output, "--json");
    expect(rewrite.code).toBe(0);
    expect(rewrite.out).toBe(merged.out);
    const different = await anvil("legacy", "merge", prod, "--out", output, "--json");
    expect(different.code).toBe(1);
    expect(JSON.parse(different.out)).toMatchObject({
      reportType: "anvil.legacy-estate-inventory-merge-error",
      code: "legacy/merge_output_exists",
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);

    // The merged report is a complete inventory report for every downstream command.
    const gaps = await anvil("legacy", "gaps", output, "--json");
    expect(gaps.code, gaps.err).toBe(0);
    expect(JSON.parse(gaps.out).reportType).toBe("anvil.legacy-coverage-and-gaps");

    const candidateId = report.candidates[0].candidateId as string;
    const explain = await anvil("legacy", "explain", output, candidateId, "--json");
    expect(explain.code, explain.err).toBe(0);
    expect(JSON.parse(explain.out).explanation.candidate.candidateId).toBe(candidateId);

    const diff = await anvil("legacy", "diff", prod, output, "--json");
    expect(diff.code, diff.err).toBe(0);
    expect(JSON.parse(diff.out).diff.changedLineages).toHaveLength(1);
  });

  it("gates on cross-source disagreement with --check and prints a human summary", async () => {
    const prod = await inventoryReport("prod", "ejb/refunds-prod");
    const uat = await inventoryReport("uat", "ejb/refunds-uat");

    const divergent = await anvil("legacy", "merge", prod, uat, "--check");
    expect(divergent.code).toBe(1);
    expect(divergent.out).toContain("2 source inventory(ies)");
    expect(divergent.out).toContain("1 logical lineage(s): 0 consistent, 1 divergent");
    expect(divergent.out).toContain("1 cross-source disagreement warning(s)");

    const uatSame = await inventoryReport("uat2", "ejb/refunds-prod");
    const consistent = await anvil("legacy", "merge", prod, uatSame, "--check", "--json");
    expect(consistent.code, consistent.err).toBe(0);
    expect(JSON.parse(consistent.out).merge.summary).toMatchObject({
      lineages: { consistent: 1, divergent: 0 },
      crossSourceDisagreements: 0,
    });
  });

  it("refuses mismatched estates unless --estate names the merged estate", async () => {
    const prod = await inventoryReport("prod", "ejb/refunds-prod");
    const otherPath = join(work, "other.inventory.json");
    const other = await anvil(
      "legacy",
      "inventory",
      javaFixture("uat", "ejb/refunds-uat"),
      "--environment",
      "uat",
      "--application",
      "refund-service",
      "--estate",
      "refunds-uat",
      "--out",
      otherPath,
      "--json",
    );
    expect(other.code, other.err).toBe(0);

    const refused = await anvil("legacy", "merge", prod, otherPath, "--json");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({
      reportType: "anvil.legacy-estate-inventory-merge-error",
      code: "legacy/merge/estate_mismatch",
    });

    const named = await anvil(
      "legacy",
      "merge",
      prod,
      otherPath,
      "--estate",
      "refunds-all",
      "--estate-name",
      "All refunds",
      "--json",
    );
    expect(named.code, named.err).toBe(0);
    expect(JSON.parse(named.out).inventory.estate).toEqual({
      id: "refunds-all",
      name: "All refunds",
    });

    const nameOnly = await anvil(
      "legacy",
      "merge",
      prod,
      otherPath,
      "--estate-name",
      "x",
      "--json",
    );
    expect(JSON.parse(nameOnly.out)).toMatchObject({ code: "legacy/merge/invalid_option" });
  });

  it("accepts a bare snapshot and refuses unreadable or invalid inputs with stable codes", async () => {
    const prod = await inventoryReport("prod", "ejb/refunds-prod");
    const snapshotPath = join(work, "prod.snapshot.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify(JSON.parse(readFileSync(prod, "utf8")).inventory, null, 2),
    );
    const single = await anvil("legacy", "merge", snapshotPath, "--json");
    expect(single.code, single.err).toBe(0);
    expect(JSON.parse(single.out).merge.summary.lineages.singleOccurrence).toBe(1);

    const missing = await anvil("legacy", "merge", prod, join(work, "absent.json"), "--json");
    expect(JSON.parse(missing.out)).toMatchObject({ code: "legacy/merge_input_unreadable" });

    const invalidPath = join(work, "invalid.json");
    writeFileSync(invalidPath, "{not json");
    const invalid = await anvil("legacy", "merge", prod, invalidPath, "--json");
    expect(JSON.parse(invalid.out)).toMatchObject({ code: "legacy/merge_input_invalid" });
  });
});
