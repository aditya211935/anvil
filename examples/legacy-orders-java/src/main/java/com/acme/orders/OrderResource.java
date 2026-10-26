package com.acme.orders;

import java.util.List;
import java.util.UUID;
import javax.ws.rs.Consumes;
import javax.ws.rs.DELETE;
import javax.ws.rs.DefaultValue;
import javax.ws.rs.GET;
import javax.ws.rs.HeaderParam;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.Context;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;
import javax.ws.rs.core.UriInfo;

/**
 * Synthetic JAX-RS resource for the scaffold example. It has no OpenAPI
 * document; `anvil legacy scaffold` reads the annotations below as text.
 */
@Path("/orders")
@Produces(MediaType.APPLICATION_JSON)
public class OrderResource {

    @GET
    public List<Order> listOrders(
            @QueryParam("status") OrderStatus status,
            @QueryParam("limit") @DefaultValue("50") int limit,
            @Context UriInfo uriInfo) {
        return List.of();
    }

    @GET
    @Path("/{orderId: [0-9a-f-]+}")
    public Order getOrder(
            @PathParam("orderId") UUID orderId,
            @HeaderParam("X-Tenant") String tenant) {
        return null;
    }

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public Response createOrder(Order order) {
        return Response.status(201).build();
    }

    @POST
    @Path("/{orderId}/cancel")
    @Consumes({"application/json", "application/xml"})
    public Order cancelOrder(@PathParam("orderId") UUID orderId, CancelRequest request) {
        return null;
    }

    @DELETE
    @Path("/{orderId}")
    public void deleteOrder(@PathParam("orderId") UUID orderId) {
    }
}
