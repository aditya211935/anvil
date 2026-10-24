import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, describe, expect, it } from "vitest";
import { type LoopbackCheck, LoopbackReport, runLoopback } from "./loopback.js";

/**
 * Full loopback runs against real generated bundles: the bundle's own mock
 * upstream and its own mcp/server.js (spawned as a stdio child, resolving the
 * built @anvil/* dist packages) — no network, no LLM. Requires `pnpm build`
 * to have produced dist/ for the runtime packages, which the turbo test task
 * guarantees.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

/** Every check of one id that did not pass, for a failure message that names the culprit. */
const notPassing = (report: { checks: LoopbackCheck[] }, id: string) =>
  byId(report, id).filter((c) => c.status !== "pass");

/** A bundle's operation ids by source operationId, so a test names what the spec names. */
function operationIds(dir: string): Record<string, string> {
  const air = JSON.parse(readFileSync(join(dir, "air.json"), "utf8")) as {
    operations: Array<{ id: string; sourceRef: { operationId?: string } }>;
  };
  return Object.fromEntries(
    air.operations.flatMap((o) =>
      o.sourceRef.operationId ? [[o.sourceRef.operationId, o.id]] : [],
    ),
  );
}

const dirs: string[] = [];

async function buildBundle(spec: string, manifest: string, serviceId: string): Promise<string> {
  const air = await compile({ spec: read(spec), manifest: read(manifest), serviceId });
  const dir = mkdtempSync(join(tmpdir(), `anvil-loopback-${serviceId}-`));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  return dir;
}

const OBO_MANIFEST = `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://id.example.com/
      audience: api://payments
      carrier: { in: header, name: Authorization, scheme: Bearer }
      provider:
        grant: token_exchange
        token_endpoint: https://sts.example.com/oauth/token
        subject_token_type: jwt
        requested_token_type: access_token
`;

async function buildOboBundle(serviceId: string): Promise<string> {
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: OBO_MANIFEST,
    serviceId,
  });
  const dir = mkdtempSync(join(tmpdir(), `anvil-loopback-${serviceId}-`));
  dirs.push(dir);
  writeBundle(dir, generateBundle(air));
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const byId = (report: { checks: LoopbackCheck[] }, id: string, operationId?: string) =>
  report.checks.filter(
    (c) => c.id === id && (operationId === undefined || c.operationId === operationId),
  );

describe("loopback self-test (payments, OpenAPI)", () => {
  it("proves the generated bundle end-to-end: checks A-E pass", async () => {
    const dir = await buildBundle("payments/openapi.yaml", "payments/anvil.yaml", "payments");
    const report = await runLoopback(dir);

    // The report round-trips through its own schema.
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe(1);
    expect(report.bundle).toBe(dir);

    // A — surface.
    expect(byId(report, "surface")[0]?.status).toBe("pass");
    // B — fidelity for every approved operation, reads and mutations alike.
    const fidelity = byId(report, "fidelity");
    expect(fidelity).toHaveLength(4);
    expect(fidelity.every((c) => c.status === "pass")).toBe(true);
    // C — both confirmation-required mutations gate before any side effect.
    const gates = byId(report, "confirmation-gate");
    expect(gates.map((c) => c.operationId).sort()).toEqual([
      "payments.capture.create",
      "payments.refunds.create",
    ]);
    expect(gates.every((c) => c.status === "pass")).toBe(true);
    // D — a documented 404 surfaces as a structured envelope.
    expect(byId(report, "error-mapping")[0]?.status).toBe("pass");
    // E — a read survives an injected 503; payments has no non-idempotent
    // mutation, so the guard sub-check must be skipped, never silently passed.
    expect(byId(report, "retry-read")[0]?.status).toBe("pass");
    expect(byId(report, "retry-mutation-guard")[0]?.status).toBe("skipped");

    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThanOrEqual(9);
  }, 120_000);
});

describe("loopback self-test (banking, WSDL)", () => {
  it("proves WSDL-lowered reads and mutations end-to-end: every check passes", async () => {
    const dir = await buildBundle("soap/bank.wsdl", "soap/anvil.yaml", "banking");
    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);

    // A — the surface itself is aligned.
    expect(byId(report, "surface")[0]?.status).toBe("pass");

    // B — the mutations are lossless end-to-end (including the whole-body
    // projection of TransferFunds).
    expect(byId(report, "fidelity", "banking.transfer_funds.create")[0]?.status).toBe("pass");
    expect(byId(report, "fidelity", "banking.close_account.create")[0]?.status).toBe("pass");

    // B — the WSDL reads now lower to the truthful wire method (POST) with an
    // explicit read assertion, so their bodies actually reach the wire; the
    // names are unchanged from the GET-lowered era (naming parity).
    for (const opId of ["banking.get_account_balance.list", "banking.list_transactions.list"]) {
      const check = byId(report, "fidelity", opId)[0];
      expect(check?.status).toBe("pass");
    }

    // C — confirmation gates on both unsafe mutations.
    const gates = byId(report, "confirmation-gate");
    expect(gates.map((c) => c.operationId).sort()).toEqual([
      "banking.close_account.create",
      "banking.transfer_funds.create",
    ]);
    expect(gates.every((c) => c.status === "pass")).toBe(true);

    // D — the documented SOAP fault (500) surfaces as a structured envelope.
    expect(byId(report, "error-mapping")[0]?.status).toBe("pass");

    // E — the POST-reads are wire-executable, so the read sub-check runs for
    // real; CloseAccount (idempotency: none) must execute exactly once on a 503.
    expect(byId(report, "retry-read")[0]?.status).toBe("pass");
    const guard = byId(report, "retry-mutation-guard")[0];
    expect(guard?.status).toBe("pass");
    expect(guard?.operationId).toBe("banking.close_account.create");

    expect(report.summary.fail).toBe(0);
  }, 120_000);
});

describe("loopback self-test (empty approved surface)", () => {
  it("fails plainly with a pointer at the approval flow instead of leaking an MCP error", async () => {
    // No manifest — nothing is approved, so there is nothing to self-test.
    const air = await compile({ spec: read("payments/openapi.yaml"), serviceId: "payments" });
    const dir = mkdtempSync(join(tmpdir(), "anvil-loopback-empty-"));
    dirs.push(dir);
    writeBundle(dir, generateBundle(air));

    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: "surface", status: "fail" });
    expect(report.checks[0]?.detail).toMatch(/no approved operations/);
    expect(report.checks[0]?.detail).toMatch(/manifest/);
    expect(report.summary).toEqual({ pass: 0, fail: 1, skipped: 0 });
  }, 60_000);
});

describe("loopback self-test (delegated identity)", () => {
  it("proves the hermetic RFC 8693 bridge without claiming live IdP readiness", async () => {
    const dir = await buildOboBundle("payments_obo");
    const report = await runLoopback(dir);
    expect(byId(report, "auth-obo-token-exchange")[0]?.status).toBe("pass");
    expect(byId(report, "fidelity")[0]?.status).toBe("skipped");
    expect(report.identity).toMatchObject({
      delegatedOperations: 1,
      virtualWiring: "passed",
      proof: "virtual_wiring_only",
      liveIdpReadiness: "unverified",
    });
    expect(report.identity.detail).toMatch(/Live issuer discovery.*remain unverified/);
    expect(report.summary.fail).toBe(0);
  }, 60_000);
});

describe("loopback self-test (storefront, GraphQL)", () => {
  it("executes an approved query as POST on the wire and passes fidelity", async () => {
    const dir = await buildBundle("graphql/schema.graphql", "graphql/anvil.yaml", "storefront");

    // The lowered query is a truthful POST-read: retry/confirmation posture
    // follows the adapter-asserted effect, not the wire method.
    const air = JSON.parse(readFileSync(join(dir, "air.json"), "utf8")) as {
      operations: Array<{
        sourceRef: { operationId?: string; method?: string };
        effect: { kind: string };
        retries: { mode: string };
      }>;
    };
    const product = air.operations.find((o) => o.sourceRef.operationId === "product");
    expect(product?.sourceRef.method).toBe("post");
    expect(product?.effect.kind).toBe("read");
    expect(product?.retries.mode).toBe("safe");

    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(byId(report, "surface")[0]?.status).toBe("pass");
    // The query's arguments ride the POST body to the wire, losslessly. A
    // fidelity pass REQUIRES a captured wire request, so this also proves the
    // old GET-with-body executability failure is gone.
    expect(byId(report, "fidelity", "storefront.product.list")[0]?.status).toBe("pass");
    // Every approved operation — queries and enriched mutations — round-trips.
    expect(report.summary.fail).toBe(0);
  }, 120_000);
});

describe("loopback self-test (ledger, Stripe-shaped form encodings)", () => {
  it("drives deepObject form fields and query parameters to the wire losslessly", async () => {
    const dir = await buildBundle(
      "fixtures/ledger-form.yaml",
      "fixtures/ledger-form.anvil.yaml",
      "ledger",
    );
    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(byId(report, "surface")[0]?.status).toBe("pass");
    // The form body's deepObject fields (`metadata[order_id]`, `expand[0]`,
    // `transfer_data[destination]`) and the deepObject query parameters
    // (`created[gt]`, `expand[0]`) all reach the mock as the contract oracle
    // expects them — a fidelity pass requires a captured, validated request.
    expect(notPassing(report, "fidelity"), JSON.stringify(report.checks, null, 2)).toEqual([]);
    expect(byId(report, "fidelity")).toHaveLength(2);
    expect(byId(report, "error-mapping")[0]?.status).toBe("pass");
    expect(byId(report, "retry-read")[0]?.status).toBe("pass");
    expect(report.summary.fail, JSON.stringify(report.checks, null, 2)).toBe(0);
  }, 120_000);
});

describe("loopback self-test (kv, gRPC with a streaming RPC)", () => {
  it("skips the stream with the runtime's reason and still drives the unary call", async () => {
    const dir = await buildBundle(
      "fixtures/kv-stream.proto",
      "fixtures/kv-stream.anvil.yaml",
      "kv",
    );
    const ids = operationIds(dir);
    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);
    expect(byId(report, "surface")[0]?.status).toBe("pass");
    // Range: a transcoded unary call the mock facade serves — proven on the wire.
    expect(byId(report, "fidelity", ids.Range)[0]?.status).toBe("pass");
    // Watch: a stream no facade can frame — skipped, and the detail says why.
    const watch = byId(report, "fidelity", ids.Watch)[0];
    expect(watch?.status).toBe("skipped");
    expect(watch?.detail).toMatch(/not wire-executable: speaks grpc/);
    expect(report.summary.fail, JSON.stringify(report.checks, null, 2)).toBe(0);
  }, 120_000);

  it("passes a surface made only of non-executable operations, with every wire check skipped", async () => {
    const dir = await buildBundle(
      "fixtures/kv-stream.proto",
      "fixtures/kv-stream-only.anvil.yaml",
      "kv",
    );
    const report = await runLoopback(dir);
    expect(LoopbackReport.parse(report)).toEqual(report);
    // The surface is still a fact worth proving: the one approved tool is served.
    expect(byId(report, "surface")[0]?.status).toBe("pass");
    // Everything that needs a wire request is skipped and says so; nothing fails.
    for (const id of ["fidelity", "error-mapping", "retry-read", "retry-mutation-guard"]) {
      const check = byId(report, id)[0];
      expect(check?.status, id).toBe("skipped");
      expect(check?.detail, id).toMatch(/wire-executable/);
    }
    expect(byId(report, "fidelity")[0]?.detail).toMatch(/speaks grpc/);
    expect(report.summary).toEqual({ pass: 1, fail: 0, skipped: 4 });
  }, 120_000);
});
