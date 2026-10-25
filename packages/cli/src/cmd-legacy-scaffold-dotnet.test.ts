import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const FIXTURE = fileURLToPath(
  new URL("../../../examples/legacy-orders-dotnet/src", import.meta.url),
);

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-scaffold-dotnet-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("anvil legacy scaffold --lane dotnet", () => {
  it("drafts the fixture estate, writes the draft, and compiles through the ordinary pipeline", async () => {
    const draftPath = join(work, "drafts", "orders.openapi.json");
    const result = await anvil(
      "legacy",
      "scaffold",
      FIXTURE,
      "--lane",
      "dotnet",
      "--title",
      "legacy-orders",
      "--out",
      draftPath,
      "--json",
    );
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-scaffold",
      lanes: [{ lane: "dotnet", inputMembers: 6, endpoints: 11, diagnostics: 0 }],
      summary: { operations: 11, unmapped: 0, errors: 0, warnings: 0 },
      out: draftPath,
    });
    expect(report.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const draft = JSON.parse(readFileSync(draftPath, "utf8"));
    expect(Object.keys(draft.paths).sort()).toEqual([
      "/OrderArchive.asmx/GetSummary",
      "/OrderArchive.asmx/ReleaseHoldV2",
      "/api/Orders",
      "/api/Orders/{id}",
      "/api/Orders/{id}/cancel",
      "/api/Products",
      "/api/Products/{id}",
    ]);
    expect(draft["x-anvil-scaffold"]).toMatchObject({
      frameworks: ["asmx", "aspnet_core", "aspnet_webapi"],
      inputMembers: 6,
      operations: 11,
      contentHash: report.contentHash,
    });
    // Convention and inference are labelled, never silent.
    const getOrder = draft.paths["/api/Orders/{id}"].get;
    expect(getOrder.operationId).toBe("OrdersController.GetOrder");
    expect(getOrder.parameters).toContainEqual(
      expect.objectContaining({
        name: "id",
        in: "path",
        schema: { type: "integer", format: "int32", "x-anvil-source-type": "int" },
        "x-anvil-evidence": [
          expect.objectContaining({
            path: "Api/Controllers/OrdersController.cs",
            construct: "inferred_binding",
          }),
        ],
      }),
    );
    expect(draft.paths["/api/Products/{id}"].get["x-anvil-evidence"]).toContainEqual(
      expect.objectContaining({
        path: "Legacy/App_Start/WebApiConfig.cs",
        construct: "MapHttpRoute",
      }),
    );

    // Same input, same draft: a second run is accepted against the existing file.
    const again = await anvil(
      "legacy",
      "scaffold",
      FIXTURE,
      "--lane",
      "dotnet",
      "--title",
      "legacy-orders",
      "--out",
      draftPath,
      "--json",
    );
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).contentHash).toBe(report.contentHash);

    const bundle = join(work, "bundle");
    const compiled = await anvil("compile", draftPath, "--out", bundle);
    expect(compiled.code, compiled.err).toBe(0);
    expect(existsSync(join(bundle, "air.yaml"))).toBe(true);
    const inspect = await anvil("inspect", bundle, "--json");
    expect(inspect.code, inspect.err).toBe(0);
    const catalog = JSON.parse(inspect.out) as {
      operations: { displayName: string; effect: string; state: string }[];
    };
    const find = (name: string) => catalog.operations.find((op) => op.displayName === name);
    expect(find("OrdersController.GetOrder")).toMatchObject({ effect: "read" });
    expect(find("ProductsController.GetProduct")).toMatchObject({ effect: "read" });
    for (const name of [
      "OrdersController.Create",
      "OrdersController.Cancel",
      "OrderArchive.ReleaseHold",
    ]) {
      expect(find(name)?.effect, name).toBe("mutation");
      expect(find(name)?.state, name).not.toBe("approved");
    }
    expect(catalog.operations.some((op) => op.state === "approved")).toBe(false);
  });

  it("leaves convention-routed Web API actions unmapped when the route template is absent", async () => {
    writeFileSync(
      join(work, "ProductsController.cs"),
      readFileSync(join(FIXTURE, "Legacy", "Controllers", "ProductsController.cs")),
    );
    const result = await anvil(
      "legacy",
      "scaffold",
      join(work, "ProductsController.cs"),
      "--lane",
      "dotnet",
      "--json",
    );
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.summary).toMatchObject({ operations: 0, unmapped: 4, errors: 0 });
    expect(report.diagnostics.map((d: { code: string }) => d.code)).toContain(
      "legacy/scaffold/aspnet_webapi/route_template_unknown",
    );
    expect(report.document["x-anvil-scaffold"].unmapped).toHaveLength(4);
  });

  it("refuses an unknown lane with a structured code", async () => {
    const result = await anvil("legacy", "scaffold", FIXTURE, "--lane", "cobol", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.legacy-scaffold-error",
      code: "legacy/invalid_option",
    });
  });
});
