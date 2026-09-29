import { describe, expect, it } from "vitest";
import { MockEffectSink, start_sink_server } from "../src/index.js";

describe("sink HTTP server: malformed JSON body", () => {
  it("POST /accept with a malformed body answers 400 invalid JSON body, not 500", async () => {
    const srv = await start_sink_server(new MockEffectSink());
    try {
      const res = await fetch(`${srv.url}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/invalid JSON body/);
    } finally {
      await srv.close();
    }
  });

  it("POST /fault with a malformed body also answers 400", async () => {
    const srv = await start_sink_server(new MockEffectSink());
    try {
      const res = await fetch(`${srv.url}/fault`, { method: "POST", body: "not json" });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
