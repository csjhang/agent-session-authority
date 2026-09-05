import { describe, expect, it } from "vitest";
import { MockEffectSink, start_sink_server } from "../src/index.js";

describe("MockEffectSink", () => {
  it("accepts effectId+actionDigest and emits full EffectReceipt", async () => {
    const sink = new MockEffectSink({ runtimeGeneration: 3, fenceEpoch: 2 });
    const r = await sink.accept({ effectId: "e1", actionDigest: "d1" });
    expect(r.accepted).toBe(true);
    expect(r.receipt).toMatchObject({
      effectId: "e1",
      actionDigest: "d1",
      runtimeGeneration: 3,
      fenceEpoch: 2,
      boundaryId: "mock_effect_boundary",
      outcome: "committed",
    });
    expect(r.receipt?.observedAt).toBeTruthy();
    expect(r.receipt?.externalReference).toContain("e1");
    expect(sink.getCommitCount()).toBe(1);
    expect(sink.exportLedger()).toHaveLength(1);
  });

  it("counts commits and is idempotent on resend", async () => {
    const sink = new MockEffectSink();
    await sink.accept({ effectId: "e1", actionDigest: "d1" });
    const again = await sink.accept({ effectId: "e1", actionDigest: "d1" });
    expect(again.resent).toBe(true);
    expect(sink.getCommitCount()).toBe(1);
  });

  it("injects timeout / lost_reply / delay", async () => {
    const sink = new MockEffectSink();
    sink.setFaultMode("timeout");
    const t = await sink.accept({ effectId: "e_t", actionDigest: "d" });
    expect(t.accepted).toBe(false);
    expect(t.reason).toMatch(/timeout/);

    sink.setFaultMode("lost_reply");
    const lost = await sink.accept({ effectId: "e_l", actionDigest: "d" });
    expect(lost.suppressed).toBe(true);
    expect(lost.receipt).toBeNull();
    expect(sink.getCommitCount()).toBe(1);

    sink.setFaultMode("delay", 20);
    const start = Date.now();
    await sink.accept({ effectId: "e_d", actionDigest: "d" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("snapshot/restore rolls back ledger but not observation log", async () => {
    const sink = new MockEffectSink();
    const snap = sink.snapshot();
    const obs_before = sink.getObservationLog().length;
    await sink.accept({ effectId: "e1", actionDigest: "d1" });
    expect(sink.getCommitCount()).toBe(1);
    const obs_mid = sink.getObservationLog().length;
    expect(obs_mid).toBeGreaterThan(obs_before);
    sink.restore(snap);
    expect(sink.getCommitCount()).toBe(0);
    expect(sink.exportLedger()).toHaveLength(0);
    // observation log must NOT roll back
    expect(sink.getObservationLog().length).toBeGreaterThan(obs_mid);
    expect(sink.getObservationLog().some((o) => o.type === "sink.restore")).toBe(true);
  });
});

describe("sink HTTP server", () => {
  it("starts and accepts a receipt over HTTP", async () => {
    const srv = await start_sink_server(new MockEffectSink());
    try {
      const res = await fetch(`${srv.url}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ effectId: "http_1", actionDigest: "digest_http" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accepted: boolean; receipt: { effectId: string } };
      expect(body.accepted).toBe(true);
      expect(body.receipt.effectId).toBe("http_1");
      const health = await fetch(`${srv.url}/health`);
      expect((await health.json() as { commitCount: number }).commitCount).toBe(1);
    } finally {
      await srv.close();
    }
  });
});
