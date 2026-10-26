# Legacy .NET source scaffold fixture

A synthetic .NET estate with **no published contract**: an ASP.NET Core
attribute-routed controller with its DTOs, an ASP.NET Web API 2 controller that
is convention-routed through `App_Start/WebApiConfig.cs`, and an ASMX web
service with its `.asmx` activation file. `anvil legacy scaffold` reads the
C# as inert text (no assembly is loaded, nothing runs) and drafts an OpenAPI
document in which every operation records the source line it was read from.

```text
src/Api/Controllers/OrdersController.cs      [ApiController] [Route("api/[controller]")]
src/Api/Models/OrderModels.cs                enum + DTOs projected into schemas
src/Legacy/Controllers/ProductsController.cs ApiController, Get*/Put*/Delete* convention
src/Legacy/App_Start/WebApiConfig.cs         MapHttpRoute("api/{controller}/{id}")
src/Legacy/Services/OrderArchive.asmx(.cs)   [WebService] + [WebMethod]
```

Build the repository, then draft, compile and inspect:

```bash
node packages/cli/dist/bin-anvil.js legacy scaffold examples/legacy-orders-dotnet/src \
  --title legacy-orders \
  --out generated/legacy-orders.openapi.json

node packages/cli/dist/bin-anvil.js compile generated/legacy-orders.openapi.json \
  --out generated/legacy-orders

node packages/cli/dist/bin-anvil.js inspect generated/legacy-orders
```

What to look for in the draft:

- `/api/Orders/{id}` — `[controller]` expanded to the class name without its
  suffix; `{id:int}` became `{id}` with an `integer` schema; `int id` was bound
  as a path parameter by the `[ApiController]` convention, so its evidence says
  `construct: "inferred_binding"` rather than naming an attribute.
- `POST /api/Orders` — the `CreateOrderRequest` record is projected as the
  request body with its declared property names and types, nothing more.
- `/api/Products/{id}` — the Web API 2 actions have no attributes; their paths
  exist only because `MapHttpRoute` declares `api/{controller}/{id}` in the
  same source set. Delete `WebApiConfig.cs` and rerun: the actions move to
  `x-anvil-scaffold.unmapped` with a `route_template_unknown` diagnostic.
- `POST /OrderArchive.asmx/ReleaseHoldV2` — the path is proven by the `.asmx`
  file's `Class=`; `MessageName` renames the method segment. Delete the
  `.asmx` file and rerun: the web methods are left unmapped.

`anvil inspect` then shows the ordinary posture: declared GETs are reads,
`POST`/`PUT`/`DELETE` land `review_required` or need confirmation, and nothing
is approved. The draft carries no descriptions, examples or success semantics
the source did not declare; supply those through a manifest after review.
