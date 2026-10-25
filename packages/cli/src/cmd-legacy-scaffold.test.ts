import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const FIXTURE = resolve(__dirname, "../../../examples/legacy-orders-java");

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-scaffold-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("anvil legacy scaffold", () => {
  it("drafts an OpenAPI document from Java source and writes identical output safely", async () => {
    const output = join(work, "drafts", "orders.openapi.json");
    const result = await anvil("legacy", "scaffold", FIXTURE, "--out", output, "--json");

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-scaffold",
      lanes: [{ lane: "java", inputMembers: 8, endpoints: 13, diagnostics: 0 }],
      summary: { operations: 10, unmapped: 3, errors: 0, warnings: 0 },
      out: output,
    });
    expect(report.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.document).toBeUndefined();

    const draft = JSON.parse(readFileSync(output, "utf8"));
    expect(draft.openapi).toBe("3.0.3");
    expect(draft.info.title).toBe("legacy-orders-java");
    expect(Object.keys(draft.paths)).toEqual([
      "/api/orders",
      "/api/orders/{orderId}",
      "/api/orders/{orderId}/cancel",
      "/shipments",
      "/shipments/{shipmentId}",
      "/shipments/{shipmentId}/label",
    ]);
    expect(draft["x-anvil-scaffold"]).toMatchObject({
      contentHash: report.contentHash,
      frameworks: ["jaxrs", "servlet", "spring_mvc"],
      unmapped: [
        expect.objectContaining({ framework: "servlet", path: "*.csv" }),
        expect.objectContaining({ framework: "servlet", path: "/export/*" }),
        expect.objectContaining({ framework: "spring_mvc", path: "/shipments/health" }),
      ],
    });
    const getOrder = draft.paths["/api/orders/{orderId}"].get;
    expect(getOrder.operationId).toBe("OrderResource.getOrder");
    expect(getOrder["x-anvil-evidence"]).toContainEqual({
      path: "src/main/java/com/acme/orders/OrderResource.java",
      line: 36,
      construct: "@GET",
    });
    expect(getOrder.description).toBeUndefined();

    const second = await anvil("legacy", "scaffold", FIXTURE, "--out", output, "--json");
    expect(second.code).toBe(0);
    expect(second.out).toBe(result.out);
  });

  it("refuses to overwrite a different draft and reports an empty lane", async () => {
    const output = join(work, "existing.json");
    writeFileSync(output, "different\n");
    const collision = await anvil("legacy", "scaffold", FIXTURE, "--out", output, "--json");
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.out)).toMatchObject({
      reportType: "anvil.legacy-scaffold-error",
      code: "legacy/output_exists",
    });
    expect(readFileSync(output, "utf8")).toBe("different\n");

    const source = join(work, "notes");
    writeFileSync(`${source}.txt`, "no source here\n");
    const empty = await anvil("legacy", "scaffold", `${source}.txt`, "--lane", "java", "--json");
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out)).toMatchObject({
      lanes: [],
      summary: { operations: 0, unmapped: 0, warnings: 1 },
      diagnostics: [expect.objectContaining({ code: "legacy/scaffold/no_applicable_source" })],
    });
  });
});
