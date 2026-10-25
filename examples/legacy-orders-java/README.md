# Legacy orders scaffold fixture

A synthetic Java estate with no published API contract: a JAX-RS resource
under `@ApplicationPath("/api")`, a Spring MVC controller, two plain data
classes, one enum, and a `web.xml` that maps a legacy servlet. Nothing here
runs; `anvil legacy scaffold` reads it as text.

Build the repository, then draft the contract:

```bash
node packages/cli/dist/bin-anvil.js legacy scaffold \
  examples/legacy-orders-java \
  --title legacy-orders \
  --out generated/legacy-orders.openapi.json
```

The draft has ten operations and three unmapped paths. The servlet mapping
(`/export/*`, `*.csv`) and the Spring `@RequestMapping("/health")` without a
method declare a path but no HTTP method, so they are recorded under
`x-anvil-scaffold.unmapped` and never compiled as operations. Every operation
carries `x-anvil-evidence`: the file and line each fact was read from.

Compile and inspect the draft like any specification:

```bash
node packages/cli/dist/bin-anvil.js compile \
  generated/legacy-orders.openapi.json \
  --out generated/legacy-orders-bundle

node packages/cli/dist/bin-anvil.js inspect generated/legacy-orders-bundle
```

The `@GET` and `@GetMapping` handlers compile as reads. The `@POST` and
`@PostMapping` handlers (`createOrder`, `cancelOrder`, `create`) are mutations
whose idempotency the source does not prove, so they land `review_required`;
the `DELETE` and `PUT` handlers compile on HTTP method semantics alone. Nothing
is approved by scaffolding; enrich through a manifest and approve only what you
have inspected.

What the lane reads from this fixture:

- `OrderResource.java`: class and method `@Path`, the `{orderId: regex}`
  template lowered to `{orderId}`, `@QueryParam`/`@PathParam`/`@HeaderParam`
  with `@DefaultValue`, class-level `@Produces` and method-level `@Consumes`,
  the un-annotated `Order` parameter as the request entity, and `@Context`
  skipped.
- `Order.java`, `CancelRequest.java`, `OrderStatus.java`: declared fields and
  enum constants projected as properties and `enum` values, because the
  declarations are in the same source set.
- `ShipmentController.java`: `@RequestMapping` composed with `@GetMapping`,
  `@PostMapping`, `@DeleteMapping` and an explicit `method = RequestMethod.PUT`;
  `@RequestParam(required = false)`, `defaultValue`, `Optional<String>`;
  `@RequestBody(required = false)`; `ResponseEntity<Shipment>` unwrapped to the
  declared body type.
- `WEB-INF/web.xml`: the servlet mapping as unmapped paths. Had the descriptor
  mapped a JAX-RS servlet and no `@ApplicationPath` been present, its
  `url-pattern` would have become the JAX-RS base path instead.
