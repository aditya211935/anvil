package com.acme.orders;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** A plain data class; its declared fields are projected as properties. */
public class Order {
    private UUID id;
    private String customerRef;
    private OrderStatus status;
    private BigDecimal total;
    private LocalDate placedOn;
    private List<String> tags;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }
}
