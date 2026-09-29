import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MockEffectSink,
  chain_hash,
  hash_receipt,
  start_sink_server,
  verify_chain,
  type EffectReceipt,
} from "../src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

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

describe("PR-2: idempotency race", () => {
  it("serializes concurrent same effectId+actionDigest → commitCount=1, resent", async () => {
    const sink = new MockEffectSink({ faultMode: "delay", delayMs: 50 });
    const [a, b] = await Promise.all([
      sink.accept({ effectId: "race_1", actionDigest: "d_same" }),
      sink.accept({ effectId: "race_1", actionDigest: "d_same" }),
    ]);
    expect(sink.getCommitCount()).toBe(1);
    const results = [a, b];
    const committed = results.filter((r) => r.accepted && !r.resent);
    const resent = results.filter((r) => r.resent === true);
    expect(committed.length).toBe(1);
    expect(resent.length).toBe(1);
    expect(resent[0]!.receipt?.effectId).toBe(committed[0]!.receipt?.effectId);
    expect(resent[0]!.receipt?.actionDigest).toBe(committed[0]!.receipt?.actionDigest);
    expect(resent[0]!.receipt?.observedAt).toBe(committed[0]!.receipt?.observedAt);
  });

  it("concurrent same effectId different actionDigest → one committed, other digest_mismatch", async () => {
    const sink = new MockEffectSink({ faultMode: "delay", delayMs: 50 });
    const [a, b] = await Promise.all([
      sink.accept({ effectId: "race_2", actionDigest: "d_a" }),
      sink.accept({ effectId: "race_2", actionDigest: "d_b" }),
    ]);
    expect(sink.getCommitCount()).toBe(1);
    const ok = [a, b].filter((r) => r.accepted && r.receipt?.outcome === "committed");
    const bad = [a, b].filter((r) => !r.accepted);
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect(bad[0]!.reason).toMatch(/digest_mismatch|digest mismatch/i);
  });
});

describe("PR-2: enforce mode (default OFF)", () => {
  it("defaults enforce OFF so existing accept paths need no approval", async () => {
    const sink = new MockEffectSink();
    expect(sink.getEnforce()).toBe(false);
    const r = await sink.accept({ effectId: "e_off", actionDigest: "d" });
    expect(r.accepted).toBe(true);
  });

  it("rejects stale_fence / generation_mismatch / not_holder when enforce on", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 5,
      runtimeGeneration: 3,
      holders: { scope_a: "alice" },
    });
    sink.grant({
      effectId: "e_stale",
      actionDigest: "d1",
      approvalId: "appr_x",
      decision: "grant",
      runtimeGeneration: 3,
    });
    const stale = await sink.accept({
      effectId: "e_stale",
      actionDigest: "d1",
      fenceEpoch: 4,
      runtimeGeneration: 3,
      controller: "alice",
      scopeId: "scope_a",
      approval: { approval_id: "appr_x" },
    });
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe("stale_fence");

    sink.grant({
      effectId: "e_gen",
      actionDigest: "d1",
      approvalId: "appr_gen",
      decision: "grant",
      runtimeGeneration: 3,
    });
    const gen = await sink.accept({
      effectId: "e_gen",
      actionDigest: "d1",
      fenceEpoch: 5,
      runtimeGeneration: 2,
      controller: "alice",
      scopeId: "scope_a",
      approval: { approval_id: "appr_gen" },
    });
    expect(gen.accepted).toBe(false);
    expect(gen.reason).toBe("generation_mismatch");

    sink.grant({
      effectId: "e_nh",
      actionDigest: "d1",
      approvalId: "appr_nh",
      decision: "grant",
      runtimeGeneration: 3,
    });
    const nh = await sink.accept({
      effectId: "e_nh",
      actionDigest: "d1",
      fenceEpoch: 5,
      runtimeGeneration: 3,
      controller: "bob",
      scopeId: "scope_a",
      approval: { approval_id: "appr_nh" },
    });
    expect(nh.accepted).toBe(false);
    expect(nh.reason).toBe("not_holder");
  });

  it("after handoff, old controller rejected even with new fenceEpoch (not_holder)", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { scope_a: "alice" },
    });
    const okFence = sink.fence({
      fenceEpoch: 2,
      runtimeGeneration: 2,
      scopeId: "scope_a",
      holder: "bob",
    });
    expect(okFence.ok).toBe(true);
    expect(sink.getFenceEpoch()).toBe(2);
    expect(sink.getHolders().scope_a).toBe("bob");

    sink.grant({
      effectId: "e_handoff",
      actionDigest: "d1",
      approvalId: "appr_h",
      decision: "grant",
      runtimeGeneration: 2,
    });
    const old = await sink.accept({
      effectId: "e_handoff",
      actionDigest: "d1",
      fenceEpoch: 2,
      runtimeGeneration: 2,
      controller: "alice",
      scopeId: "scope_a",
      approval: { approval_id: "appr_h" },
    });
    expect(old.accepted).toBe(false);
    expect(old.reason).toBe("not_holder");
  });

  it("POST /fence rejects decrement with 400", async () => {
    const sink = new MockEffectSink({ fenceEpoch: 3, runtimeGeneration: 2 });
    const srv = await start_sink_server(sink);
    try {
      const res = await fetch(`${srv.url}/fence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fenceEpoch: 2 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("fence_decrement");
    } finally {
      await srv.close();
    }
  });
});

describe("PR-2: enforce approval from grant records", () => {
  function enforced() {
    return new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
  }

  const base = {
    fenceEpoch: 1,
    runtimeGeneration: 1,
    controller: "c1",
    scopeId: "s",
  };

  it("missing_approval / unknown_approval / digest / reused via grant records", async () => {
    const sink = enforced();

    const missing = await sink.accept({ effectId: "e_m", actionDigest: "d", ...base });
    expect(missing.reason).toBe("missing_approval");

    const never = await sink.accept({
      effectId: "e_never",
      actionDigest: "d",
      ...base,
      approval: { approval_id: "never_issued" },
    });
    expect(never.reason).toBe("unknown_approval");
    expect(never.accepted).toBe(false);

    sink.grant({
      effectId: "e_ad",
      actionDigest: "other",
      approvalId: "a2",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const dig = await sink.accept({
      effectId: "e_ad",
      actionDigest: "d",
      ...base,
      approval: { approval_id: "a2" },
    });
    expect(dig.reason).toBe("approval_digest_mismatch");

    sink.grant({
      effectId: "e_ok",
      actionDigest: "d",
      approvalId: "a_shared",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const first = await sink.accept({
      effectId: "e_ok",
      actionDigest: "d",
      ...base,
      approval: { approval_id: "a_shared" },
    });
    expect(first.accepted).toBe(true);
    expect(first.receipt?.approvalId).toBe("a_shared");

    sink.grant({
      effectId: "e_other",
      actionDigest: "d2",
      approvalId: "a_shared",
      decision: "grant",
      runtimeGeneration: 1,
    });
    // latest grant for a_shared now has digest d2, but approval already used by e_ok
    const reused = await sink.accept({
      effectId: "e_other",
      actionDigest: "d2",
      ...base,
      approval: { approval_id: "a_shared" },
    });
    expect(reused.reason).toBe("approval_reused");
  });

  it("grant() recorded deny then accept → approval_denied (ignores request decision claim)", async () => {
    const sink = enforced();
    sink.grant({
      effectId: "e_deny",
      actionDigest: "d",
      approvalId: "a_deny",
      decision: "deny",
      runtimeGeneration: 1,
    });
    const denied = await sink.accept({
      effectId: "e_deny",
      actionDigest: "d",
      ...base,
      approval: { approval_id: "a_deny", decision: "grant" },
    });
    expect(denied.accepted).toBe(false);
    expect(denied.reason).toBe("approval_denied");
  });
});

describe("PR-2: evidence hash chain (JCS + chain hash)", () => {
  it("record hash is key-order independent; previousEvidenceHash excluded from record hash", () => {
    const base: EffectReceipt = {
      effectId: "e1",
      actionDigest: "d1",
      runtimeGeneration: 1,
      fenceEpoch: 1,
      boundaryId: "b",
      outcome: "committed",
      externalReference: "mock://b/e1",
      observedAt: "2026-09-29T00:00:00.000Z",
      previousEvidenceHash: null,
    };
    const reordered = {
      outcome: base.outcome,
      boundaryId: base.boundaryId,
      previousEvidenceHash: base.previousEvidenceHash,
      effectId: base.effectId,
      observedAt: base.observedAt,
      actionDigest: base.actionDigest,
      externalReference: base.externalReference,
      fenceEpoch: base.fenceEpoch,
      runtimeGeneration: base.runtimeGeneration,
    } as EffectReceipt;
    expect(hash_receipt(base)).toBe(hash_receipt(reordered));

    const withPrev: EffectReceipt = {
      ...base,
      previousEvidenceHash: "deadbeef",
    };
    expect(hash_receipt(withPrev)).toBe(hash_receipt(base));
  });

  it("tamper: alter record 1 content and patch record 2 pointer → verify_chain fails; final chain hash changes", async () => {
    const sink = new MockEffectSink({
      clock: (() => {
        let n = 0;
        return () => {
          n += 1;
          return new Date(Date.UTC(2026, 8, 29, 0, 0, n)).toISOString();
        };
      })(),
    });
    await sink.accept({ effectId: "e1", actionDigest: "d1" });
    await sink.accept({ effectId: "e2", actionDigest: "d2" });
    const ledger = sink.exportLedger();
    expect(ledger).toHaveLength(2);
    const original = verify_chain(ledger);
    expect(original.ok).toBe(true);
    expect(original.finalChainHash).toBe(sink.getLastEvidenceHash());

    // Tamper record 1 content and patch record 2's previousEvidenceHash to the
    // new *record* hash (wrong link — should be chain hash), simulating a botched cover-up.
    const tampered = ledger.map((r) => ({ ...r }));
    tampered[0]!.actionDigest = "TAMPERED";
    const forgedRecordHash = hash_receipt(tampered[0]!);
    tampered[1]!.previousEvidenceHash = forgedRecordHash;

    const v = verify_chain(tampered);
    expect(v.ok).toBe(false);
    expect(v.breakAt === 0 || v.breakAt === 1).toBe(true);

    // Recompute what the final chain hash would be if links were "fixed" to chain hashes:
    const rh0 = hash_receipt(tampered[0]!);
    const ch0 = chain_hash("", rh0);
    const rh1 = hash_receipt({ ...tampered[1]!, previousEvidenceHash: ch0 });
    const ch1 = chain_hash(ch0, rh1);
    expect(ch1).not.toBe(original.finalChainHash);
  });
});

describe("PR-2: enforce must not fail-open", () => {
  it("missing fenceEpoch/runtimeGeneration/controller/scopeId → missing_authority_fields", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e_miss",
      actionDigest: "d",
      approvalId: "a_miss",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const r = await sink.accept({
      effectId: "e_miss",
      actionDigest: "d",
      approval: { approval_id: "a_miss" },
      // omit fenceEpoch, runtimeGeneration, controller, scopeId
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("missing_authority_fields");
    expect(r.detail?.missing).toEqual(
      expect.arrayContaining(["fenceEpoch", "runtimeGeneration", "controller", "scopeId"]),
    );
    expect(sink.getCommitCount()).toBe(0);
  });

  it("scopeId not in holders → unknown_scope", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e_us",
      actionDigest: "d",
      approvalId: "a_us",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const r = await sink.accept({
      effectId: "e_us",
      actionDigest: "d",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "unknown_scope_id",
      approval: { approval_id: "a_us" },
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("unknown_scope");
  });

  it("after handoff, old controller omitting scopeId/fenceEpoch → rejected not committed", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { scope_a: "alice" },
    });
    sink.fence({
      fenceEpoch: 2,
      runtimeGeneration: 2,
      scopeId: "scope_a",
      holder: "bob",
    });
    sink.grant({
      effectId: "e_omit",
      actionDigest: "d1",
      approvalId: "appr_omit",
      decision: "grant",
      runtimeGeneration: 2,
    });
    const old = await sink.accept({
      effectId: "e_omit",
      actionDigest: "d1",
      runtimeGeneration: 2,
      controller: "alice",
      // omit scopeId and fenceEpoch
      approval: { approval_id: "appr_omit" },
    });
    expect(old.accepted).toBe(false);
    expect(old.reason).toBe("missing_authority_fields");
    expect(old.detail?.missing).toEqual(expect.arrayContaining(["fenceEpoch", "scopeId"]));
    expect(old.receipt?.outcome).toBe("rejected");
    expect(sink.getCommitCount()).toBe(0);
  });
});

describe("PR-2: cross-effect approval race", () => {
  it("delay mode, two different effectIds same approval → bound effect commits, other approval_effect_mismatch", async () => {
    const sink2 = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
      faultMode: "delay",
      delayMs: 50,
    });
    // Approval is bound to race_a; race_b must not steal it (effect mismatch, not reuse race).
    sink2.grant({
      effectId: "race_a",
      actionDigest: "d_shared",
      approvalId: "appr_race",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const base = {
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "appr_race" },
    };
    const [a, b] = await Promise.all([
      sink2.accept({ effectId: "race_a", actionDigest: "d_shared", ...base }),
      sink2.accept({ effectId: "race_b", actionDigest: "d_shared", ...base }),
    ]);
    expect(sink2.getCommitCount()).toBe(1);
    const ok = [a, b].filter((r) => r.accepted && r.receipt?.outcome === "committed");
    const bad = [a, b].filter((r) => !r.accepted);
    expect(ok.length).toBe(1);
    expect(ok[0]!.receipt?.effectId).toBe("race_a");
    expect(bad.length).toBe(1);
    expect(bad[0]!.reason).toBe("approval_effect_mismatch");
  });
});

describe("PR-2: fence() atomic + holder auto-increment", () => {
  it("{fenceEpoch:9, runtimeGeneration: smaller} → ok:false, fenceEpoch unchanged", () => {
    const sink = new MockEffectSink({ fenceEpoch: 5, runtimeGeneration: 3 });
    const r = sink.fence({ fenceEpoch: 9, runtimeGeneration: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("generation_decrement");
    expect(sink.getFenceEpoch()).toBe(5);
    expect(sink.getRuntimeGeneration()).toBe(3);
  });

  it("enforce: holder change without larger fenceEpoch auto-increments fenceEpoch", () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 4,
      runtimeGeneration: 1,
      holders: { s: "alice" },
    });
    const r = sink.fence({ scopeId: "s", holder: "bob" });
    expect(r.ok).toBe(true);
    expect(sink.getHolders().s).toBe("bob");
    expect(sink.getFenceEpoch()).toBe(5);
  });
});

describe("PR-2: restore() enforce mismatch throws", () => {
  it("restore snapshot with different enforce → error", async () => {
    const sinkOff = new MockEffectSink({ enforce: false });
    const snap = sinkOff.snapshot();
    expect(snap.enforce).toBe(false);
    const sinkOn = new MockEffectSink({ enforce: true, holders: { s: "c" } });
    expect(() => sinkOn.restore(snap)).toThrow(/enforce mismatch/);
  });
});

describe("PR-2: pending cleanup + rejected accepted:false", () => {
  it("after lost_reply, resend pulls from pending and clears it", async () => {
    const sink = new MockEffectSink();
    sink.setFaultMode("lost_reply");
    const lost = await sink.accept({ effectId: "e_pend", actionDigest: "d" });
    expect(lost.suppressed).toBe(true);
    expect(sink.snapshot().pending["e_pend"]).toBeTruthy();

    sink.setFaultMode("none");
    const again = await sink.accept({ effectId: "e_pend", actionDigest: "d" });
    expect(again.resent).toBe(true);
    expect(again.receipt?.effectId).toBe("e_pend");
    expect(sink.snapshot().pending["e_pend"]).toBeUndefined();
    expect(sink.getCommitCount()).toBe(1);
  });

  it("outcome=rejected → accepted:false and HTTP 400", async () => {
    const sink = new MockEffectSink();
    const r = await sink.accept({
      effectId: "e_rej",
      actionDigest: "d",
      forceOutcome: "rejected",
    });
    expect(r.accepted).toBe(false);
    expect(r.receipt?.outcome).toBe("rejected");

    const srv = await start_sink_server(new MockEffectSink());
    try {
      const res = await fetch(`${srv.url}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          effectId: "e_rej_http",
          actionDigest: "d",
          forceOutcome: "rejected",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(false);
    } finally {
      await srv.close();
    }
  });
});

describe("PR-2: export asa.agent-effect/0.1", () => {
  it("grant → commit → handoff → old controller rejected; cross-verify ok; corrupt → cross_generation_reuse", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      boundaryId: "fs-gateway",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { scope_a: "alice" },
      clock: (() => {
        let n = 0;
        return () => {
          n += 1;
          return new Date(Date.UTC(2026, 8, 29, 0, 0, n)).toISOString();
        };
      })(),
    });

    const g = sink.grant({
      effectId: "eff-1",
      actionDigest: "sha256:deadbeef",
      approvalId: "appr-1",
      decision: "grant",
      runtimeGeneration: 1,
      fenceEpoch: 1,
      controller: "alice",
      scopeId: "scope_a",
    });
    expect(g.accepted).toBe(true);
    expect(g.receipt?.outcome).toBe("unknown");
    expect(g.receipt?.approvalId).toBe("appr-1");
    expect(g.receipt?.recordKind).toBe("approval");

    const c = await sink.accept({
      effectId: "eff-1",
      actionDigest: "sha256:deadbeef",
      runtimeGeneration: 1,
      fenceEpoch: 1,
      controller: "alice",
      scopeId: "scope_a",
      approval: { approval_id: "appr-1" },
    });
    expect(c.accepted).toBe(true);
    expect(c.receipt?.outcome).toBe("committed");
    expect(c.receipt?.approvalId).toBe("appr-1");

    const handoff = sink.fence({
      fenceEpoch: 2,
      runtimeGeneration: 2,
      scopeId: "scope_a",
      holder: "bob",
    });
    expect(handoff.ok).toBe(true);

    const old = await sink.accept({
      effectId: "eff-2",
      actionDigest: "sha256:cafe",
      runtimeGeneration: 2,
      fenceEpoch: 2,
      controller: "alice",
      scopeId: "scope_a",
      approval: { approval_id: "appr-2" },
    });
    expect(old.accepted).toBe(false);
    // unknown_approval (never granted) or not_holder — holder checked before approval
    expect(old.reason).toBe("not_holder");
    expect(old.receipt?.outcome).toBe("rejected");

    const records = sink.exportAgentEffectRecords();
    expect(records.every((r) => r.schema_version === "asa.agent-effect/0.1")).toBe(true);
    expect(records[0]!.stream_id).toBe("boundary/fs-gateway");
    expect(records.map((r) => r.sequence_number)).toEqual([1, 2, 3]);
    expect(records[0]!.record_kind).toBe("approval");
    expect(records[1]!.approval_id).toBe("appr-1");
    expect(records[1]!.approval_runtime_generation).toBe(1);

    const crossPath = join(repoRoot, "spec/vectors/agent-effect/cross-verify.ts");
    const mod = await import(pathToFileURL(crossPath).href);
    const verifyCrossRecords = mod.verifyCrossRecords as (recs: unknown[]) => {
      ok: boolean;
      violations: { code: string }[];
      unknowns: { effect_id: string }[];
    };

    const ok = verifyCrossRecords(records);
    expect(ok.ok).toBe(true);
    // approval record_kind should not appear in unknowns list
    expect(ok.unknowns.map((u) => u.effect_id)).not.toContain("eff-1");

    const corrupted = records.map((r, i) =>
      i === 1 ? { ...r, runtime_generation: 99 } : { ...r },
    );
    const bad = verifyCrossRecords(corrupted);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.code === "cross_generation_reuse")).toBe(true);

    const srv = await start_sink_server(sink);
    try {
      const res = await fetch(`${srv.url}/ledger?format=agent-effect`);
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[0].schema_version).toBe("asa.agent-effect/0.1");
      expect(lines[0].record_kind).toBe("approval");
    } finally {
      await srv.close();
    }
  });
});

describe("PR-2: jcs re-export still works for vectors", () => {
  it("spec jcs re-exports canonicalize from core", async () => {
    const jcsPath = join(repoRoot, "spec/vectors/agent-effect/jcs.ts");
    const src = readFileSync(jcsPath, "utf8");
    expect(src).toMatch(/packages\/core\/src\/jcs/);
    const { canonicalize } = await import(pathToFileURL(jcsPath).href);
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("PR-2 amend: effect records recordKind=effect", () => {
  it("accept committed/rejected/failed and reject() always recordKind=effect; grant stays approval", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    const g = sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a1",
      decision: "grant",
      runtimeGeneration: 1,
    });
    expect(g.receipt?.recordKind).toBe("approval");

    const bad = await sink.accept({
      effectId: "e1",
      actionDigest: "x",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a1" },
    });
    expect(bad.accepted).toBe(false);
    expect(bad.reason).toBe("approval_digest_mismatch");
    expect(bad.receipt?.recordKind).toBe("effect");
    expect(bad.receipt?.outcome).toBe("rejected");

    sink.grant({
      effectId: "e2",
      actionDigest: "d2",
      approvalId: "a2",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const ok = await sink.accept({
      effectId: "e2",
      actionDigest: "d2",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a2" },
    });
    expect(ok.accepted).toBe(true);
    expect(ok.receipt?.recordKind).toBe("effect");
    expect(ok.receipt?.outcome).toBe("committed");

    const sink2 = new MockEffectSink();
    const failed = await sink2.accept({
      effectId: "e_f",
      actionDigest: "d",
      forceOutcome: "failed",
    });
    expect(failed.receipt?.recordKind).toBe("effect");
    expect(failed.receipt?.outcome).toBe("failed");
  });

  it("grant(e1,d) → accept digest mismatch → export + verifyCrossRecords ok with rejected_digest_variant", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      boundaryId: "fs-gateway",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
      clock: (() => {
        let n = 0;
        return () => {
          n += 1;
          return new Date(Date.UTC(2026, 8, 29, 0, 0, n)).toISOString();
        };
      })(),
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a-rdv",
      decision: "grant",
      runtimeGeneration: 1,
      fenceEpoch: 1,
      controller: "c1",
      scopeId: "s",
    });
    const rej = await sink.accept({
      effectId: "e1",
      actionDigest: "x",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a-rdv" },
    });
    expect(rej.reason).toBe("approval_digest_mismatch");
    expect(rej.receipt?.recordKind).toBe("effect");

    const records = sink.exportAgentEffectRecords();
    expect(records[0]!.record_kind).toBe("approval");
    expect(records[1]!.record_kind).toBe("effect");
    expect(records[1]!.outcome).toBe("rejected");

    const crossPath = join(repoRoot, "spec/vectors/agent-effect/cross-verify.ts");
    const mod = await import(pathToFileURL(crossPath).href);
    const verifyCrossRecords = mod.verifyCrossRecords as (recs: unknown[]) => {
      ok: boolean;
      reports: { code: string }[];
      violations: { code: string }[];
    };
    const result = verifyCrossRecords(records);
    expect(result.ok).toBe(true);
    expect(result.reports.some((r) => r.code === "rejected_digest_variant")).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("PR-2 amend: grant() gen/fence decided by sink (enforce)", () => {
  it("at gen1 grant(runtimeGeneration:5) → grant_generation_mismatch; no grantHistory", () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    const r = sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a_bad_gen",
      decision: "grant",
      runtimeGeneration: 5,
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("grant_generation_mismatch");
    expect(r.receipt).toBeNull();
    expect(sink.getLatestGrant("a_bad_gen")).toBeUndefined();
    expect(sink.exportLedger()).toHaveLength(0);
  });

  it("grant(fenceEpoch mismatch) → grant_fence_mismatch", () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 2,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    const r = sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a_bad_fence",
      decision: "grant",
      fenceEpoch: 1,
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("grant_fence_mismatch");
    expect(sink.getLatestGrant("a_bad_fence")).toBeUndefined();
  });

  it("normal grant then advance to gen2 → accept → approval_generation_mismatch", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    const g = sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a_gen",
      decision: "grant",
      runtimeGeneration: 1,
    });
    expect(g.accepted).toBe(true);
    expect(g.receipt?.runtimeGeneration).toBe(1);
    expect(sink.getLatestGrant("a_gen")?.runtimeGeneration).toBe(1);

    sink.fence({ runtimeGeneration: 2 });
    const a = await sink.accept({
      effectId: "e1",
      actionDigest: "d",
      fenceEpoch: 1,
      runtimeGeneration: 2,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a_gen" },
    });
    expect(a.accepted).toBe(false);
    expect(a.reason).toBe("approval_generation_mismatch");
    expect(a.receipt?.recordKind).toBe("effect");
  });
});

describe("PR-2 amend: approval bound to effect", () => {
  it("approval for e1 used on e9 → approval_effect_mismatch", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a_e1",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const r = await sink.accept({
      effectId: "e9",
      actionDigest: "d",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a_e1" },
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("approval_effect_mismatch");
    expect(r.receipt?.recordKind).toBe("effect");
    expect(sink.getCommitCount()).toBe(0);
  });
});

describe("PR-2 amend: restore() verifies chain + known snapshots", () => {
  it("forge grant in snapshot → restore throws chain_invalid; later accept → unknown_approval", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e_real",
      actionDigest: "d",
      approvalId: "a_real",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const snap = sink.snapshot();
    // Forge an extra grant into the snapshot ledger without fixing the chain.
    const forged = {
      effectId: "e_forged",
      actionDigest: "d_forged",
      runtimeGeneration: 1,
      fenceEpoch: 1,
      boundaryId: snap.boundaryId,
      outcome: "unknown" as const,
      externalReference: null,
      observedAt: "2026-09-29T00:00:00.000Z",
      previousEvidenceHash: snap.lastEvidenceHash,
      approvalId: "a_forged",
      approvalDecision: "grant" as const,
      approvalRuntimeGeneration: 1,
      recordKind: "approval" as const,
    };
    const forgedSnap = {
      ...snap,
      ledger: [...snap.ledger, forged],
      // leave lastEvidenceHash as pre-forge head → chain/head mismatch
    };
    expect(() => sink.restore(forgedSnap)).toThrow(/chain_invalid/);
    expect(
      sink.getObservationLog().some(
        (o) => o.type === "sink.restore_reject" && o.detail.reason === "chain_invalid",
      ),
    ).toBe(true);
    // Restore did not apply — forged approval unknown
    expect(sink.getLatestGrant("a_forged")).toBeUndefined();
    const later = await sink.accept({
      effectId: "e_forged",
      actionDigest: "d_forged",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a_forged" },
    });
    expect(later.reason).toBe("unknown_approval");
  });

  it("under enforce: snapshot head not produced by this sink → unknown_snapshot", () => {
    const producer = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    producer.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a1",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const snap = producer.snapshot();
    // Foreign sink with same enforce never called snapshot() → unknown_snapshot
    const foreign = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    expect(() => foreign.restore(snap)).toThrow(/unknown_snapshot/);
    expect(
      foreign.getObservationLog().some(
        (o) => o.type === "sink.restore_reject" && o.detail.reason === "unknown_snapshot",
      ),
    ).toBe(true);
  });
});

describe("PR-2 amend: verify_chain expectedHead / head_mismatch", () => {
  it("full chain rewrite: without expectedHead ok=true (unkeyed limitation); with original head → head_mismatch", async () => {
    const sink = new MockEffectSink({
      clock: (() => {
        let n = 0;
        return () => {
          n += 1;
          return new Date(Date.UTC(2026, 8, 29, 0, 0, n)).toISOString();
        };
      })(),
    });
    await sink.accept({ effectId: "e1", actionDigest: "d1" });
    await sink.accept({ effectId: "e2", actionDigest: "d2" });
    const ledger = sink.exportLedger();
    const originalHead = sink.getLastEvidenceHash();
    expect(verify_chain(ledger).ok).toBe(true);
    expect(verify_chain(ledger, originalHead).ok).toBe(true);

    // Rewrite whole chain: tamper content and recompute every previousEvidenceHash pointer.
    // Comment: unkeyed chain limitation — without an external head anchor, a full rewrite verifies.
    const rewritten = ledger.map((r) => ({ ...r, actionDigest: r.actionDigest + "_rewritten" }));
    let prevChain = "";
    for (let i = 0; i < rewritten.length; i++) {
      rewritten[i]!.previousEvidenceHash = prevChain === "" ? null : prevChain;
      const rh = hash_receipt(rewritten[i]!);
      prevChain = chain_hash(prevChain, rh);
    }

    // Without expectedHead: structurally valid rewritten chain → ok=true (unkeyed chain limitation)
    const unkeyed = verify_chain(rewritten);
    expect(unkeyed.ok).toBe(true);
    expect(unkeyed.finalChainHash).not.toBe(originalHead);

    // With original head anchored outside the ledger → head_mismatch
    const keyed = verify_chain(rewritten, originalHead);
    expect(keyed.ok).toBe(false);
    expect(keyed.reason).toBe("head_mismatch");
  });
});
