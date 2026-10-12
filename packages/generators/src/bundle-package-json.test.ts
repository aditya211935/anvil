import { readFileSync } from "node:fs";
import { loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";

/**
 * A generated bundle's package.json installs the MCP SDK its servers import.
 * The range must be the one the runtime itself is built and tested against,
 * read from @anvil/mcp-runtime's manifest at test time, so a bump there cannot
 * leave generated bundles resolving an older SDK.
 */
describe("generated package.json", () => {
  it("asks for the same @modelcontextprotocol/sdk range as @anvil/mcp-runtime", () => {
    const runtime = JSON.parse(
      readFileSync(new URL("../../mcp-runtime/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const air = loadAirDocument({
      service: {
        id: "sdk-range",
        version: "1.0.0",
        source: { kind: "openapi" },
        servers: [{ url: "https://sdk-range.example.com" }],
      },
      operations: [],
      workflows: [],
    });
    const bundle = JSON.parse(generateBundle(air).files["package.json"] as string) as {
      dependencies: Record<string, string>;
    };
    const range = runtime.dependencies["@modelcontextprotocol/sdk"];
    expect(range).toMatch(/^\^1\.\d+\.\d+$/);
    expect(bundle.dependencies["@modelcontextprotocol/sdk"]).toBe(range);
  });
});
