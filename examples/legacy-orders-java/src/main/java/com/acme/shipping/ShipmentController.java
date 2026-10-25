package com.acme.shipping;

import java.util.List;
import java.util.Optional;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Synthetic Spring MVC controller for the scaffold example. */
@RestController
@RequestMapping("/shipments")
public class ShipmentController {

    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public List<Shipment> list(
            @RequestParam(value = "carrier", required = false) String carrier,
            @RequestParam(defaultValue = "20") int size,
            @RequestHeader("X-Tenant") String tenant) {
        return List.of();
    }

    @GetMapping("/{shipmentId}")
    public ResponseEntity<Shipment> get(@PathVariable("shipmentId") long shipmentId) {
        return ResponseEntity.notFound().build();
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Shipment> create(@RequestBody Shipment shipment) {
        return ResponseEntity.ok(shipment);
    }

    @DeleteMapping("/{shipmentId}")
    public void remove(@PathVariable long shipmentId) {
    }

    @RequestMapping(path = "/{shipmentId}/label", method = RequestMethod.PUT)
    public void label(@PathVariable long shipmentId, @RequestBody(required = false) byte[] pdf) {
    }

    @RequestMapping("/health")
    public String health(@RequestParam Optional<String> verbose) {
        return "ok";
    }
}
