package com.acme.shipping;

import java.time.Instant;

public class Shipment {
    private long id;
    private String carrier;
    private String trackingNumber;
    private Instant dispatchedAt;
}
