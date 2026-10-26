import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-schema-"));
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
  new URL("../../../examples/legacy-batch-mainframe/export/COPYLIB/CUSTREC.cpy", import.meta.url),
);

describe("anvil legacy schema copybook", () => {
  it("emits a JSON Schema report with verbatim names and writes the schema document safely", async () => {
    const output = join(work, "schemas", "custrec.schema.json");
    const result = await anvil("legacy", "schema", "copybook", FIXTURE, "--out", output, "--json");

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-copybook-schema",
      source: { format: "fixed" },
      summary: { title: "CUST-REC", byteLength: 298, diagnostics: { error: 0 } },
    });
    expect(report.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(Object.keys(report.schema.properties)).toContain("CUST-ID");
    expect(report.schema.properties["CUST-ID"]["x-anvil-cobol"]).toMatchObject({
      declaration: "05 CUST-ID PIC 9(8)",
      offset: 0,
      byteLength: 8,
    });
    expect(report.schema.properties["CUST-STATUS"].enum).toEqual(["A", "C"]);
    expect(report.schema.properties["CUST-OPEN-DATE"].oneOf).toHaveLength(2);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report.schema);

    const second = await anvil("legacy", "schema", "copybook", FIXTURE, "--out", output, "--json");
    expect(second.code).toBe(0);
    expect(second.out).toBe(result.out);

    const human = await anvil("legacy", "schema", "copybook", FIXTURE);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Copybook schema sha256:");
    expect(human.out).toContain("CUST-REC");
  });

  it("refuses empty copybooks, symlinks, missing files, and output collisions with stable codes", async () => {
    const empty = join(work, "EMPTY.cpy");
    writeFileSync(empty, "      * nothing but a comment\n");
    const noItems = await anvil("legacy", "schema", "copybook", empty, "--json");
    expect(noItems.code).toBe(1);
    expect(JSON.parse(noItems.out)).toMatchObject({
      reportType: "anvil.legacy-copybook-schema-error",
      code: "legacy/schema_no_items",
    });

    const linked = join(work, "linked.cpy");
    symlinkSync(FIXTURE, linked);
    const symlink = await anvil("legacy", "schema", "copybook", linked, "--json");
    expect(JSON.parse(symlink.out)).toMatchObject({ code: "legacy/schema_source_refused" });

    const missing = await anvil("legacy", "schema", "copybook", join(work, "absent.cpy"), "--json");
    expect(JSON.parse(missing.out)).toMatchObject({ code: "legacy/schema_source_unreadable" });

    const output = join(work, "existing.json");
    writeFileSync(output, "different\n");
    const collision = await anvil(
      "legacy",
      "schema",
      "copybook",
      FIXTURE,
      "--out",
      output,
      "--json",
    );
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.out)).toMatchObject({ code: "legacy/output_exists" });
    expect(readFileSync(output, "utf8")).toBe("different\n");

    const badFormat = await anvil(
      "legacy",
      "schema",
      "copybook",
      FIXTURE,
      "--format",
      "ebcdic",
      "--json",
    );
    expect(JSON.parse(badFormat.out)).toMatchObject({ code: "legacy/invalid_option" });
  });

  it("refuses oversized and binary input", async () => {
    const big = join(work, "BIG.cpy");
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const oversized = await anvil("legacy", "schema", "copybook", big, "--json");
    expect(JSON.parse(oversized.out)).toMatchObject({ code: "legacy/schema_source_too_large" });

    const binary = join(work, "BIN.cpy");
    writeFileSync(binary, Buffer.from([0x00, 0xc1, 0xff, 0xfe]));
    const refused = await anvil("legacy", "schema", "copybook", binary, "--json");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ code: "legacy/schema_source_refused" });
  });

  it("reports warnings such as COPY in the exit code only when errors occur", async () => {
    const wrap = join(work, "WRAP.cpy");
    writeFileSync(
      wrap,
      "       01  WRAP-REC.\n           COPY CUSTREC.\n           05  TAIL PIC X(2).\n",
    );
    const result = await anvil("legacy", "schema", "copybook", wrap, "--json");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy/copybook/copy_not_followed" }),
    );
    expect(report.summary.diagnostics.warning).toBeGreaterThan(0);
  });
});
