import type { AirDocument, Operation } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { buildMcpServer } from "@anvil/mcp-runtime";
import { type HttpRequest, MockTransport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { runToolCli } from "./tool-cli.js";

/**
 * A Google Discovery method whose verb+`path` collides with another's is
 * lowered on its `flatPath` (compiler, `protocols/discovery.ts`). flatPath's
 * variables are synthetic names (`{placesId}`, `{tablesId}`) that the method's
 * own parameters never declared, so the lowering must bind them as real path
 * parameters — otherwise the braces leak into the wire URL, and the CLI and
 * MCP surfaces encode the leftovers differently (`{tablesId}` vs `%7BtablesId%7D`),
 * a silent CLI↔MCP divergence. This test drives both surfaces against a fake
 * upstream and checks the URL each one actually sends.
 */

const HOST = "google.example.test";
const BASE = `https://${HOST}`;

const discoveryDoc = JSON.stringify({
  kind: "discovery#restDescription",
  name: "places",
  version: "v1",
  title: "Places API",
  rootUrl: `${BASE}/`,
  servicePath: "",
  resources: {
    places: {
      methods: {
        // Places-shaped GET collision: `places.get` vs `places.photos.getMedia`.
        get: {
          id: "places.places.get",
          path: "v1/{+name}",
          flatPath: "v1/places/{placesId}",
          httpMethod: "GET",
          parameters: {
            name: { type: "string", location: "path", required: true, pattern: "^places/[^/]+$" },
          },
          response: { $ref: "Place" },
        },
      },
      resources: {
        photos: {
          methods: {
            getMedia: {
              id: "places.places.photos.getMedia",
              path: "v1/{+name}",
              flatPath: "v1/places/{placesId}/photos/{photosId}/media",
              httpMethod: "GET",
              parameters: {
                name: {
                  type: "string",
                  location: "path",
                  required: true,
                  pattern: "^places/[^/]+/photos/[^/]+/media$",
                },
                maxWidthPx: { type: "integer", location: "query" },
              },
              response: { $ref: "PhotoMedia" },
            },
          },
        },
      },
    },
    // BigQuery-shaped POST collision: tables vs routines `:getIamPolicy`.
    tables: {
      methods: {
        getIamPolicy: {
          id: "bigquery.tables.getIamPolicy",
          path: "{+resource}:getIamPolicy",
          flatPath: "projects/{projectsId}/datasets/{datasetsId}/tables/{tablesId}:getIamPolicy",
          httpMethod: "POST",
          parameters: {
            resource: {
              type: "string",
              location: "path",
              required: true,
              pattern: "^projects/[^/]+/datasets/[^/]+/tables/[^/]+$",
            },
          },
          request: { $ref: "GetIamPolicyRequest" },
          response: { $ref: "Policy" },
        },
      },
    },
    routines: {
      methods: {
        getIamPolicy: {
          id: "bigquery.routines.getIamPolicy",
          path: "{+resource}:getIamPolicy",
          flatPath:
            "projects/{projectsId}/datasets/{datasetsId}/routines/{routinesId}:getIamPolicy",
          httpMethod: "POST",
          parameters: {
            resource: {
              type: "string",
              location: "path",
              required: true,
              pattern: "^projects/[^/]+/datasets/[^/]+/routines/[^/]+$",
            },
          },
          request: { $ref: "GetIamPolicyRequest" },
          response: { $ref: "Policy" },
        },
      },
    },
  },
  schemas: {
    Place: { type: "object", properties: { id: { type: "string" } } },
    PhotoMedia: { type: "object", properties: { photoUri: { type: "string" } } },
    GetIamPolicyRequest: {
      type: "object",
      properties: {
        options: { type: "object", properties: { requestedPolicyVersion: { type: "integer" } } },
      },
    },
    Policy: { type: "object", properties: { etag: { type: "string" } } },
  },
});

let air: AirDocument;
beforeAll(async () => {
  const compiled = await compile({
    spec: discoveryDoc,
    serviceId: "places",
    sourceUri: "places.json",
  });
  expect(compiled.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  // Every colliding method survived, and each is served from its flatPath.
  expect(compiled.operations.map((o) => o.sourceRef.operationId).sort()).toEqual([
    "bigquery.routines.getIamPolicy",
    "bigquery.tables.getIamPolicy",
    "places.places.get",
    "places.places.photos.getMedia",
  ]);
  air = structuredClone(compiled);
  for (const op of air.operations) op.state = "approved";
});

const operation = (operationId: string): Operation => {
  const op = air.operations.find((o) => o.sourceRef.operationId === operationId);
  if (!op) throw new Error(`fixture: ${operationId} missing`);
  return op;
};

const upstream = () =>
  new MockTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ id: "x" }) }));

type Input = Record<string, unknown>;

/** `--kebab-case` flags from the operation's snake_case agent inputs (a JSON body as text). */
const flags = (input: Input) =>
  Object.entries(input).flatMap(([k, v]) => [
    `--${k.replace(/_/g, "-")}`,
    typeof v === "string" ? v : JSON.stringify(v),
  ]);

async function viaCli(op: Operation, input: Input): Promise<HttpRequest> {
  const transport = upstream();
  const io = bufferIO();
  const argv = [...op.cli.command.split(" ").slice(1), ...flags(input)];
  if (op.confirmation.required) argv.push("--confirm");
  const code = await runToolCli(air, argv, {
    transport,
    io,
    env: { ANVIL_ENV: "dev", ANVIL_ALLOWED_HOSTS: HOST } as NodeJS.ProcessEnv,
    sleep: async () => {},
  });
  expect(code, io.stderr.join("\n")).toBe(0);
  expect(transport.requests).toHaveLength(1);
  return transport.requests[0] as HttpRequest;
}

async function viaMcp(op: Operation, input: Input): Promise<HttpRequest> {
  const transport = upstream();
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      serviceId: air.service.id,
      baseUrl: BASE,
      allowedHosts: [HOST],
      audit: () => {},
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "flatpath-wire-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({
      name: op.mcp.toolName,
      arguments: { ...input, ...(op.confirmation.required ? { confirm: true } : {}) },
    })) as { isError?: boolean; content?: unknown };
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  } finally {
    await client.close();
  }
  expect(transport.requests).toHaveLength(1);
  return transport.requests[0] as HttpRequest;
}

function expectCleanUrl(request: HttpRequest, expected: string) {
  expect(request.url).toBe(expected);
  // No template variable survived to the wire, in either spelling.
  expect(request.url).not.toMatch(/[{}]/);
  expect(request.url).not.toMatch(/%7B|%7D/i);
}

describe("Discovery flatPath rebinding: the CLI and MCP wire URLs agree and carry no braces", () => {
  it("GET collision (Places get vs photos.getMedia)", async () => {
    const get = operation("places.places.get");
    const media = operation("places.places.photos.getMedia");
    expect(get.id).not.toBe(media.id);

    const cliGet = await viaCli(get, { places_id: "ChIJ-1" });
    const mcpGet = await viaMcp(get, { places_id: "ChIJ-1" });
    expectCleanUrl(cliGet, `${BASE}/v1/places/ChIJ-1`);
    expectCleanUrl(mcpGet, `${BASE}/v1/places/ChIJ-1`);
    expect(cliGet.method).toBe("GET");
    expect(mcpGet.method).toBe("GET");

    const cliMedia = await viaCli(media, { places_id: "ChIJ-1", photos_id: "ph9" });
    const mcpMedia = await viaMcp(media, { places_id: "ChIJ-1", photos_id: "ph9" });
    expectCleanUrl(cliMedia, `${BASE}/v1/places/ChIJ-1/photos/ph9/media`);
    expectCleanUrl(mcpMedia, `${BASE}/v1/places/ChIJ-1/photos/ph9/media`);
  });

  it("POST custom-method collision (BigQuery tables vs routines :getIamPolicy)", async () => {
    const tables = operation("bigquery.tables.getIamPolicy");
    const routines = operation("bigquery.routines.getIamPolicy");
    expect(tables.id).not.toBe(routines.id);

    // The whole-body request (`GetIamPolicyRequest`) rides as `--body` / `body`.
    const input = { projects_id: "p1", datasets_id: "d1", tables_id: "t1", body: {} };
    const cli = await viaCli(tables, input);
    const mcp = await viaMcp(tables, input);
    expectCleanUrl(cli, `${BASE}/projects/p1/datasets/d1/tables/t1:getIamPolicy`);
    expectCleanUrl(mcp, `${BASE}/projects/p1/datasets/d1/tables/t1:getIamPolicy`);
    expect(cli.method).toBe("POST");
    expect(mcp.method).toBe("POST");

    const routinesInput = { projects_id: "p1", datasets_id: "d1", routines_id: "r1", body: {} };
    expectCleanUrl(
      await viaCli(routines, routinesInput),
      `${BASE}/projects/p1/datasets/d1/routines/r1:getIamPolicy`,
    );
    expectCleanUrl(
      await viaMcp(routines, routinesInput),
      `${BASE}/projects/p1/datasets/d1/routines/r1:getIamPolicy`,
    );
  });

  it("percent-encodes a segment value instead of letting it re-expand the template", async () => {
    const get = operation("places.places.get");
    const cli = await viaCli(get, { places_id: "a/b{c}" });
    const mcp = await viaMcp(get, { places_id: "a/b{c}" });
    expect(cli.url).toBe(mcp.url);
    expect(cli.url).toBe(`${BASE}/v1/places/a%2Fb%7Bc%7D`);
  });
});
