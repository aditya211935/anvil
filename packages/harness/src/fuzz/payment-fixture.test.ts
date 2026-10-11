import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { paymentFuzzFixture } from "./payment-fixture.js";

/** Send one raw request line and resolve the status code (0 when the socket closes first). */
function rawStatus(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let head = "";
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
    });
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}

describe("paymentFuzzFixture", () => {
  it("answers a malformed request target and keeps serving, so `anvil fuzz` survives it", async () => {
    const fixture = await paymentFuzzFixture("", 1, new AbortController().signal);
    try {
      const port = Number(new URL(fixture.baseUrl).port);
      expect(await rawStatus(port, "//")).toBe(500);
      expect((await fetch(`${fixture.baseUrl}/payments/p1`)).status).toBe(200);
    } finally {
      await fixture.close();
    }
  });
});
