# Legacy application estates

Anvil can turn offline Java EE, .NET Framework, messaging, and stored-procedure DDL evidence into
an evidence-backed inventory of possible invocation boundaries. It can then
help a coding harness describe one candidate as a business operation and bind a
human review to that exact proposal.

It does not yet execute the approved binding. Today, the workflow ends with a
reviewed, content-addressed plan whose runtime status is `not_implemented`.

## Choose the right entry point

Start with the source that is authoritative for the system you need to expose:

| What you have | Start here | Why |
| --- | --- | --- |
| OpenAPI, WSDL, proto, GraphQL, OData, Discovery, or Postman contract | `anvil compile` or `anvil agentify` | A declared API contract is stronger than reconstructing one from deployment configuration. |
| An API gateway export | `anvil estate inventory` | Gateway inventory preserves API coordinates, policies, products, and gateway provenance. |
| Application-server, .NET, or broker configuration but no useful API contract | `anvil legacy inventory` | Legacy inventory discovers technical invocation candidates without pretending that configuration proves business meaning. |
| Only a running server and no safe offline export | Export first | The current collectors never connect to a live server, broker, queue, registry, or management plane. |

Do not use legacy inventory merely because the application is old. A maintained
WSDL is still an API contract. A queue declaration, JNDI binding, or WCF endpoint
is a weaker starting point because it says how something might be reached, not
what a caller is permitted to accomplish.

## The artifacts have different jobs

The workflow is easier to reason about when each artifact is read literally:

| Artifact | What it establishes | What it does not establish |
| --- | --- | --- |
| Collection plan | Which sources and evidence dimensions are required, with fail-closed acquisition policy | That Anvil acquired those sources or that the resulting inventory is complete |
| Inventory | Which bytes were inspected and which technical facts were observed | Business intent, permission, or a callable API |
| Candidate | A reconciled invocation coordinate with every supporting and conflicting claim retained | Which conflicting claim is correct |
| Evidence graph | Typed links from artifacts and evidence through observations to candidate lineage | New facts beyond the inventory |
| Coverage and gap plan | Which required evidence dimensions are satisfied, partial, missing, unsupported, or refused | That candidate yield equals semantic completeness |
| Candidate explanation | The observations, claims, unknowns, diagnostics, and artifacts behind one candidate | Approval or a preferred resolution for conflicts |
| Harness proposal | A proposed business operation, schemas, errors, transport plan, and operational semantics | Approval or runtime availability |
| Review receipt | A named reviewer accepted or rejected the exact assessed proposal | That a bridge was deployed or reached production |
| Capability binding | The approved operation and transport plan, bound to inventory, task, proposal, and receipt hashes | Executable Java, Windows, or broker connectivity |

This separation prevents two common errors: treating discovery as authority and
treating approval as deployment.

## The workflow

```text
fail-closed collection plan
  -> provenance-preserving offline exports
  -> content-addressed inventory
  -> conflict-preserving candidates
  -> evidence graph + coverage gaps + candidate explanations
  -> modernization scorecard (counts; never a gate)
  -> one hash-bound harness task
  -> deterministic proposal assessment
  -> separate human approval or rejection
  -> reviewed binding (runtime.status = not_implemented)
  -> future deployment-local bridge
  -> future business-shaped MCP tool
```

At any point after the inventory exists, `anvil legacy scorecard` counts what
the estate contains, what is reviewed, and what blocks the rest; read
[Read a legacy modernization scorecard](legacy-scorecard.md) for what each
section does and does not say.

The harness can investigate source code, tests, schemas, runbooks, and change
records. It cannot remove required decisions from the task, approve its own
proposal, invent a destination, or turn broker acknowledgement into business
completion.

## Where the inventory comes from

A reliable inventory rarely comes from Git alone. Collect the smallest set of
offline exports needed to describe one deployment coordinate:

| Evidence source | Useful facts | Important limitation |
| --- | --- | --- |
| Source repository | Interfaces, serializers, validation, tests, and intended configuration | May not match the deployed revision |
| Artifact repository | Immutable EAR, WAR, JAR, RAR, DLL, or EXE bytes | Does not prove where an artifact is deployed |
| Deployed artifact export | Bytes installed for one application and environment | May omit external bindings |
| Application-server export | JNDI names, activation specs, endpoints, and resource mappings | Management configuration is not a business API |
| Broker export | Destinations, bindings, dead-letter policy, and transport coordinates | Does not prove the effect of a message |
| Runtime observation | Paths and payload shapes exercised in practice | Observed behavior is not the complete authorized contract |
| CMDB or service catalog | Owner, environment, lifecycle, and criticality | Usually lacks wire semantics |
| Runbook or change record | Operational intent and active-version decisions | Must be tied to an immutable revision or digest |

`anvil legacy plan` can describe several source roots and their distinct
contexts before collection. The TypeScript SDK can also attach an authority to
each `LegacySourceMember`; that member-level source overrides the invocation
default and survives into artifact and evidence records.

The filesystem CLI still assigns one `--source-kind`, `--source-id`, and
`--revision` to every member in one inventory run. Do not place unrelated Git,
broker, and production exports in one directory and label the directory as one
authority. Run separate CLI collections, or use the SDK with explicit
per-member sources. A collection plan validates intent and policy; it does not
acquire files, execute management commands, or merge inventories. Refinement is
still bound to one inventory.

## What Anvil understands today

### Java EE and application servers

- `application.xml`, `web.xml`, `ejb-jar.xml`, and `ra.xml`;
- explicit `javax.ejb` and `jakarta.ejb` source annotations for stateless,
  stateful, singleton, remote, local, and message-driven declarations;
- message-driven activation properties, including explicit destination and
  listener-interface declarations;
- resource references, destinations, connection factories, and resource
  adapters;
- WebLogic EJB bindings, JMS modules, deployment-plan modules, and domain JMS
  system resources;
- WebSphere/Liberty JMS destinations, connection factories, activation specs,
  and vendor bindings; and
- JBoss/WildFly EJB bindings, messaging destinations, pooled connection
  factories, and multiple JNDI aliases.

A local-only EJB remains local-only. A public implementation method is not
silently promoted to a remote capability. Simple annotation names count only
with an explicit `javax.ejb` or `jakarta.ejb` import. Java source inspection is
lexical and bounded: it does not compile code, run annotation processors,
resolve a build, or discover method schemas. `.class` members are recorded by
digest with a diagnostic; they are never loaded or executed.

### .NET Framework

- `web.config`, `app.config`, and `*.exe.config`;
- WCF services, endpoints, contracts, addresses, and configured bindings;
- `.svc` `ServiceHost` declarations and
  `serviceHostingEnvironment/serviceActivations`;
- declared base addresses, relative-address resolution, and protocol mappings;
- `netMsmqBinding` and MSMQ-backed endpoint coordinates; and
- explicit IIS or Windows Service deployment metadata supplied as JSON.

Assemblies are hashed but never loaded. The current collector does not
decompile IL or invoke reflection. A convention-only WCF service may receive a
runtime default endpoint, but Anvil does not invent its contract. It reports
`legacy/dotnet/default_endpoint_requires_contract_metadata` until an explicit
endpoint or bounded static contract export supplies that evidence. Conflicting
base addresses, binding settings, and protocol mappings remain ambiguous.

### Messaging

- bounded AsyncAPI JSON and YAML;
- IBM MQ MQSC and CCDT JSON;
- Artemis broker configuration;
- allowlisted RabbitMQ queue, exchange, binding, and topology arguments, even
  when an export also contains administration secrets that are excluded; and
- Kafka Admin topic collections, Schema Registry subjects, Strimzi
  `KafkaTopic`, and Strimzi `KafkaConnector` resources.

The collector never creates a producer or consumer and never samples a queue to
guess a schema.

### Databases (stored procedures)

- PL/SQL `CREATE [OR REPLACE] PACKAGE` specifications and bodies, standalone
  `CREATE [OR REPLACE] PROCEDURE` and `FUNCTION` DDL, including `IN`, `OUT`,
  and `IN OUT` modes, `DEFAULT` markers, `RETURN` types, and `SYS_REFCURSOR`
  OUT parameters;
- T-SQL `CREATE [OR ALTER] PROCEDURE` headers with `@parameter` types,
  `= default` markers, and `OUTPUT` parameters;
- literal transaction facts in a body: `PRAGMA AUTONOMOUS_TRANSACTION`,
  `BEGIN TRANSACTION`, `COMMIT`, and `ROLLBACK`; and
- literal error facts: `RAISE_APPLICATION_ERROR(-20xxx, ...)` codes, `THROW`
  codes, and `RAISERROR` message ids.

Exports are read as inert text with `--`, `/* */`, and string literals stripped
first, so commented-out DDL and dynamic SQL inside a literal are never read as
declarations. The scanner never evaluates SQL, resolves a type, or connects to a
database. When a package specification and body are both present, signatures
come from the specification and the body contributes only evidence and literal
body facts; a body-only subprogram is private and is not a candidate. Overloaded
or divergent signatures for one procedure are retained as a conflict, not
chosen. A member that carries credentials (`IDENTIFIED BY`, `WITH PASSWORD`,
`SECRET =`, inline connection-string passwords) is refused with
`legacy/database/secret_like_value`.

The collector explicitly does not infer:

- idempotency: a procedure that commits is a mutation until a human proves
  otherwise;
- result-set shapes: a T-SQL procedure that selects rows gets no `output_schema`
  claim and `legacy/database/result_set_unproven` instead, because DDL does not
  declare the columns a body returns;
- T-SQL function contracts: a `CREATE FUNCTION` unit is recorded as evidence
  with `legacy/database/tsql_function_unsupported` and projects no candidate; or
- business meaning: `post_entry` is a technical name, not a business operation.

### Content detection and explicit unknowns

In `auto` mode Anvil combines conservative filename checks with bounded content
signatures. This lets an arbitrarily named XML file containing a recognized
WebLogic/JBoss root, a `.java` file containing an EJB annotation, or a WCF file
containing `system.serviceModel` or `ServiceHost` reach the appropriate
collector. Detection is routing, not evidence: the collector must still parse
an explicit supported declaration.

A recognized artifact that produces no supported fact is not treated as a
successful empty result. It emits a stable diagnostic such as:

- `legacy/java-ee/no_discoverable_declaration`;
- `legacy/java-ee/source_annotation_incomplete`;
- `legacy/dotnet/no_discoverable_endpoint`; or
- `legacy/dotnet/default_endpoint_requires_contract_metadata`; and
- `legacy/<collector>/no_invocation_candidate` when useful declarations were
  retained but no callable technical boundary was proved.

These diagnostics are acquisition work. Renaming a file, suppressing a warning,
or asking a harness to guess the missing contract does not improve coverage.

## Reconciliation preserves disagreement

Suppose the same logical destination is mapped twice:

```text
ejb-jar.xml         resource-ref   jms/refundRequests
WebSphere export   binding        jms/refundRequests -> PAY.REFUND.V2
older export       binding        jms/refundRequests -> PAY.REFUND.V1
```

Anvil keeps both physical `binding_target` claims. Evidence ranking helps a
reviewer inspect stronger sources first; it never deletes the lower-ranked
assertion or chooses a convenient winner.

The same rule holds across exports. When production and UAT, several
applications, or the source repository and deployed configuration are merged
with `anvil legacy merge`, the merged snapshot keeps every observation, lets the
same reconciler surface conflicts, and marks each logical capability whose
deployments disagree as `divergent` with an explicit warning. See
[Merge an estate from several exports](legacy-inventory.md#7b-merge-an-estate-from-several-exports).

An MQ object and an AsyncAPI channel also remain separate candidates until
reviewed evidence establishes their relationship. A matching string is a lead,
not proof that two protocols describe the same business capability.

## Business shape is the point

The final agent surface should express the developer's or operator's intent:

```text
refunds.submit
refunds.get_status
```

It should not expose middleware administration as a universal tool:

```text
put_queue_message
consume_queue
invoke_any_ejb
call_any_mbean
```

Generic middleware tools discard the schema, effect, authorization, completion,
and retry constraints that make a capability safe enough to review. They also
give a harness more transport authority than the business operation requires.

## Scaffold a contract from source

Many legacy HTTP estates have handlers but no published contract: a JAX-RS
resource, a Spring MVC controller, a servlet mapped in `web.xml`. `anvil
legacy scaffold <dir>` recovers those endpoints and lowers them into an
OpenAPI 3 draft that `anvil compile` reads like any other specification.

```bash
anvil legacy scaffold src/ --out generated/estate.openapi.json
anvil compile generated/estate.openapi.json --out generated/estate
anvil inspect generated/estate
```

### Java source (JAX-RS, Spring MVC, web.xml)

The Java lane reads `.java` and `web.xml` members as inert text. It understands:

- JAX-RS: class-level and method-level `@Path`, `@GET`/`@POST`/`@PUT`/
  `@DELETE`/`@HEAD`/`@OPTIONS`/`@PATCH`, `@Consumes`/`@Produces` at class and
  method level (the method wins), `@PathParam`/`@QueryParam`/`@HeaderParam`/
  `@CookieParam`/`@FormParam` with `@DefaultValue`, the un-annotated
  non-`@Context` parameter as the request entity, a `@BeanParam` whose class
  is in the same source set, and `@ApplicationPath` on the `Application`
  subclass as the base path. `{id: regex}` templates become `{id}`.
- Spring MVC: `@RestController`/`@Controller` with `@RequestMapping` at class
  and method level, `@GetMapping` and the other shorthands, `consumes`/
  `produces`, `@PathVariable`/`@RequestParam`/`@RequestHeader`/`@CookieValue`
  with `name`, `required` and `defaultValue`, `@RequestBody`, and
  `ResponseEntity<T>` unwrapped to the declared body type. A
  `@RequestMapping` that declares no HTTP method is recorded as an unmapped
  path, one per declared path, never compiled as an operation.
- `web.xml`: every `<servlet-mapping>` `<url-pattern>` as an unmapped path
  with the servlet class as its handler. A JAX-RS container servlet (Jersey,
  RESTEasy, CXF, or an `Application` init-param) supplies the JAX-RS base
  path when no `@ApplicationPath` is declared; a `DispatcherServlet` mapping
  supplies the Spring base path.

Declared types project onto a small JSON Schema subset — `String` to string,
`int`/`long` to integer with `int32`/`int64`, `BigDecimal` to number, `UUID`
to a `uuid` string, `LocalDate` and `Date` to `date`/`date-time`,
`List<T>`/`T[]` to arrays — and every schema records the declared Java type
verbatim as `x-anvil-source-type`. An enum or a plain data class declared in
the same source set is projected from its own declaration; anything else is
an open object. Every operation, parameter and payload carries
`x-anvil-evidence`: the file, 1-based line and construct (`@GET`, `@Path`,
`servlet-mapping`) it was read from. `operationId` is
`<SimpleClassName>.<methodName>`; an overload or a mapping with several
routes takes a `_<n>` suffix by source order, with an info diagnostic.

The boundary is deliberate. The lane is a bounded annotation recognizer, not
a Java compiler: it resolves no imports, loads no classes, and evaluates no
expression. A path written as a constant or a concatenation is reported
(`legacy/scaffold/jaxrs/unresolvable_path_expression`) and skipped; a
`${property}` placeholder is kept verbatim with a warning; a sub-resource
locator's routes are not followed; an annotation whose arguments do not parse
is reported, never guessed. Nothing in the draft carries a description, an
example, or a success semantic the source did not declare, so reads compile
as reads and every mutation lands `review_required`. Scaffolding approves
nothing. The same input always yields the same draft and content hash,
whatever order the members arrive in.

### .NET source (ASP.NET, ASMX)

The `dotnet` lane reads `.cs`, `.asmx` and `.asmx.cs` members. Nothing is
compiled or loaded: comments, string contents and preprocessor lines are
blanked before attributes are scanned, so `// [HttpGet]` in a comment is never a
route, while attribute arguments such as `[Route("api/[controller]")]` are
read at their exact offset.

| Framework | What is read | Path proof |
| --- | --- | --- |
| `aspnet_core` | `[ApiController]`, `[Route]`, `[HttpGet]`…`[HttpOptions]` with optional templates, `[AcceptVerbs]`, `[Consumes]`/`[Produces]`, `[FromRoute]`/`[FromQuery]`/`[FromHeader]`/`[FromBody]`/`[FromForm]` with `Name=` | The attribute templates themselves. `[controller]`/`[action]` expand to the class name minus `Controller` and the method name; `{id:int}` becomes `{id}` with an integer schema; `{id?}` and `{*path}` are recorded with warnings because OpenAPI path parameters are required and single-segment. |
| `aspnet_webapi` | Controllers deriving from `ApiController`: `[RoutePrefix]`/`[Route]`, verb attributes, or the `Get*`/`Post*`/`Put*`/`Delete*` action-name convention | Attribute routes as declared. Convention-routed actions are expanded only against a `routes.MapHttpRoute(…, "api/{controller}/{id}", …)` template found in the same source set; without one they are left unmapped with `route_template_unknown`. No prefix is ever guessed. |
| `asmx` | `[WebService]` classes and their `[WebMethod]`s (`MessageName` honoured) | `POST /<File>.asmx/<Method>` only when the `.asmx` file with a matching `Class=` is present; otherwise unmapped with `activation_file_missing`. |

Binding sources are read from attributes when declared. When a parameter has
none, the ASP.NET Core `[ApiController]` convention is applied — a simple type
matching a route token is a path parameter, other simple types are query
parameters, complex types are the body — and the parameter's evidence says
`construct: "inferred_binding"` so a reviewer can tell convention from
declaration. On a controller that is not an `[ApiController]`, an undeclared
complex-type binding is reported and not recorded.

Declared types are projected, never widened: `int`/`long` → integer,
`decimal`/`double` → number, `Guid` → `uuid`, `DateTime`/`DateTimeOffset` →
`date-time`, `T?` keeps `T` with `x-anvil-source-type: "T?"`, collections →
arrays, `Task<T>`/`ActionResult<T>` unwrap to `T`, an `enum` declared in the
source set contributes its member names, and a DTO class or record declared in
the source set contributes its public property names and types. Anything else
is an open object that records the source type. `operationId` is
`<ControllerClass>.<Method>`; overloads and multi-verb actions are suffixed
(`_1`, `_get`) with an info diagnostic. Diagnostics live under
`legacy/scaffold/aspnet_core/…`, `legacy/scaffold/aspnet_webapi/…` and
`legacy/scaffold/asmx/…`; a route whose template would carry a secret-like
value is refused rather than written into the draft.

See [`examples/legacy-orders-dotnet`](../examples/legacy-orders-dotnet/README.md)
for a fixture that walks `anvil legacy scaffold` → `anvil compile` →
`anvil inspect` across all three frameworks.

## Current product boundary

Inventory, refinement, bridge-contract planning, and static driver-descriptor
assessment are implemented for every transport family. For exactly one
shape — a message binding whose reply mode is `reply_to` or
`fixed_destination` — conformance execution and hosting are implemented too:
`anvil legacy bridge conformance` drives `@anvil/legacy-bridge`'s HTTP
facade against a deterministic broker double, and `anvil legacy bridge
serve` hosts that facade over one STOMP 1.2 connection. `anvil legacy bridge
lower` projects reviewed bindings of every transport family into an OpenAPI
document and manifest that `anvil compile` turns into a bundle, so a reviewed
legacy operation gets the same CLI + MCP + skill triad as every other Anvil
operation — but lowering never enables execution: a binding that has not
passed conformance, or whose shape the queue bridge cannot execute, is held
`blocked`, a `conformance_passed` one still needs `anvil approve` after
inspection, and the runtime executes it only behind a declared protocol
facade pointing at a served, `conformance_passed` binding. Driver code
generation, packaging, deployment, and live readiness are not implemented
for any transport, and every other transport family has neither conformance
execution nor a serve path.

An approved binding always starts with:

```json
{
  "runtime": {
    "placement": "deployment_local_bridge",
    "status": "not_implemented"
  }
}
```

That value is not a placeholder to edit. It is a fail-closed statement that no
tested WebLogic, WebSphere, JBoss, IBM MQ, MSMQ, WCF, JCA, stored-procedure, or
batch adapter is present in this release. The only way it changes is a full
conformance pass, which emits a *new*, re-addressed binding:

```json
{
  "runtime": {
    "placement": "deployment_local_bridge",
    "status": "conformance_passed",
    "conformanceReportHash": "sha256:…"
  }
}
```

`conformanceReportHash` names the exact report that earned the status.
`anvil legacy bridge serve` refuses any binding that is not
`conformance_passed`, any report whose hash the binding does not name, and any
report earned by a different reviewed capability — so hand-editing the status
in still produces nothing that runs. `conformance_passed` is a statement about
the bridge's own code against a double, never that a real broker was reached.

Read [Designing deployment-local bridges](legacy-runtime-bridges.md) for the
runtime contract and the capabilities still required before a binding can
become callable.

## Continue

- [Build a legacy inventory](legacy-inventory.md)
- [Refine and review one candidate](legacy-refinement.md)
- [Read a legacy modernization scorecard](legacy-scorecard.md)
- [Use the legacy TypeScript SDK](legacy-sdk.md)
- [Design a deployment-local bridge](legacy-runtime-bridges.md)
