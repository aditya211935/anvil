package com.acme.orders;

import javax.ws.rs.ApplicationPath;
import javax.ws.rs.core.Application;

/** Places every JAX-RS resource under /api. */
@ApplicationPath("/api")
public class OrdersApplication extends Application {
}
