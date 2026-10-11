import type { RuntimeEnvVar } from "@anvil/runtime";

/**
 * The variables the serving path itself reads, beyond `@anvil/runtime`'s
 * contract: the listener port, what the rebinding gate and the open-listener
 * warning read (`loopback-guard.ts`), the inbound OAuth resource-server family
 * (`inbound-auth.ts`), and the business-gateway serving inputs
 * (`business-serving.ts`). Declared beside the code that reads them so the
 * generated `deploy/env.schema.json` is derived, not transcribed — see the
 * drift guard in `@anvil/generators`.
 */
export const SERVING_ENV_CONTRACT: readonly RuntimeEnvVar[] = [
  {
    name: "PORT",
    description: "HTTP listener port for runtime/server.js. Cloud Run sets it; defaults to 8080.",
    default: "8080",
    pattern: "^[1-9][0-9]*$",
  },
  {
    name: "K_SERVICE",
    description:
      "Set by Cloud Run and Knative, never by an operator. With inbound auth off, its presence suppresses the startup warning that the server listens on every interface and turns off the DNS-rebinding checks on Host and Origin, because the platform's queue-proxy delivers every request to 127.0.0.1 with the public Host.",
  },
  {
    name: "KUBERNETES_SERVICE_HOST",
    description:
      "Set by Kubernetes in every pod, never by an operator. Like K_SERVICE, its presence suppresses the startup warning for inbound auth off on every interface.",
  },
  {
    name: "ANVIL_INBOUND_ALLOWED_HOSTS",
    description:
      "With inbound auth off only: comma-separated host names (host or host:port, matched exactly against the Host header, case-insensitive) the server also answers as on any connection, typically for a reverse proxy (on this machine or in front of a container) that keeps the public Host. Such a request is served when its Origin, if any, is http:// or https:// that same host. Not ANVIL_ALLOWED_HOSTS, which pins upstream egress. Unset, a loopback connection must name a loopback address.",
  },
  {
    name: "ANVIL_INBOUND_AUTH_MODE",
    description:
      'Inbound bearer verification for every tool route: "none" (default; local runs behind other controls), "oidc" (RS256 JWT against ANVIL_INBOUND_JWKS_URI), "google_service_account" (Google-issued tokens; issuer and certs fixed unless overridden), or "branchyard" (EdDSA per-turn tokens carrying a grant; served only by `anvil serve mcp --fleet --http`, and refused by this server). Business gateways refuse "none" outside dev.',
    enum: ["none", "oidc", "google_service_account", "branchyard"],
  },
  {
    name: "ANVIL_INBOUND_ISSUER",
    description: "Expected `iss` claim of inbound tokens. Required when the mode is oidc.",
  },
  {
    name: "ANVIL_INBOUND_AUDIENCE",
    description: "Expected `aud` claim of inbound tokens. Required when inbound auth is enabled.",
  },
  {
    name: "ANVIL_INBOUND_RESOURCE",
    description:
      "The protected resource identifier advertised at /.well-known/oauth-protected-resource (RFC 9728).",
  },
  {
    name: "ANVIL_INBOUND_JWKS_URI",
    description:
      "Public HTTPS JWKS endpoint used to verify inbound token signatures. Required when the mode is oidc; for branchyard it may also be a file: URL.",
  },
  {
    name: "ANVIL_INBOUND_REQUIRED_SCOPES",
    description: "Space- or comma-separated scopes an inbound token must carry.",
  },
  {
    name: "ANVIL_INBOUND_LEEWAY_SECONDS",
    description: "Clock-skew leeway applied to inbound token time claims.",
    pattern: "^[0-9]+$",
  },
  {
    name: "ANVIL_BUSINESS_SOURCES",
    description:
      "Business gateway only: JSON object of source bindings (base URLs, credential profiles) the private execution plan resolves against.",
  },
  {
    name: "ANVIL_BUSINESS_CONTEXT",
    description:
      "Business gateway, dev only: a JSON BusinessContext used when no verified inbound identity is present.",
  },
  {
    name: "ANVIL_BUSINESS_TENANT",
    description:
      "Business gateway: tenant used when the inbound token carries neither `tid` nor `tenant`.",
  },
  {
    name: "ANVIL_BUSINESS_POLICY_VERSION",
    description: "Business gateway: the policy version stamped on every execution record.",
  },
  {
    name: "ANVIL_BUSINESS_JOURNAL_DIR",
    description:
      "Business gateway: directory for the file-backed execution journal (attempted effects and reconciliation evidence).",
  },
  {
    name: "ANVIL_BUSINESS_APPROVAL_FILE",
    description:
      "Business gateway: path to the reviewed approval record the gateway checks before executing an action.",
  },
];
