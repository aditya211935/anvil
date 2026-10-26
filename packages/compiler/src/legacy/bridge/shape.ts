import type { LegacyTransportPlan } from "../refinement/model.js";

/**
 * Whether a reviewed transport has the one shape today's queue bridge can
 * conformance-test, or still needs an adapter family nobody has built.
 *
 * `executable_shape` is deliberately narrow: it is the shape
 * `@anvil/legacy-bridge`'s `buildQueueWireBinding` accepts without throwing
 * — a `message` transport whose reply mode is `reply_to` or
 * `fixed_destination`, with a correlation field (and, for a fixed
 * destination, a reply target). It says nothing about whether the binding
 * runs, reaches a broker, or completed conformance; `runtime.status` carries
 * that claim and only a conformance report can move it.
 *
 * `packages/cli/src/cmd-legacy-scorecard.test.ts` asserts this predicate and
 * `buildQueueWireBinding` agree, so the scorecard can never report a shape the
 * bridge would refuse.
 */
export type LegacyBridgeShape = "executable_shape" | "needs_driver";

export function classifyLegacyTransportShape(transport: LegacyTransportPlan): LegacyBridgeShape {
  if (transport.kind !== "message") return "needs_driver";
  const { reply } = transport;
  if (reply.mode !== "reply_to" && reply.mode !== "fixed_destination") return "needs_driver";
  if (!reply.correlationField) return "needs_driver";
  if (reply.mode === "fixed_destination" && !reply.target) return "needs_driver";
  return "executable_shape";
}

/**
 * The adapter family a `needs_driver` transport waits on, named as
 * `docs/legacy-runtime-bridges.md` ("Adapter families still required") names
 * them. A vendor-specific remote-EJB family is named only when the reviewed
 * target's URL scheme proves it; otherwise the family is the generic
 * "remote EJB". Protocols the table does not list are named by kind and
 * protocol rather than guessed into a listed family.
 */
export function legacyAdapterFamily(transport: LegacyTransportPlan): string {
  switch (transport.kind) {
    case "message":
      switch (transport.protocol) {
        case "jms":
          return "JMS";
        case "ibm_mq":
          return "IBM MQ";
        case "msmq":
          return "MSMQ";
        default:
          return `message broker (${transport.protocol})`;
      }
    case "remote_method":
      switch (transport.protocol) {
        case "ejb_rmi":
          return remoteEjbFamily(transport.target);
        case "wcf":
          return "WCF";
        default:
          return `remote method (${transport.protocol})`;
      }
    case "resource_adapter":
      return "JCA resource adapter";
    case "stored_procedure":
      return "Stored procedure";
    case "batch_job":
      return "Batch or scheduler";
  }
}

function remoteEjbFamily(target: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  switch (scheme) {
    case "t3":
    case "t3s":
      return "WebLogic remote EJB";
    case "iiop":
    case "corbaloc":
    case "corbaname":
      return "WebSphere remote EJB";
    case "remote+http":
    case "remote+https":
    case "http-remoting":
    case "https-remoting":
    case "remoting":
      return "JBoss remote EJB";
    default:
      return "remote EJB";
  }
}
