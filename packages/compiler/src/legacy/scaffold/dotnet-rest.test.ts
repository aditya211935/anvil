import { describe, expect, it } from "vitest";
import { compile } from "../../compile.js";
import { scaffoldDotnetRest } from "./dotnet-rest.js";
import type { ScaffoldEndpoint, ScaffoldSourceMember } from "./model.js";
import { emitOpenApiDraft } from "./openapi-draft.js";
import { scaffoldLegacySource } from "./scaffold.js";

const encoder = new TextEncoder();

function member(path: string, text: string): ScaffoldSourceMember {
  return { path, bytes: encoder.encode(text) };
}

/** 1-based line of the first occurrence of `needle` in a member's text. */
function lineOf(source: ScaffoldSourceMember, needle: string): number {
  const text = new TextDecoder().decode(source.bytes);
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`fixture has no '${needle}'`);
  return text.slice(0, index).split("\n").length;
}

const ORDERS = "Api/Controllers/OrdersController.cs";

const ORDERS_CONTROLLER = member(
  "Api/Controllers/OrdersController.cs",
  `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace Acme.Orders.Api
{
    public enum OrderStatus { Pending, Shipped, Cancelled }

    public record CreateOrderRequest(string CustomerId, decimal Amount);

    public class OrderDto
    {
        public Guid Id { get; set; }
        public OrderStatus Status { get; set; }
        public List<string> Tags { get; set; } = new();
        private int Internal { get; set; }
    }

    // [HttpGet("commented-out")] is a comment, not a route.
    /* [Route("api/also-commented")] */
    [ApiController]
    [Route("api/[controller]")]
    [Produces("application/json")]
    public class OrdersController : ControllerBase
    {
        private const string Note = "[HttpDelete(\\"from-a-string\\")]";

        [HttpGet("{id:int}")]
        public ActionResult<OrderDto> GetOrder(
            int id,
            [FromQuery(Name = "expand")] bool? expandItems,
            [FromHeader(Name = "X-Tenant")] string tenant) => Ok(new OrderDto());

        [HttpGet]
        public async Task<IEnumerable<OrderDto>> List([FromQuery] OrderStatus? status, int page = 1)
        {
            return await Task.FromResult(new List<OrderDto>());
        }

        [HttpPost]
        [Consumes("application/json")]
        public IActionResult Create(CreateOrderRequest request) { return Ok(); }

        [HttpPut("{id:guid}/notes/{noteId?}")]
        public IActionResult Note([FromRoute] Guid id, string noteId, [FromBody] string text) { return Ok(); }

        [HttpPost("{id}/attachments")]
        public IActionResult Upload(int id, [FromForm] string label, IFormFile file) { return Ok(); }

        [HttpGet("files/{*path}")]
        public IActionResult Download(string path) { return Ok(); }

        [Route("search")]
        [AcceptVerbs("GET", "POST")]
        public IActionResult Search([FromQuery] string q) { return Ok(); }

        [HttpDelete("{id}")]
        public IActionResult Delete(int id) { return NoContent(); }

        [HttpDelete("{id}/items/{itemId}")]
        public IActionResult Delete(int id, int itemId) { return NoContent(); }

        [NonAction]
        public void Helper() { }

        private IActionResult Hidden() => Ok();
    }
}
`,
);

type Paths = Record<string, Record<string, Record<string, unknown>>>;

function draftOf(members: ScaffoldSourceMember[]) {
  const result = scaffoldDotnetRest(members);
  const draft = emitOpenApiDraft({ title: "t", scaffold: result });
  return { result, draft, paths: draft.document.paths as Paths };
}

function byId(result: { endpoints: ScaffoldEndpoint[] }, id: string): ScaffoldEndpoint {
  const endpoint = result.endpoints.find((candidate) => candidate.operationId === id);
  if (!endpoint)
    throw new Error(
      `no endpoint ${id}; have ${result.endpoints.map((e) => e.operationId).join(", ")}`,
    );
  return endpoint;
}

describe("scaffoldDotnetRest: ASP.NET Core attribute routing", () => {
  const { result, draft, paths } = draftOf([ORDERS_CONTROLLER]);

  it("reads every attribute route under the expanded [controller] token and nothing from comments or strings", () => {
    expect(result.inputMembers).toBe(1);
    expect(Object.keys(paths).sort()).toEqual([
      "/api/Orders",
      "/api/Orders/files/{path}",
      "/api/Orders/search",
      "/api/Orders/{id}",
      "/api/Orders/{id}/attachments",
      "/api/Orders/{id}/items/{itemId}",
      "/api/Orders/{id}/notes/{noteId}",
    ]);
    expect(JSON.stringify(draft.document)).not.toContain("commented");
    expect(JSON.stringify(draft.document)).not.toContain("from-a-string");
    expect(result.endpoints.map((e) => e.operationId)).not.toContain("OrdersController.Helper");
    expect(result.endpoints.map((e) => e.operationId)).not.toContain("OrdersController.Hidden");
    for (const endpoint of result.endpoints) expect(endpoint.framework).toBe("aspnet_core");
  });

  it("binds route constraints, From* attributes with Name=, and inferred bindings with evidence", () => {
    const get = byId(result, "OrdersController.GetOrder");
    expect(get.method).toBe("get");
    expect(get.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer", format: "int32", sourceType: "int" },
        evidence: [
          {
            path: ORDERS,
            line: lineOf(ORDERS_CONTROLLER, "int id,"),
            construct: "inferred_binding",
          },
        ],
      },
      {
        name: "expand",
        in: "query",
        required: false,
        schema: { type: "boolean", sourceType: "bool?" },
        evidence: [
          {
            path: ORDERS,
            line: lineOf(ORDERS_CONTROLLER, '[FromQuery(Name = "expand")]'),
            construct: "[FromQuery]",
          },
        ],
      },
      {
        name: "X-Tenant",
        in: "header",
        required: false,
        schema: { type: "string", sourceType: "string" },
        evidence: [
          {
            path: ORDERS,
            line: lineOf(ORDERS_CONTROLLER, "[FromHeader("),
            construct: "[FromHeader]",
          },
        ],
      },
    ]);
    expect(get.evidence).toEqual([
      {
        path: ORDERS,
        line: lineOf(ORDERS_CONTROLLER, '[Route("api/[controller]")]'),
        construct: "[Route]",
      },
      {
        path: ORDERS,
        line: lineOf(ORDERS_CONTROLLER, '[HttpGet("{id:int}")]'),
        construct: "[HttpGet]",
      },
    ]);
    // ActionResult<OrderDto> unwraps to the DTO declared in the same source set.
    expect(get.response).toEqual({
      contentTypes: ["application/json"],
      required: false,
      schema: {
        type: "object",
        sourceType: "OrderDto",
        properties: {
          Id: { type: "string", format: "uuid", sourceType: "Guid" },
          Status: {
            type: "string",
            enum: ["Pending", "Shipped", "Cancelled"],
            sourceType: "OrderStatus",
          },
          Tags: {
            type: "array",
            items: { type: "string", sourceType: "string" },
            sourceType: "List<string>",
          },
        },
      },
      evidence: [
        { path: ORDERS, line: lineOf(ORDERS_CONTROLLER, "GetOrder("), construct: "return_type" },
      ],
    });

    const list = byId(result, "OrdersController.List");
    expect(
      list.parameters.map((p) => [p.name, p.in, p.required, p.schema.type, p.schema.enum]),
    ).toEqual([
      ["status", "query", false, "string", ["Pending", "Shipped", "Cancelled"]],
      ["page", "query", false, "integer", undefined],
    ]);
    expect(list.response?.schema).toEqual({
      type: "array",
      items: expect.objectContaining({ type: "object", sourceType: "OrderDto" }),
      sourceType: "IEnumerable<OrderDto>",
    });
  });

  it("infers a complex-type body under the [ApiController] convention and labels it as inferred", () => {
    const create = byId(result, "OrdersController.Create");
    expect(create.method).toBe("post");
    expect(create.parameters).toEqual([]);
    expect(create.requestBody).toEqual({
      contentTypes: ["application/json"],
      required: true,
      schema: {
        type: "object",
        sourceType: "CreateOrderRequest",
        properties: {
          CustomerId: { type: "string", sourceType: "string" },
          Amount: { type: "number", sourceType: "decimal" },
        },
      },
      evidence: [
        {
          path: ORDERS,
          line: lineOf(ORDERS_CONTROLLER, "CreateOrderRequest request"),
          construct: "inferred_binding",
        },
      ],
    });
    expect(create.response).toBeUndefined();
  });

  it("records optional and catch-all route parameters with warnings instead of inventing semantics", () => {
    const note = byId(result, "OrdersController.Note");
    expect(note.path).toBe("/api/Orders/{id}/notes/{noteId}");
    expect(note.parameters.map((p) => [p.name, p.in, p.required, p.schema.format])).toEqual([
      ["id", "path", true, "uuid"],
      ["noteId", "path", false, undefined],
    ]);
    expect(note.requestBody?.schema).toEqual({ type: "string", sourceType: "string" });
    const download = byId(result, "OrdersController.Download");
    expect(download.path).toBe("/api/Orders/files/{path}");
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("legacy/scaffold/aspnet_core/optional_path_parameter");
    expect(codes).toContain("legacy/scaffold/aspnet_core/catch_all_parameter");
    // The emitter still requires every path parameter.
    expect(paths["/api/Orders/{id}/notes/{noteId}"]?.put?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "noteId", in: "path", required: true }),
      ]),
    );
  });

  it("projects [FromForm] fields and IFormFile into one multipart body", () => {
    const upload = byId(result, "OrdersController.Upload");
    expect(upload.parameters.map((p) => p.name)).toEqual(["id"]);
    expect(upload.requestBody).toEqual({
      contentTypes: ["multipart/form-data"],
      required: true,
      schema: {
        type: "object",
        properties: {
          label: { type: "string", sourceType: "string" },
          file: { type: "string", format: "binary", sourceType: "IFormFile" },
        },
      },
      evidence: [
        {
          path: ORDERS,
          line: lineOf(ORDERS_CONTROLLER, "[FromForm] string label"),
          construct: "[FromForm]",
        },
        {
          path: ORDERS,
          line: lineOf(ORDERS_CONTROLLER, "[FromForm] string label"),
          construct: "inferred_binding",
        },
      ],
    });
  });

  it("disambiguates overloads by source order and multi-verb actions by method", () => {
    const ids = result.endpoints.map((e) => e.operationId).sort();
    expect(ids).toContain("OrdersController.Delete_1");
    expect(ids).toContain("OrdersController.Delete_2");
    expect(ids).toContain("OrdersController.Search_get");
    expect(ids).toContain("OrdersController.Search_post");
    expect(byId(result, "OrdersController.Delete_1").path).toBe("/api/Orders/{id}");
    expect(byId(result, "OrdersController.Delete_2").path).toBe("/api/Orders/{id}/items/{itemId}");
    expect(
      result.diagnostics.filter(
        (d) => d.code === "legacy/scaffold/aspnet_core/operation_id_disambiguated",
      ),
    ).toHaveLength(2);
    expect(draft.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });
});

const WEBAPI_CONTROLLER = member(
  "Legacy/Controllers/ProductsController.cs",
  `using System.Web.Http;

namespace Legacy.Catalog
{
    public class ProductsController : ApiController
    {
        public IEnumerable<string> GetAllProducts() { return new string[0]; }
        public IHttpActionResult GetProduct(int id) { return Ok(); }
        public void PostProduct([FromBody] string value) { }
        public void DeleteProduct(int id) { }
        public void Reindex() { }
    }
}
`,
);

const WEBAPI_CONFIG = member(
  "Legacy/App_Start/WebApiConfig.cs",
  `using System.Web.Http;

namespace Legacy
{
    public static class WebApiConfig
    {
        public static void Register(HttpConfiguration config)
        {
            config.MapHttpAttributeRoutes();
            config.Routes.MapHttpRoute(
                name: "DefaultApi",
                routeTemplate: "api/{controller}/{id}",
                defaults: new { id = RouteParameter.Optional }
            );
        }
    }
}
`,
);

describe("scaffoldDotnetRest: ASP.NET Web API 2 convention routing", () => {
  it("expands convention routes only against a MapHttpRoute template found in the source set", () => {
    const { result, paths } = draftOf([WEBAPI_CONTROLLER, WEBAPI_CONFIG]);
    expect(result.inputMembers).toBe(2);
    expect(Object.keys(paths).sort()).toEqual(["/api/Products", "/api/Products/{id}"]);
    expect(paths["/api/Products"]).toHaveProperty("get");
    expect(paths["/api/Products"]).toHaveProperty("post");
    expect(paths["/api/Products/{id}"]).toHaveProperty("get");
    expect(paths["/api/Products/{id}"]).toHaveProperty("delete");
    for (const endpoint of result.endpoints) expect(endpoint.framework).toBe("aspnet_webapi");
    const get = byId(result, "ProductsController.GetProduct");
    expect(get.evidence).toEqual([
      {
        path: "Legacy/App_Start/WebApiConfig.cs",
        line: lineOf(WEBAPI_CONFIG, "MapHttpRoute("),
        construct: "MapHttpRoute",
      },
      {
        path: "Legacy/Controllers/ProductsController.cs",
        line: lineOf(WEBAPI_CONTROLLER, "GetProduct("),
        construct: "action_name_prefix",
      },
    ]);
    expect(get.parameters).toEqual([
      expect.objectContaining({
        name: "id",
        in: "path",
        schema: { type: "integer", format: "int32", sourceType: "int" },
      }),
    ]);
    expect(get.response).toBeUndefined();
    const post = byId(result, "ProductsController.PostProduct");
    expect(post.requestBody?.schema).toEqual({ type: "string", sourceType: "string" });
    expect(post.requestBody?.contentTypes).toEqual([]);
    // No verb attribute and no verb prefix: Web API's POST default is not asserted.
    const reindex = byId(result, "ProductsController.Reindex");
    expect(reindex.method).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "legacy/scaffold/aspnet_webapi/verb_not_declared",
    );
  });

  it("leaves convention-routed actions unmapped when no route template is in the source set", () => {
    const { result, draft, paths } = draftOf([WEBAPI_CONTROLLER]);
    expect(Object.keys(paths)).toEqual([]);
    expect(draft.unmapped.length).toBeGreaterThanOrEqual(4);
    for (const endpoint of result.endpoints) {
      expect(endpoint.method).toBeUndefined();
      expect(endpoint.path).toBe("~/{controller}/{action}");
    }
    const unknown = result.diagnostics.filter(
      (d) => d.code === "legacy/scaffold/aspnet_webapi/route_template_unknown",
    );
    expect(unknown.length).toBeGreaterThanOrEqual(4);
    expect(unknown[0]?.message).toMatch(/MapHttpRoute/);
  });

  it("reads Web API 2 attribute routes with RoutePrefix", () => {
    const { result, paths } = draftOf([
      member(
        "Shipping/ShipmentsController.cs",
        `using System.Web.Http;
[RoutePrefix("api/shipments")]
public class ShipmentsController : ApiController
{
    [Route("{id:long}/track")]
    [HttpGet]
    public IHttpActionResult Track(long id, [FromUri] bool verbose) { return Ok(); }

    [Route("")]
    public IHttpActionResult PostShipment([FromBody] Shipment shipment) { return Ok(); }
}
`,
      ),
    ]);
    expect(Object.keys(paths).sort()).toEqual(["/api/shipments", "/api/shipments/{id}/track"]);
    const track = byId(result, "ShipmentsController.Track");
    expect(track.framework).toBe("aspnet_webapi");
    expect(track.parameters.map((p) => [p.name, p.in, p.schema.format])).toEqual([
      ["id", "path", "int64"],
      ["verbose", "query", undefined],
    ]);
    expect(byId(result, "ShipmentsController.PostShipment").method).toBe("post");
    expect(byId(result, "ShipmentsController.PostShipment").requestBody?.schema).toEqual({
      type: "object",
      sourceType: "Shipment",
    });
  });
});

const ASMX_CODE_BEHIND = member(
  "Services/OrderService.asmx.cs",
  `using System.Web.Services;

namespace Legacy.Soap
{
    [WebService(Namespace = "http://legacy.example/orders")]
    public class OrderService : WebService
    {
        [WebMethod]
        public OrderRecord GetOrder(int orderId) { return null; }

        [WebMethod(MessageName = "SubmitOrderV2")]
        public bool SubmitOrder(string customerId, decimal amount) { return true; }

        public void NotExposed() { }
    }

    public class OrderRecord { public int Id { get; set; } public string Status { get; set; } }
}
`,
);

const ASMX_FILE = member(
  "Services/OrderService.asmx",
  `<%@ WebService Language="C#" CodeBehind="OrderService.asmx.cs" Class="Legacy.Soap.OrderService" %>\n`,
);

describe("scaffoldDotnetRest: ASMX", () => {
  it("maps [WebMethod]s to POST /<File>.asmx/<Method> only when the .asmx file proves the path", () => {
    const { result, paths } = draftOf([ASMX_CODE_BEHIND, ASMX_FILE]);
    expect(result.inputMembers).toBe(2);
    expect(Object.keys(paths).sort()).toEqual([
      "/OrderService.asmx/GetOrder",
      "/OrderService.asmx/SubmitOrderV2",
    ]);
    const get = byId(result, "OrderService.GetOrder");
    expect(get.framework).toBe("asmx");
    expect(get.method).toBe("post");
    expect(get.requestBody).toEqual({
      contentTypes: [],
      required: true,
      schema: {
        type: "object",
        properties: { orderId: { type: "integer", format: "int32", sourceType: "int" } },
        required: ["orderId"],
      },
      evidence: [
        {
          path: "Services/OrderService.asmx.cs",
          line: lineOf(ASMX_CODE_BEHIND, "[WebMethod]"),
          construct: "[WebMethod]",
        },
      ],
    });
    expect(get.response?.schema).toEqual({
      type: "object",
      sourceType: "OrderRecord",
      properties: {
        Id: { type: "integer", format: "int32", sourceType: "int" },
        Status: { type: "string", sourceType: "string" },
      },
    });
    expect(get.evidence).toEqual([
      {
        path: "Services/OrderService.asmx.cs",
        line: lineOf(ASMX_CODE_BEHIND, "[WebService("),
        construct: "[WebService]",
      },
      {
        path: "Services/OrderService.asmx.cs",
        line: lineOf(ASMX_CODE_BEHIND, "[WebMethod]"),
        construct: "[WebMethod]",
      },
      { path: "Services/OrderService.asmx", line: 1, construct: "WebService directive" },
    ]);
    expect(result.endpoints.map((e) => e.operationId)).not.toContain("OrderService.NotExposed");
  });

  it("leaves web methods unmapped with a diagnostic when the .asmx file is absent", () => {
    const { result, draft, paths } = draftOf([ASMX_CODE_BEHIND]);
    expect(Object.keys(paths)).toEqual([]);
    expect(draft.unmapped.map((e) => e.path).sort()).toEqual([
      "~/{service}.asmx/GetOrder",
      "~/{service}.asmx/SubmitOrderV2",
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "legacy/scaffold/asmx/activation_file_missing",
        evidence: {
          path: "Services/OrderService.asmx.cs",
          line: lineOf(ASMX_CODE_BEHIND, "class OrderService"),
          construct: "[WebService]",
        },
      }),
    ]);
  });
});

describe("scaffoldDotnetRest: determinism and round trip", () => {
  const members = [
    ORDERS_CONTROLLER,
    WEBAPI_CONTROLLER,
    WEBAPI_CONFIG,
    ASMX_CODE_BEHIND,
    ASMX_FILE,
  ];

  it("emits an identical draft regardless of member order", () => {
    const forward = scaffoldLegacySource({ title: "estate", lane: "dotnet", members });
    const shuffled = scaffoldLegacySource({
      title: "estate",
      lane: "dotnet",
      members: [members[3]!, members[0]!, members[4]!, members[2]!, members[1]!],
    });
    expect(shuffled.draft.contentHash).toBe(forward.draft.contentHash);
    expect(JSON.stringify(shuffled.draft.document)).toBe(JSON.stringify(forward.draft.document));
    expect(forward.lanes).toEqual([
      { lane: "dotnet", result: expect.objectContaining({ inputMembers: 5 }) },
    ]);
  });

  it("compiles through the ordinary pipeline: declared reads are reads, mutations are not approved", async () => {
    const { draft } = scaffoldLegacySource({ title: "estate", lane: "dotnet", members });
    expect(draft.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    const air = await compile({ spec: JSON.stringify(draft.document) });
    const byOperation = new Map(air.operations.map((op) => [op.sourceRef.operationId, op]));
    expect(byOperation.get("OrdersController.GetOrder")?.effect.kind).toBe("read");
    expect(byOperation.get("ProductsController.GetProduct")?.effect.kind).toBe("read");
    for (const id of [
      "OrdersController.Create",
      "OrderService.SubmitOrder",
      "ProductsController.PostProduct",
    ]) {
      const operation = byOperation.get(id);
      expect(operation, id).toBeDefined();
      expect(operation?.effect.kind, id).not.toBe("read");
      expect(operation?.state, id).not.toBe("approved");
    }
  });
});

describe("scaffoldDotnetRest: hostile and degenerate input", () => {
  it("ignores attributes inside comments and strings and survives unbalanced brackets", () => {
    const { result, draft } = draftOf([
      member(
        "Hostile.cs",
        `// [HttpGet("comment")]
/* [Route("block")] [HttpPost("block")] */
public class HostileController : ControllerBase
{
    string s = "[HttpDelete(\\"str\\")]"; string v = @"[HttpPut(""verbatim"")]";
    [HttpGet("ok/{id:int")]
    public IActionResult Broken(int id { return Ok(); }
    [HttpGet("fine")]
    public IActionResult Fine() => Ok();
`,
      ),
      member("Empty.cs", ""),
      { path: "Binary.cs", bytes: new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28]) },
    ]);
    const paths = Object.keys(draft.document.paths as Paths);
    for (const path of paths) {
      expect(path).not.toMatch(/comment|block|str|verbatim/);
    }
    expect(result.inputMembers).toBe(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy/scaffold/dotnet/non_utf8_member", level: "warning" }),
    );
    expect(result.endpoints.every((e) => e.framework === "aspnet_core")).toBe(true);
  });

  it("refuses a route template that would carry a secret-like value into the draft", () => {
    const { result, paths } = draftOf([
      member(
        "Leaky.cs",
        `[ApiController]
public class LeakyController : ControllerBase
{
    [HttpGet("admin/token=abcd1234efgh")]
    public IActionResult Admin() => Ok();
    [HttpGet("safe")]
    public IActionResult Safe() => Ok();
}
`,
      ),
    ]);
    expect(Object.keys(paths)).toEqual(["/safe"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "legacy/scaffold/aspnet_core/secret_like_value_refused",
        level: "error",
      }),
    );
  });

  it("reports conventional routing on ASP.NET Core controllers without a route template rather than guessing", () => {
    const { result, draft } = draftOf([
      member(
        "Home.cs",
        `public class HomeController : Controller
{
    [HttpGet]
    public IActionResult Index(OrderFilter filter) => View();
}
`,
      ),
    ]);
    expect(Object.keys(draft.document.paths as Paths)).toEqual([]);
    expect(draft.unmapped).toHaveLength(1);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "legacy/scaffold/aspnet_core/route_template_unknown",
    ]);
    expect(result.endpoints[0]?.path).toBe("~/{controller}/{action}");
  });

  it("is a no-op on an empty member list", () => {
    expect(scaffoldDotnetRest([])).toEqual({ endpoints: [], diagnostics: [], inputMembers: 0 });
  });
});
