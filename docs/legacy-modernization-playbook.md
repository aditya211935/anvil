# Legacy modernization playbook

This playbook strings Anvil's legacy commands into one path from an estate
you cannot describe with a contract to an agent toolchain whose CLI, MCP
server, and skill all say the same thing about every operation. Each step
produces a content-addressed artifact that the next step verifies. No step
grants authority the previous one did not record.

Read [Legacy application estates](legacy-estates.md) first for what each
artifact establishes and what it does not. This page is the order of
operations.

## The path

```text
1. inventory      anvil legacy inventory       configuration, DDL, JCL → candidates
2. scaffold       anvil legacy scaffold        controller source → OpenAPI draft
3. merge          anvil legacy merge           several exports → one estate inventory
4. scorecard      anvil legacy scorecard       what is known, reviewable, executable
5. gaps           anvil legacy gaps            which evidence is still missing
6. compile        anvil compile                drafts and contracts → bundles
7. refine         anvil legacy refine          one candidate → reviewed binding
8. bridge         anvil legacy bridge          plan, conformance, serve
9. lower          anvil legacy bridge lower    reviewed bindings → bundle
10. approve       anvil approve / package      only after inspection
```

Steps 1 to 5 read evidence. Steps 6 to 10 produce surfaces. Nothing in the
first half can make something callable; nothing in the second half can invent
evidence the first half did not record.

## 1. Inventory every export

Collect each hardened, offline export separately, one coordinate per export:

```bash
anvil legacy inventory exports/prod/refund-service \
  --estate payments --environment prod --application refund-service \
  --source-kind deployed_configuration --revision 2026-10-01 \
  --out inventory/prod.refund-service.json
```

The default collector lane recognizes:

| Evidence | Collector | Candidates |
| --- | --- | --- |
| Java EE descriptors, WebLogic, WebSphere, JBoss bindings, `@Remote`/`@MessageDriven` source | `java-ee` | remote methods, message consumers |
| `web.config`, `.svc`, WCF and MSMQ configuration | `dotnet` | WCF endpoints, MSMQ queues |
| AsyncAPI, IBM MQ MQSC/CCDT, Artemis, RabbitMQ, Kafka exports | `messaging` | destinations and message operations |
| PL/SQL package specs and bodies, T-SQL `CREATE PROCEDURE` | `database` | stored procedures with declared parameters |
| JCL jobs and PROCs | `mainframe` | batch jobs with their step and dataset structure |

Every candidate starts `review_required` or `triage`. A collector records
what the text declares and refuses what it cannot prove; idempotency, result
shapes, and business meaning are never inferred.

## 2. Scaffold a contract where none exists

Most estates have REST endpoints with no OpenAPI: JAX-RS and Spring MVC
controllers, ASP.NET attribute-routed controllers, ASMX services. Scaffold a
draft from the source:

```bash
anvil legacy scaffold src/order-service --title order-service \
  --out drafts/order-service.openapi.json
```

The draft is an exact reading of the route, method, and parameter
declarations. Each operation records the file and line it came from under
`x-anvil-evidence`. A path with no declared method is listed under
`x-anvil-scaffold.unmapped`, never guessed into an operation. Undeclared
payload shapes stay open objects that name the source type.

The draft compiles like any specification, so the ordinary classifier
decides effect and risk from the declared method, and every mutation lands
`review_required`.

## 3. Merge the estate

An estate is several exports: environments, applications, and the Git source
behind them. Merge the inventories into one snapshot so cross-source
disagreement is visible:

```bash
anvil legacy merge inventory/prod.*.json inventory/uat.*.json \
  --estate payments --out inventory/payments.estate.json --check
```

Identical records collapse; different readings of the same logical
capability stay as conflicts for the existing reconciler, and a
`cross_source_disagreement` warning names the dimension. `--check` fails
when any such disagreement exists, which is the right default for CI.

## 4. Read the scorecard

```bash
anvil legacy scorecard inventory/payments.estate.json \
  --bindings bindings/ --format md --out reports/payments.scorecard.md
```

The scorecard is a reading, not a gate. It reports candidates by transport
family, conflicts by dimension, business semantics known versus unknown,
coverage against the collection plan, bindings by runtime status, and which
reviewed bindings have the one shape the queue bridge can conformance-test
today versus which still need a driver family. Its blockers are derived from
the data; it never recommends an approval.

## 5. Close evidence gaps

```bash
anvil legacy gaps inventory/payments.estate.json --plan plans/payments.plan.json
```

A gap plan names the evidence dimension that is missing and the acquisition
mode that would satisfy it. Supply the export and re-run inventory; do not
fill the gap with an assertion.

## 6. Compile drafts and contracts

```bash
anvil compile drafts/order-service.openapi.json --out bundles/order-service
anvil inspect bundles/order-service
anvil lint bundles/order-service
```

Inspect before anything else. A scaffolded bundle exposes nothing until you
approve operations you have read, and `anvil lint` reports the posture.

## 7. Refine one candidate

Refinement turns one inventory candidate into a reviewed business operation
through a hash-bound task, a harness proposal, a deterministic assessment,
and a separate human receipt. Follow
[Legacy refinement](legacy-refinement.md); the result is a
`LegacyCapabilityBinding` whose `runtime.status` is `not_implemented`.

## 8. Plan, conform, serve

```bash
anvil legacy bridge plan bindings/refunds.submit.json
anvil legacy bridge conformance --binding bindings/refunds.submit.json \
  --emit-binding bindings/refunds.submit.conformed.json
anvil legacy bridge serve bindings/refunds.submit.conformed.json
```

Only a message binding with a `reply_to` or `fixed_destination` reply and a
correlation field can earn `conformance_passed`, and only against the
deterministic broker double. Every other family is planned and assessed, not
executed. See [Designing deployment-local bridges](legacy-runtime-bridges.md).

## 9. Lower reviewed bindings into a bundle

```bash
anvil legacy bridge lower bindings/*.json --title payments-legacy \
  --out-spec lowered/payments.openapi.json --out-manifest lowered/payments.anvil.yaml
anvil compile lowered/payments.openapi.json --manifest lowered/payments.anvil.yaml \
  --out bundles/payments-legacy
```

Lowering projects each reviewed binding onto an OpenAPI operation that
carries the reviewed schemas, the queue wire binding derived from the binding
itself, and the binding's content hash. The manifest blocks every operation
whose binding is not `conformance_passed`, so the CLI, the MCP server, and
the skill all show the operation and all refuse it the same way. A
`conformance_passed` operation compiles `review_required`; it executes only
when the runtime is pointed at a served facade with `--protocol-facade`.

## 10. Approve and package

```bash
anvil approve bundles/payments-legacy refunds.submit
anvil package skill bundles/payments-legacy
```

Approve only what you have inspected. Packaging is not deployment; follow the
target guide and the authorization you were given.

## Programmatic use

Every step has a verified SDK entry point under `@anvil/compiler/legacy`
(see [Legacy SDK](legacy-sdk.md)). The scaffold, merge, and scorecard
functions take verified snapshots and return content-addressed results, so a
pipeline can store each artifact and prove the next one was derived from it.
Collectors can be extended for an estate's own evidence formats through the
collector registry described in the SDK guide; the CLI's `--collector` lane
list stays closed to the built-in collectors so no command ever loads code
from the source tree it is inspecting.

## What this playbook does not promise

Inventory, scaffolding, merge, and scorecard read bytes you supplied; they
never connect to a server, broker, database, or scheduler. Lowering produces
a bundle that refuses by default. `conformance_passed` is a statement about
the bridge against a double, not about a real broker. The adapter families
still required before a WebLogic, WebSphere, JBoss, IBM MQ, MSMQ, WCF, JCA,
stored-procedure, or batch operation can execute are listed in
[Designing deployment-local bridges](legacy-runtime-bridges.md).
