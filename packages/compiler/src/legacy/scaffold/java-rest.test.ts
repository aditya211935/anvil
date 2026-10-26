import { describe, expect, it } from "vitest";
import { compile } from "../../compile.js";
import { JAVA_SCAFFOLD_MAX_MEMBER_BYTES, scaffoldJavaRest } from "./java-rest.js";
import type { ScaffoldEndpoint, ScaffoldSourceMember } from "./model.js";
import { emitOpenApiDraft } from "./openapi-draft.js";
import { scaffoldLegacySource } from "./scaffold.js";

function member(path: string, text: string): ScaffoldSourceMember {
  return { path, bytes: new TextEncoder().encode(text) };
}

const ORDER_RESOURCE = member(
  "src/com/acme/OrderResource.java",
  `package com.acme;

import javax.ws.rs.*;
import javax.ws.rs.core.*;

/* @GET inside a comment is not a declaration */
@Path("/orders")
@Produces(MediaType.APPLICATION_JSON)
@Consumes("application/json")
public class OrderResource {
    private static final String NOTE = "@DELETE in a string is not a declaration";

    @GET
    public List<Order> list(
            @QueryParam("status") OrderStatus status,
            @QueryParam("limit") @DefaultValue("50") int limit,
            @HeaderParam("X-Tenant") String tenant,
            @CookieParam("session") String session,
            @Context UriInfo info) {
        return null;
    }

    @GET
    @Path("/{orderId: [0-9a-f-]+}")
    public Order get(@PathParam("orderId") UUID orderId) { return null; }

    @POST
    @Consumes({MediaType.APPLICATION_XML, "text/plain;charset=UTF-8"})
    @Produces("application/problem+json")
    public Response create(Order order) { return null; }

    @PUT
    @Path("{orderId}/address")
    public void address(@PathParam("orderId") UUID orderId,
                        @FormParam("street") String street,
                        @FormParam("postcode") String postcode) {}

    @POST
    @Path("/search")
    public List<Order> search(@BeanParam OrderQuery query) { return null; }

    @Path("/{orderId}/lines")
    public LineResource lines(@PathParam("orderId") UUID orderId) { return null; }
}
`,
);

const SUPPORT_TYPES = member(
  "src/com/acme/Types.java",
  `package com.acme;

public class Order {
    private UUID id;
    private OrderStatus status;
    private java.math.BigDecimal total;
    private String[] tags;
    private java.time.LocalDate placedOn;
    private Address shipping;
    public UUID getId() { return id; }
}

class Address {
    private String street;
    private int number;
}

enum OrderStatus { OPEN, SHIPPED }

class OrderQuery {
    @QueryParam("q") private String text;
    @QueryParam("page") private Integer page;
    private Object ignoredPlainField;
}
`,
);

const SHIPMENT_CONTROLLER = member(
  "src/com/acme/ShipmentController.java",
  `package com.acme;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(value = {"/shipments", "/v2/shipments"}, produces = "application/json")
public class ShipmentController {

    @GetMapping
    public List<Shipment> list(@RequestParam(value = "carrier", required = false) String carrier,
                               @RequestParam(defaultValue = "20") int size,
                               @RequestParam Map<String, String> everything,
                               @RequestHeader("X-Tenant") String tenant) { return null; }

    @GetMapping("/{id:\\\\d+}")
    public ResponseEntity<Shipment> get(@PathVariable long id, @CookieValue("sid") Optional<String> sid) { return null; }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Shipment> create(@RequestBody Shipment shipment) { return null; }

    @RequestMapping(path = "/{id}/label", method = {RequestMethod.PUT, RequestMethod.PATCH})
    public void label(@PathVariable("id") long id, @RequestBody(required = false) byte[] pdf) {}

    @RequestMapping("/health")
    public String health() { return "ok"; }

    @GetMapping("/{id}/events")
    public List<String> get(@PathVariable long id) { return null; }
}

class Shipment {
    private long id;
    private String carrier;
}
`,
);

const WEB_XML = member(
  "WEB-INF/web.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<web-app>
  <servlet>
    <servlet-name>jersey</servlet-name>
    <servlet-class>org.glassfish.jersey.servlet.ServletContainer</servlet-class>
  </servlet>
  <servlet>
    <servlet-name>LegacyServlet</servlet-name>
    <servlet-class>com.acme.LegacyServlet</servlet-class>
  </servlet>
  <servlet-mapping>
    <servlet-name>jersey</servlet-name>
    <url-pattern>/rest/*</url-pattern>
  </servlet-mapping>
  <servlet-mapping>
    <servlet-name>LegacyServlet</servlet-name>
    <url-pattern>/legacy/*</url-pattern>
    <url-pattern>*.do</url-pattern>
  </servlet-mapping>
</web-app>
`,
);

function byId(endpoints: readonly ScaffoldEndpoint[]): Map<string, ScaffoldEndpoint> {
  return new Map(endpoints.map((endpoint) => [endpoint.operationId, endpoint]));
}

describe("scaffoldJavaRest: JAX-RS", () => {
  const result = scaffoldJavaRest([ORDER_RESOURCE, SUPPORT_TYPES]);
  const ops = byId(result.endpoints);

  it("reads class and method paths, every parameter kind, media types and the entity body", () => {
    expect(result.inputMembers).toBe(2);
    expect([...ops.keys()].sort()).toEqual([
      "OrderResource.address",
      "OrderResource.create",
      "OrderResource.get",
      "OrderResource.list",
      "OrderResource.search",
    ]);

    const list = ops.get("OrderResource.list");
    expect(list).toMatchObject({ framework: "jaxrs", method: "get", path: "/orders" });
    expect(list?.parameters).toEqual([
      {
        name: "status",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["OPEN", "SHIPPED"], sourceType: "OrderStatus" },
        evidence: [{ path: ORDER_RESOURCE.path, line: 15, construct: "@QueryParam" }],
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", format: "int32", sourceType: "int" },
        evidence: [{ path: ORDER_RESOURCE.path, line: 16, construct: "@QueryParam" }],
      },
      {
        name: "X-Tenant",
        in: "header",
        required: false,
        schema: { type: "string", sourceType: "String" },
        evidence: [{ path: ORDER_RESOURCE.path, line: 17, construct: "@HeaderParam" }],
      },
      {
        name: "session",
        in: "cookie",
        required: false,
        schema: { type: "string", sourceType: "String" },
        evidence: [{ path: ORDER_RESOURCE.path, line: 18, construct: "@CookieParam" }],
      },
    ]);
    expect(list?.requestBody).toBeUndefined();
    expect(list?.response?.contentTypes).toEqual(["application/json"]);
    expect(list?.response?.schema).toMatchObject({ type: "array", sourceType: "List<Order>" });
    expect(list?.evidence).toEqual([
      { path: ORDER_RESOURCE.path, line: 13, construct: "@GET" },
      { path: ORDER_RESOURCE.path, line: 7, construct: "@Path" },
    ]);

    const get = ops.get("OrderResource.get");
    expect(get?.path).toBe("/orders/{orderId}");
    expect(get?.parameters).toEqual([
      {
        name: "orderId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid", sourceType: "UUID" },
        evidence: [{ path: ORDER_RESOURCE.path, line: 25, construct: "@PathParam" }],
      },
    ]);

    const create = ops.get("OrderResource.create");
    expect(create?.method).toBe("post");
    expect(create?.requestBody).toEqual({
      contentTypes: ["application/xml", "text/plain"],
      schema: {
        type: "object",
        sourceType: "Order",
        properties: {
          id: { type: "string", format: "uuid", sourceType: "UUID" },
          status: { type: "string", enum: ["OPEN", "SHIPPED"], sourceType: "OrderStatus" },
          total: { type: "number", sourceType: "java.math.BigDecimal" },
          tags: {
            type: "array",
            items: { type: "string", sourceType: "String" },
            sourceType: "String[]",
          },
          placedOn: { type: "string", format: "date", sourceType: "java.time.LocalDate" },
          shipping: {
            type: "object",
            sourceType: "Address",
            properties: {
              street: { type: "string", sourceType: "String" },
              number: { type: "integer", format: "int32", sourceType: "int" },
            },
          },
        },
      },
      required: true,
      evidence: [
        { path: ORDER_RESOURCE.path, line: 30, construct: "parameter" },
        { path: ORDER_RESOURCE.path, line: 28, construct: "@Consumes" },
      ],
    });
    // Method-level @Produces wins over the class-level one.
    expect(create?.response).toMatchObject({
      contentTypes: ["application/problem+json"],
      schema: { type: "object", sourceType: "Response" },
    });
  });

  it("lowers @FormParam fields into a form body and expands a declared @BeanParam", () => {
    const address = ops.get("OrderResource.address");
    expect(address?.path).toBe("/orders/{orderId}/address");
    expect(address?.response).toBeUndefined();
    expect(address?.requestBody).toEqual({
      contentTypes: ["application/json"],
      schema: {
        type: "object",
        properties: {
          street: { type: "string", sourceType: "String" },
          postcode: { type: "string", sourceType: "String" },
        },
      },
      required: false,
      evidence: [
        { path: ORDER_RESOURCE.path, line: 35, construct: "@FormParam" },
        { path: ORDER_RESOURCE.path, line: 36, construct: "@FormParam" },
        { path: ORDER_RESOURCE.path, line: 9, construct: "@Consumes" },
      ],
    });

    const search = ops.get("OrderResource.search");
    expect(search?.parameters.map((p) => [p.in, p.name])).toEqual([
      ["query", "q"],
      ["query", "page"],
    ]);
    expect(search?.requestBody).toBeUndefined();
  });

  it("reports a sub-resource locator instead of guessing its routes", () => {
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "info",
        code: "legacy/scaffold/jaxrs/subresource_locator_skipped",
        evidence: { path: ORDER_RESOURCE.path, line: 42, construct: "@Path" },
      }),
    ]);
  });
});

describe("scaffoldJavaRest: Spring MVC", () => {
  const result = scaffoldJavaRest([SHIPMENT_CONTROLLER]);
  const ops = byId(result.endpoints);

  it("composes class and method mappings, one endpoint per declared path and method", () => {
    const routes = result.endpoints.map((e) => `${e.method ?? "-"} ${e.path} ${e.operationId}`);
    expect(routes).toEqual([
      "get /shipments ShipmentController.list",
      "get /v2/shipments ShipmentController.list_2",
      "get /shipments/{id} ShipmentController.get",
      "get /v2/shipments/{id} ShipmentController.get_2",
      "post /shipments ShipmentController.create",
      "post /v2/shipments ShipmentController.create_2",
      "put /shipments/{id}/label ShipmentController.label",
      "patch /shipments/{id}/label ShipmentController.label_2",
      "put /v2/shipments/{id}/label ShipmentController.label_3",
      "patch /v2/shipments/{id}/label ShipmentController.label_4",
      "- /shipments/health ShipmentController.health",
      "- /v2/shipments/health ShipmentController.health_2",
      "get /shipments/{id}/events ShipmentController.get_3",
      "get /v2/shipments/{id}/events ShipmentController.get_4",
    ]);
    expect(
      result.diagnostics.filter((d) => d.code === "legacy/scaffold/spring_mvc/repeated_handler_id"),
    ).toHaveLength(8);
  });

  it("binds Spring parameters with their declared requiredness and the body", () => {
    const list = ops.get("ShipmentController.list");
    expect(list?.parameters).toEqual([
      expect.objectContaining({ name: "carrier", in: "query", required: false }),
      expect.objectContaining({
        name: "size",
        in: "query",
        required: false,
        schema: { type: "integer", format: "int32", sourceType: "int" },
      }),
      expect.objectContaining({ name: "X-Tenant", in: "header", required: true }),
    ]);
    expect(list?.response).toMatchObject({
      contentTypes: ["application/json"],
      schema: { type: "array", sourceType: "List<Shipment>" },
    });

    const get = ops.get("ShipmentController.get");
    expect(get?.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path", required: true }),
      expect.objectContaining({
        name: "sid",
        in: "cookie",
        required: false,
        schema: { type: "string", sourceType: "Optional<String>" },
      }),
    ]);
    expect(get?.response?.schema).toEqual({
      type: "object",
      sourceType: "ResponseEntity<Shipment>",
      properties: {
        id: { type: "integer", format: "int64", sourceType: "long" },
        carrier: { type: "string", sourceType: "String" },
      },
    });

    const create = ops.get("ShipmentController.create");
    expect(create?.requestBody).toMatchObject({
      contentTypes: ["application/json"],
      required: true,
      schema: { type: "object", sourceType: "Shipment" },
    });
    const label = ops.get("ShipmentController.label");
    expect(label?.requestBody).toMatchObject({
      required: false,
      schema: { type: "string", format: "byte", sourceType: "byte[]" },
    });
    expect(label?.response).toBeUndefined();
  });

  it("leaves a @RequestMapping without a method unmapped", () => {
    const draft = emitOpenApiDraft({ title: "shipments", scaffold: result });
    expect(draft.unmapped.map((e) => e.path)).toEqual([
      "/shipments/health",
      "/v2/shipments/health",
    ]);
    expect(Object.keys(draft.document.paths as object)).not.toContain("/shipments/health");
  });
});

describe("scaffoldJavaRest: web.xml", () => {
  it("records servlet mappings as unmapped paths and the JAX-RS servlet as the base path", () => {
    const result = scaffoldJavaRest([ORDER_RESOURCE, SUPPORT_TYPES, WEB_XML]);
    expect(result.inputMembers).toBe(3);
    const servlets = result.endpoints.filter((e) => e.framework === "servlet");
    expect(servlets).toEqual([
      {
        framework: "servlet",
        path: "/legacy/*",
        operationId: "LegacyServlet",
        handler: { type: "com.acme.LegacyServlet", member: "service" },
        parameters: [],
        evidence: [{ path: "WEB-INF/web.xml", line: 17, construct: "servlet-mapping" }],
      },
      {
        framework: "servlet",
        path: "*.do",
        operationId: "LegacyServlet_2",
        handler: { type: "com.acme.LegacyServlet", member: "service" },
        parameters: [],
        evidence: [{ path: "WEB-INF/web.xml", line: 18, construct: "servlet-mapping" }],
      },
    ]);
    const paths = result.endpoints.filter((e) => e.framework === "jaxrs").map((e) => e.path);
    expect(paths).toEqual([
      "/rest/orders",
      "/rest/orders/{orderId}",
      "/rest/orders",
      "/rest/orders/{orderId}/address",
      "/rest/orders/search",
    ]);
    expect(byId(result.endpoints).get("OrderResource.list")?.evidence).toContainEqual({
      path: "WEB-INF/web.xml",
      line: 13,
      construct: "servlet-mapping",
    });
  });

  it("prefers a declared @ApplicationPath over the web.xml servlet mapping", () => {
    const application = member(
      "src/com/acme/App.java",
      `package com.acme;
import javax.ws.rs.ApplicationPath;
import javax.ws.rs.core.Application;
@ApplicationPath("/api/")
public class App extends Application {}
`,
    );
    const result = scaffoldJavaRest([WEB_XML, ORDER_RESOURCE, SUPPORT_TYPES, application]);
    const list = byId(result.endpoints).get("OrderResource.list");
    expect(list?.path).toBe("/api/orders");
    expect(list?.evidence).toContainEqual({
      path: "src/com/acme/App.java",
      line: 4,
      construct: "@ApplicationPath",
    });
  });

  it("degrades a malformed descriptor to a diagnostic", () => {
    const result = scaffoldJavaRest([member("WEB-INF/web.xml", "<web-app><servlet>")]);
    expect(result.endpoints).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "legacy/scaffold/servlet/malformed_descriptor",
    ]);
  });
});

describe("scaffoldJavaRest: determinism and round trip", () => {
  const members = [ORDER_RESOURCE, SUPPORT_TYPES, SHIPMENT_CONTROLLER, WEB_XML];

  it("produces an identical draft for the same input and for a shuffled member order", () => {
    const first = emitOpenApiDraft({ title: "orders", scaffold: scaffoldJavaRest(members) });
    const second = emitOpenApiDraft({ title: "orders", scaffold: scaffoldJavaRest(members) });
    const shuffled = emitOpenApiDraft({
      title: "orders",
      scaffold: scaffoldJavaRest([WEB_XML, SHIPMENT_CONTROLLER, SUPPORT_TYPES, ORDER_RESOURCE]),
    });
    expect(first.contentHash).toBe(second.contentHash);
    expect(JSON.stringify(first.document)).toBe(JSON.stringify(shuffled.document));
  });

  it("compiles through the ordinary pipeline with reads read and mutations gated", async () => {
    const { draft } = scaffoldLegacySource({ title: "orders", members });
    expect(draft.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    const air = await compile({ spec: JSON.stringify(draft.document) });
    const ops = new Map(air.operations.map((op) => [op.sourceRef.operationId, op]));
    expect(ops.get("OrderResource.list")?.effect.kind).toBe("read");
    expect(ops.get("OrderResource.get")?.effect.kind).toBe("read");
    expect(ops.get("ShipmentController.get")?.effect.kind).toBe("read");
    const create = ops.get("OrderResource.create");
    expect(create?.effect.kind).not.toBe("read");
    expect(create?.state).not.toBe("approved");
    expect(ops.get("ShipmentController.create")?.state).not.toBe("approved");
    expect(ops.has("ShipmentController.health")).toBe(false);
  });
});

describe("scaffoldJavaRest: hostile and degenerate input", () => {
  it("ignores annotations in comments and strings, and empty files", () => {
    const result = scaffoldJavaRest([
      member(
        "src/Commented.java",
        `/* @Path("/ghost") @GET */
// @POST
public class Commented {
    String s = "@Path(\\"/also-ghost\\")";
    /** @DELETE */
    public void nothing() {}
}
`,
      ),
      member("src/Empty.java", ""),
    ]);
    expect(result.endpoints).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.inputMembers).toBe(2);
  });

  it("never throws on unbalanced parentheses or braces", () => {
    const result = scaffoldJavaRest([
      member(
        "src/Broken.java",
        `@Path("/broken"
public class Broken {
    @GET public String get( { return "x"; }
`,
      ),
      member("src/Open.java", '@Path("/open") public class Open { @GET public String get() {'),
    ]);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "legacy/scaffold/java/unparseable_annotation_arguments",
    );
    expect(result.endpoints.map((e) => e.path)).toEqual(["/open"]);
  });

  it("skips bytes that are not UTF-8 and members over the size bound, saying so", () => {
    const result = scaffoldJavaRest([
      { path: "src/Latin1.java", bytes: new Uint8Array([0x40, 0x50, 0xe9, 0xff, 0xfe]) },
      { path: "src/Huge.java", bytes: new Uint8Array(JAVA_SCAFFOLD_MAX_MEMBER_BYTES + 1) },
    ]);
    expect(result.inputMembers).toBe(0);
    expect(result.diagnostics.map((d) => [d.code, d.evidence?.path])).toEqual([
      ["legacy/scaffold/java/member_too_large", "src/Huge.java"],
      ["legacy/scaffold/java/member_not_utf8", "src/Latin1.java"],
    ]);
  });

  it("keeps property placeholders verbatim with a warning and refuses to resolve constants", () => {
    const result = scaffoldJavaRest([
      member(
        "src/Placeholders.java",
        `@RestController
@RequestMapping("\${app.base}/items")
public class Placeholders {
    @GetMapping(Routes.LIST) public String list() { return ""; }
    @GetMapping("/{id}") public String get(@PathVariable String id) { return ""; }
}
`,
      ),
    ]);
    expect(result.endpoints.map((e) => e.path)).toEqual(["/${app.base}/items/{id}"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "legacy/scaffold/spring_mvc/unresolved_property_placeholder",
      "legacy/scaffold/spring_mvc/unresolvable_path_expression",
    ]);
    const draft = emitOpenApiDraft({ title: "items", scaffold: result });
    const paths = draft.document.paths as Record<string, Record<string, { parameters: unknown[] }>>;
    expect(paths["/${app.base}/items/{id}"]?.get?.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path" }),
    ]);
  });

  it("suffixes overloaded handlers by source order and says so", () => {
    const result = scaffoldJavaRest([
      member(
        "src/Dup.java",
        `@Path("/dup") public class Dup {
    @GET public String get() { return ""; }
    @GET @Path("/{id}") public String get(@PathParam("id") String id) { return ""; }
    @GET @Path("/{id}/x") public String get(@PathParam("id") String id, @QueryParam("x") int x) { return ""; }
}
`,
      ),
    ]);
    expect(result.endpoints.map((e) => e.operationId)).toEqual([
      "Dup.get",
      "Dup.get_2",
      "Dup.get_3",
    ]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "legacy/scaffold/jaxrs/repeated_handler_id",
      "legacy/scaffold/jaxrs/repeated_handler_id",
    ]);
  });

  it("does not read a resource without a root @Path or a foreign @GET", () => {
    const result = scaffoldJavaRest([
      member(
        "src/Sub.java",
        `public class Sub {
    @GET public String get() { return ""; }
    @com.acme.GET public String other() { return ""; }
}
`,
      ),
    ]);
    expect(result.endpoints).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "legacy/scaffold/jaxrs/subresource_without_root_path",
    ]);
  });
});
