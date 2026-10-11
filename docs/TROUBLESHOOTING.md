# Troubleshooting

Start with `status`. Most Anvil failures are deliberate state transitions or
policy refusals, and `status` names the next safe action without mutating the
bundle.

```bash
anvil status generated/service
anvil status generated/service --json
```

Use the JSON form in automation. Use the human form when investigating.

## Installation and build

### `anvil: command not found`

When running from the repository, use:

```bash
pnpm build
pnpm anvil --help
```

If you created a shell alias, remember that aliases are usually scoped to one
shell session.

### A module under `dist/` is missing

The workspace was not built completely, or a package failed before the CLI was
emitted.

```bash
pnpm build
```

Fix the first package failure. Do not copy a `dist/` directory from another
checkout; generated package output must match the source and lock file.

### pnpm removes or refuses `node_modules`

Use the version pinned by `packageManager` in the repository root:

```bash
corepack enable
corepack pnpm --version
pnpm install --frozen-lockfile
```

## Source capture and compilation

### The source is `invalid` or `unclassified`

Inspect the locked diagnostic record:

```bash
anvil source list
anvil source show <snapshot-id>
anvil source validate <snapshot-id>
```

Common causes are malformed YAML/JSON/XML, no recognized entrypoint, an escaping
local reference, or multiple entrypoints without an explicit selection. Anvil
may retain the invalid snapshot for forensics, but it will not compile it.

### A remote `$ref` was not resolved

Source capture does not fetch remote content. Vendor the referenced contract
under the import root or produce a fully resolved source upstream, then capture
again. This is required for reproducibility.

### `adopt` says the MCP endpoint answered with a redirect

An HTTP endpoint must be the server's final URL. Redirects are followed only
when they keep the request method (307, 308) and stay on the same scheme, host
and port (MCP SDK 1.32+), which keeps `--header` values from reaching a host
you didn't name. Pass the URL the redirect points to as the endpoint.

### The wrong service or operation name was generated

Use stable source operation ids where possible. Repair agent-facing routing in
the manifest:

```yaml
operations:
  doTransition:
    name:
      resource: issue
      verb: transition
```

Recompile. Do not rename files or tool definitions inside the bundle.

## Readiness and approval

### An operation remains `review_required`

Ask for the reason rather than approving around it:

```bash
anvil inspect generated/service
anvil assess generated/service <operation-id>
anvil lint generated/service
```

Typical causes include an unproven mutation effect, missing idempotency,
ambiguous auth, weak naming, a raw query passthrough, or an unresolved workflow
dependency. Add evidence-backed facts to the manifest and recompile.

### `approve` refuses a gateway-imported bundle

Receipt-bound gateway imports preserve immutable import-to-approval lineage.
Record the reviewed state in the supplemental manifest and rerun the exact
estate import command shown by Anvil. In-place approval is intentionally
disabled for that bundle type.

### Capability approval is blocked by tool budget

Inspect the grouping before using `--allow-large`:

```bash
anvil capability show generated/service <capability-id> \
  --operations --auth --evidence
anvil capability diff generated/service <capability-id>
```

Prefer splitting an incoherent capability. Use the large-capability override
only with a review note that explains why the grouping remains operable.

## Runtime refusals

### `confirmation_required`

The operation requires explicit intent. Preview the call with every required
argument, `--confirm`, and any required idempotency key:

```bash
anvil run generated/service <resource> <verb> \
  --confirm \
  --idempotency-key <unique-key> \
  --dry-run
```

Do not add confirmation automatically in a retry loop. The caller must
understand and intend the effect.

### `idempotency_key_required`

Supply a stable key unique to the intended business action, not a random value
for every retry. Reusing the same key with a different request body should
conflict.

### `idempotency_ledger_unavailable`

Outside development, a write that requires durable deduplication fails closed
when no durable ledger is ready. Inspect the generated contract:

```bash
anvil deploy ledger generated/service \
  --project <project-id> \
  --database <database-id>
```

After deployment, require `/readyz` to return HTTP 200. Static generation proves
wiring, not live database access or IAM.

### `policy_denied`

Inspect the full structured error. A common cause is host pinning: the generated
request resolved to a host outside `ANVIL_ALLOWED_HOSTS`. Fix the reviewed
upstream configuration; do not widen the allowlist without understanding the
egress boundary.

### `host_not_allowed` or `origin_not_allowed`

With `ANVIL_INBOUND_AUTH_MODE` unset, `runtime/server.js` and
`mcp/server-sse.js` have no token to check. A web page can reach them by
pointing its own domain at this machine (DNS rebinding), at `127.0.0.1` or at
its network address, so every route, `/healthz` and `/readyz` included, runs
two checks first:

- On every connection, a request that carries an `Origin` header is served
  only when it names the server's own loopback origin: `http://` with
  `127.0.0.1`, `localhost`, or `[::1]`, on the port the connection arrived on.
  A browser adds `Origin` to every request that can call a tool. Neither server
  sends CORS headers, so no page on another origin could use them anyway, and
  MCP clients outside a browser send no `Origin`. A gateway or reverse proxy
  that answers CORS itself and forwards the browser's `Origin` gets
  `origin_not_allowed`: have it drop `Origin` after its own CORS check, or set
  `ANVIL_INBOUND_AUTH_MODE`.
- On a connection that arrives on a loopback address, `Host` must name a
  loopback address (`127.0.0.1`, `localhost`, `[::1]`, any port). Connections
  on any other address, such as those from a Kubernetes Service or
  `docker run -p`, keep whatever `Host` they bring.

Nothing is checked when `K_SERVICE` is set (Cloud Run, Knative: the
queue-proxy delivers every request to `127.0.0.1` with the public `Host`).

The usual cause of `host_not_allowed` is a forwarder that delivers its own host
name to `localhost`: a tunnel such as ngrok or cloudflared, or a local reverse
proxy that preserves `Host`. For a reverse proxy (on this machine or in front
of a container), list its public name in `ANVIL_INBOUND_ALLOWED_HOSTS` (comma-separated, `host` or
`host:port`, matched exactly and case-insensitively against `Host`). A request
with that `Host` is served when its `Origin`, if any, is `http://` or
`https://` that same host. Otherwise set `ANVIL_INBOUND_AUTH_MODE` so the
bearer token is the gate; webhook routes keep verifying their own signatures.
For a local-only setup, have the forwarder send the loopback `Host`.

A port forward (`kubectl port-forward`, `ssh -L`) sends a loopback `Host`
with its own local port. Only `runtime/server.js` and `mcp/server-sse.js`
accept a port that differs from their own. The other unauthenticated listeners
require the port in `Host` to be theirs, so forward to the same local port
number (`kubectl port-forward 8788:8788`): the fleet
(`anvil serve mcp <workspace> --fleet --http <port>`, which checks `Host` on
every connection; see [fleet](fleet.md)), the stdio fleet's `/readyz`
listener, the legacy protocol facade, and `anvil console`.

What inbound auth off still leaves open: a browser sends no `Origin` on a
same-origin GET, so a page whose request arrives off the loopback (rebound to
this machine's network address, or to `127.0.0.1` in front of `docker run -p`)
can still read the GET routes, such as `/openapi`, `/metrics`, and `/healthz`,
and open `mcp/server-sse.js`'s `GET /sse` stream. None returns credentials or
calls a tool (`POST /messages` carries `Origin` and is refused). Set
`ANVIL_INBOUND_AUTH_MODE` to close that too.

When inbound auth is unset and the server listens on every interface outside
Cloud Run and Kubernetes, it prints one warning line on stderr at startup,
because anything that can reach the port, not only this machine, can call its
tools.

### An operation did not retry

Check `safe_to_retry`, the operation's idempotency mode, and the transient
condition. Anvil will not retry a mutation merely because the error was a
timeout. If the upstream committed the request before disconnecting, a blind
retry could duplicate the effect.

## Assurance and release

### Certification or executable evidence is stale

The bundle changed after the evidence was produced. Run:

```bash
anvil status generated/service
```

Then rerun the lanes from the first stale action. Avoid parallel jobs that each
regenerate or mutate the bundle; they will produce evidence for different
hashes.

### `selftest` cannot start the generated server

Confirm the workspace packages were built and the entire bundle is present.
Do not copy only `mcp/` without its catalog, runtime documents, and package
dependencies. Run `certify` first; it usually identifies a missing projection
more directly.

### `conformance` reports surface drift

One or more generated views do not match AIR. The usual cause is a hand edit or
partial copy. Remove the candidate output and recompile from the reviewed source
and manifest. Never repair one surface independently.

### A simulation mutant survived

Treat this as a safety-regression detection gap, not as flaky coverage. Read the
mutant and affected operation, fix the control or test surface, regenerate, and
rerun all evidence lanes against the new hash.

### `publish` refuses production

Production release planning requires the configured static and executable
evidence to be fresh and passing. Use `status` to find the first missing lane.
Do not use the non-production incomplete-evidence waiver for production.

### `status` says `operator-action-required`

This is the expected state after a release plan has been prepared. Anvil has
not deployed anything. Review and apply the plan through your delivery system,
then establish live endpoint and dependency readiness separately.

## Generated files changed unexpectedly

Generated output is disposable. Compare the source snapshot, manifest, Anvil
version, and command options. If those inputs match, the bundle should be
deterministic.

Do not preserve a manual patch in `generated/`. Move the intended change to one
of these sources:

- API contract for transport shape;
- Anvil manifest for operational semantics;
- target/deployment configuration for environment coordinates; or
- Anvil code for a generator or runtime behavior change.

Then recompile and rerun assurance.

## Ask for a machine-readable report

Most inspection commands support `--json`. Capture the complete JSON report and
the command's exit code when filing an issue. Include:

- Anvil version;
- source format and snapshot id;
- command and options with secret values removed;
- structured diagnostic or error code;
- `anvil status <bundle> --json`; and
- whether the bundle was edited, moved, or partially copied.

Never attach production credentials, bearer tokens, API keys, or unredacted
request bodies containing customer data.
