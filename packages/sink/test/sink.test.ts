import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MockEffectSink,
  chain_hash,
  hash_receipt,
  snapshot_integrity_hash,
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

describe("PR-4: effect_denied + per-stream sequence", () => {
  it("grant then deny on same effect → accept with prior grant is effect_denied", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    expect(
      sink.grant({
        effectId: "e1",
        actionDigest: "d1",
        approvalId: "a1",
        decision: "grant",
      }).accepted,
    ).toBe(true);
    expect(
      sink.grant({
        effectId: "e1",
        actionDigest: "d1",
        approvalId: "a2",
        decision: "deny",
      }).accepted,
    ).toBe(true);
    const r = await sink.accept({
      effectId: "e1",
      actionDigest: "d1",
      controller: "c1",
      scopeId: "s",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      approval: { approval_id: "a1" },
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("effect_denied");
  });

  it("deny then fresh grant → accept with fresh grant succeeds", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d1",
      approvalId: "a1",
      decision: "deny",
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d1",
      approvalId: "a2",
      decision: "grant",
    });
    const r = await sink.accept({
      effectId: "e1",
      actionDigest: "d1",
      controller: "c1",
      scopeId: "s",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      approval: { approval_id: "a2" },
    });
    expect(r.accepted).toBe(true);
    expect(r.receipt?.outcome).toBe("committed");
  });

  it("two boundaries: per stream_id sequence from 1 contiguous; no sequence_gap", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
      boundaryId: "b-default",
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d1",
      approvalId: "a1",
      decision: "grant",
      boundaryId: "bound-a",
    });
    sink.grant({
      effectId: "e2",
      actionDigest: "d2",
      approvalId: "a2",
      decision: "grant",
      boundaryId: "bound-b",
    });
    await sink.accept({
      effectId: "e1",
      actionDigest: "d1",
      controller: "c1",
      scopeId: "s",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      boundaryId: "bound-a",
      approval: { approval_id: "a1" },
    });
    await sink.accept({
      effectId: "e2",
      actionDigest: "d2",
      controller: "c1",
      scopeId: "s",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      boundaryId: "bound-b",
      approval: { approval_id: "a2" },
    });
    const records = sink.exportAgentEffectRecords();
    const byStream = new Map<string, number[]>();
    for (const r of records) {
      const list = byStream.get(r.stream_id) ?? [];
      list.push(r.sequence_number);
      byStream.set(r.stream_id, list);
    }
    expect(byStream.get("boundary/bound-a")).toEqual([1, 2]);
    expect(byStream.get("boundary/bound-b")).toEqual([1, 2]);

    const crossPath = join(repoRoot, "spec/vectors/agent-effect/cross-verify.ts");
    const mod = await import(pathToFileURL(crossPath).href);
    const verifyCrossRecords = mod.verifyCrossRecords as (recs: unknown[]) => {
      ok: boolean;
      gaps: { stream_id: string }[];
      violations: { code: string }[];
    };
    const cross = verifyCrossRecords(records);
    expect(cross.ok).toBe(true);
    expect(cross.gaps).toEqual([]);
  });

  it("restore rebuilds effect-level deny tracking", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d1",
      approvalId: "a1",
      decision: "grant",
    });
    const snap = sink.snapshot();
    sink.grant({
      effectId: "e1",
      actionDigest: "d1",
      approvalId: "a2",
      decision: "deny",
    });
    const denied = await sink.accept({
      effectId: "e1",
      actionDigest: "d1",
      controller: "c1",
      scopeId: "s",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      approval: { approval_id: "a1" },
    });
    expect(denied.reason).toBe("effect_denied");
    sink.restore(snap);
    // After restore to pre-deny snapshot, grant a1 is latest again (and gen bumped under enforce).
    sink.grant({
      effectId: "e1",
      actionDigest: "d1",
      approvalId: "a1b",
      decision: "grant",
    });
    const r = await sink.accept({
      effectId: "e1",
      actionDigest: "d1",
      controller: "c1",
      scopeId: "s",
      fenceEpoch: sink.getFenceEpoch(),
      runtimeGeneration: sink.getRuntimeGeneration(),
      approval: { approval_id: "a1b" },
    });
    expect(r.accepted).toBe(true);
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

describe("PR-2 amend: restore must not rewind fencing (enforce)", () => {
  it("snapshot gen1/epoch1/holder c1 → handoff c2+gen2 → restore → gen=3; old c1/gen1 rejected", async () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e_old",
      actionDigest: "d",
      approvalId: "a_old",
      decision: "grant",
      runtimeGeneration: 1,
      fenceEpoch: 1,
    });
    const snap = sink.snapshot();
    expect(snap.defaultRuntimeGeneration).toBe(1);
    expect(snap.defaultFenceEpoch).toBe(1);
    expect(snap.holders).toEqual({ s: "c1" });

    // Advance past snap: handoff to c2 + gen2 (holder change also bumps fence under enforce).
    const handoff = sink.fence({
      scopeId: "s",
      holder: "c2",
      runtimeGeneration: 2,
    });
    expect(handoff.ok).toBe(true);
    expect(sink.getRuntimeGeneration()).toBe(2);
    expect(sink.getFenceEpoch()).toBeGreaterThan(1);
    expect(sink.getHolders()).toEqual({ s: "c2" });

    sink.restore(snap);
    // AUTH-01b: max(current=2, snap=1)+1 = 3; holders keep CURRENT (c2).
    expect(sink.getRuntimeGeneration()).toBe(3);
    expect(sink.getFenceEpoch()).toBe(Math.max(handoff.fenceEpoch, snap.defaultFenceEpoch) + 1);
    expect(sink.getHolders()).toEqual({ s: "c2" });
    expect(
      sink.getObservationLog().some((o) => o.type === "sink.restore_bump"),
    ).toBe(true);

    const stale = await sink.accept({
      effectId: "e_old",
      actionDigest: "d",
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
      approval: { approval_id: "a_old" },
    });
    expect(stale.accepted).toBe(false);
    expect(["stale_fence", "generation_mismatch", "not_holder"]).toContain(stale.reason);
    expect(sink.getRuntimeGeneration()).toBe(3);
  });
});

describe("PR-2 amend: snapshot integrity covers full state", () => {
  it("valid snap with only holders or defaultFenceEpoch altered → unknown_snapshot", () => {
    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
    sink.grant({
      effectId: "e1",
      actionDigest: "d",
      approvalId: "a1",
      decision: "grant",
      runtimeGeneration: 1,
    });
    const snap = sink.snapshot();
    const goodHash = snapshot_integrity_hash(snap);
    expect(goodHash).toMatch(/^[0-9a-f]{64}$/);

    const holdersAltered = {
      ...snap,
      holders: { s: "attacker" },
    };
    expect(snapshot_integrity_hash(holdersAltered)).not.toBe(goodHash);
    expect(() => sink.restore(holdersAltered)).toThrow(/unknown_snapshot/);

    const epochAltered = {
      ...snap,
      defaultFenceEpoch: snap.defaultFenceEpoch + 99,
    };
    expect(snapshot_integrity_hash(epochAltered)).not.toBe(goodHash);
    expect(() => sink.restore(epochAltered)).toThrow(/unknown_snapshot/);

    // Untampered snap still restores (with bump).
    sink.restore(snap);
    expect(sink.getRuntimeGeneration()).toBe(2); // max(1,1)+1
    expect(
      sink.getObservationLog().some(
        (o) => o.type === "sink.restore_reject" && o.detail.reason === "unknown_snapshot",
      ),
    ).toBe(true);
  });
});

describe("PR-2 amend: generative enforce sequences", () => {
  it("fixed seed ≥200 random ops: chain+cross ok; tamper fails", async () => {
    const SEED = 20260929;
    const OP_COUNT = 200;
    /** mulberry32 */
    function makeRng(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rng = makeRng(SEED);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const ops: string[] = [];

    const crossPath = join(repoRoot, "spec/vectors/agent-effect/cross-verify.ts");
    const mod = await import(pathToFileURL(crossPath).href);
    const verifyCrossRecords = mod.verifyCrossRecords as (recs: unknown[]) => {
      ok: boolean;
      violations: { code: string }[];
    };

    const sink = new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
      boundaryId: "gen-boundary",
      clock: (() => {
        let n = 0;
        return () => {
          n += 1;
          return new Date(Date.UTC(2026, 8, 29, 12, 0, n)).toISOString();
        };
      })(),
    });

    let effectSeq = 0;
    let approvalSeq = 0;
    /** Unused grant slots: approvalId bound to effectId+digest at current gen. */
    const openGrants: { approvalId: string; effectId: string; digest: string; gen: number }[] =
      [];
    let holder = "c1";

    const auth = () => ({
      fenceEpoch: sink.getFenceEpoch(),
      runtimeGeneration: sink.getRuntimeGeneration(),
      controller: holder,
      scopeId: "s",
    });

    try {
      for (let i = 0; i < OP_COUNT; i++) {
        const kind = pick([
          "grant",
          "rejectable_accept",
          "accept",
          "fence_advance",
          "handoff",
          "concurrent_accepts",
        ] as const);
        ops.push(kind);

        if (kind === "grant") {
          effectSeq += 1;
          approvalSeq += 1;
          const effectId = `ge_${effectSeq}`;
          const approvalId = `ga_${approvalSeq}`;
          const digest = `d_${effectSeq}`;
          const g = sink.grant({
            effectId,
            actionDigest: digest,
            approvalId,
            decision: "grant",
            runtimeGeneration: sink.getRuntimeGeneration(),
            fenceEpoch: sink.getFenceEpoch(),
            controller: holder,
            scopeId: "s",
          });
          if (!g.accepted) throw new Error(`grant failed: ${g.reason}`);
          openGrants.push({
            approvalId,
            effectId,
            digest,
            gen: sink.getRuntimeGeneration(),
          });
        } else if (kind === "accept") {
          // Prefer an open grant at current gen; else grant+accept.
          let slot = openGrants.find((g) => g.gen === sink.getRuntimeGeneration());
          if (!slot) {
            effectSeq += 1;
            approvalSeq += 1;
            const effectId = `ge_${effectSeq}`;
            const approvalId = `ga_${approvalSeq}`;
            const digest = `d_${effectSeq}`;
            const g = sink.grant({
              effectId,
              actionDigest: digest,
              approvalId,
              decision: "grant",
              runtimeGeneration: sink.getRuntimeGeneration(),
              fenceEpoch: sink.getFenceEpoch(),
            });
            if (!g.accepted) throw new Error(`grant-for-accept failed: ${g.reason}`);
            slot = {
              approvalId,
              effectId,
              digest,
              gen: sink.getRuntimeGeneration(),
            };
            openGrants.push(slot);
          }
          const r = await sink.accept({
            effectId: slot.effectId,
            actionDigest: slot.digest,
            ...auth(),
            approval: { approval_id: slot.approvalId },
          });
          if (!r.accepted) throw new Error(`accept failed: ${r.reason}`);
          const idx = openGrants.indexOf(slot);
          if (idx >= 0) openGrants.splice(idx, 1);
        } else if (kind === "rejectable_accept") {
          // Stale fence / wrong holder / unknown approval — expect reject.
          const mode = pick(["stale_fence", "not_holder", "unknown_approval"] as const);
          effectSeq += 1;
          const effectId = `gr_${effectSeq}`;
          let reason: string | undefined;
          if (mode === "stale_fence") {
            // Need a grant so we pass approval checks after fence — actually
            // stale_fence is checked before approval. Omit approval ok? missing_approval
            // comes after fence check... fence is checked before approval.
            const r = await sink.accept({
              effectId,
              actionDigest: "d_reject",
              fenceEpoch: sink.getFenceEpoch() - 1,
              runtimeGeneration: sink.getRuntimeGeneration(),
              controller: holder,
              scopeId: "s",
              approval: { approval_id: "nope" },
            });
            reason = r.reason;
            if (r.accepted) throw new Error("expected stale_fence reject");
            if (reason !== "stale_fence") throw new Error(`expected stale_fence got ${reason}`);
          } else if (mode === "not_holder") {
            const r = await sink.accept({
              effectId,
              actionDigest: "d_reject",
              ...auth(),
              controller: "not_" + holder,
              approval: { approval_id: "nope" },
            });
            reason = r.reason;
            if (r.accepted) throw new Error("expected not_holder reject");
            if (reason !== "not_holder") throw new Error(`expected not_holder got ${reason}`);
          } else {
            const r = await sink.accept({
              effectId,
              actionDigest: "d_reject",
              ...auth(),
              approval: { approval_id: `missing_${effectSeq}` },
            });
            reason = r.reason;
            if (r.accepted) throw new Error("expected unknown_approval reject");
            if (reason !== "unknown_approval") {
              throw new Error(`expected unknown_approval got ${reason}`);
            }
          }
        } else if (kind === "fence_advance") {
          const nextEpoch = sink.getFenceEpoch() + 1;
          const nextGen = sink.getRuntimeGeneration() + (rng() < 0.5 ? 1 : 0);
          const r = sink.fence({
            fenceEpoch: nextEpoch,
            ...(nextGen > sink.getRuntimeGeneration()
              ? { runtimeGeneration: nextGen }
              : {}),
          });
          if (!r.ok) throw new Error(`fence_advance failed: ${r.reason}`);
          // Open grants at old gen become unusable (approval_generation_mismatch).
          for (let j = openGrants.length - 1; j >= 0; j--) {
            if (openGrants[j]!.gen !== sink.getRuntimeGeneration()) {
              openGrants.splice(j, 1);
            }
          }
        } else if (kind === "handoff") {
          const next = holder === "c1" ? "c2" : "c1";
          const r = sink.fence({
            scopeId: "s",
            holder: next,
            // optionally bump gen
            ...(rng() < 0.3
              ? { runtimeGeneration: sink.getRuntimeGeneration() + 1 }
              : {}),
          });
          if (!r.ok) throw new Error(`handoff failed: ${r.reason}`);
          holder = next;
          for (let j = openGrants.length - 1; j >= 0; j--) {
            if (openGrants[j]!.gen !== sink.getRuntimeGeneration()) {
              openGrants.splice(j, 1);
            }
          }
        } else if (kind === "concurrent_accepts") {
          // Delay-mode: grant one effect, race same effectId (idempotent resent).
          effectSeq += 1;
          approvalSeq += 1;
          const effectId = `gc_${effectSeq}`;
          const approvalId = `ga_${approvalSeq}`;
          const digest = `d_${effectSeq}`;
          const g = sink.grant({
            effectId,
            actionDigest: digest,
            approvalId,
            decision: "grant",
            runtimeGeneration: sink.getRuntimeGeneration(),
            fenceEpoch: sink.getFenceEpoch(),
          });
          if (!g.accepted) throw new Error(`concurrent grant failed: ${g.reason}`);
          sink.setFaultMode("delay", 15);
          const base = {
            effectId,
            actionDigest: digest,
            ...auth(),
            approval: { approval_id: approvalId },
          };
          const [a, b] = await Promise.all([sink.accept(base), sink.accept(base)]);
          sink.setFaultMode("none");
          const committed = [a, b].filter(
            (r) => r.accepted && r.receipt?.outcome === "committed" && !r.resent,
          );
          const resent = [a, b].filter((r) => r.resent === true);
          if (sink.getCommitCount() < 1) throw new Error("concurrent: no commit");
          if (committed.length + resent.length < 2 && ![a, b].every((r) => r.accepted)) {
            // One first commit + one resent, or both accepted via resent path.
            const okish = [a, b].filter((r) => r.accepted);
            if (okish.length < 2) {
              throw new Error(
                `concurrent accept failed: ${JSON.stringify([a.reason, b.reason, a.resent, b.resent])}`,
              );
            }
          }
        }
      }

      const ledger = sink.exportLedger();
      const head = sink.getLastEvidenceHash();
      const chain = verify_chain(ledger, head);
      if (!chain.ok) {
        throw new Error(`verify_chain failed: ${chain.reason} breakAt=${chain.breakAt}`);
      }
      const cross = verifyCrossRecords(sink.exportAgentEffectRecords());
      if (!cross.ok) {
        throw new Error(
          `verifyCrossRecords failed: ${cross.violations.map((v) => v.code).join(",")}`,
        );
      }

      // Tamper suite: corrupt one committed record → verifier must report violation.
      const committedIdxs = ledger
        .map((r, i) => (r.outcome === "committed" ? i : -1))
        .filter((i) => i >= 0);
      if (committedIdxs.length === 0) {
        // Force one commit so tamper has a target.
        effectSeq += 1;
        approvalSeq += 1;
        const effectId = `gt_${effectSeq}`;
        const approvalId = `ga_${approvalSeq}`;
        sink.grant({
          effectId,
          actionDigest: "d_tamper",
          approvalId,
          decision: "grant",
          runtimeGeneration: sink.getRuntimeGeneration(),
          fenceEpoch: sink.getFenceEpoch(),
        });
        const r = await sink.accept({
          effectId,
          actionDigest: "d_tamper",
          ...auth(),
          approval: { approval_id: approvalId },
        });
        if (!r.accepted) throw new Error(`tamper setup accept failed: ${r.reason}`);
      }
      const ledger2 = sink.exportLedger();
      const cIdx =
        ledger2.map((r, i) => (r.outcome === "committed" ? i : -1)).filter((i) => i >= 0)[
          Math.floor(rng() * Math.max(1, ledger2.filter((r) => r.outcome === "committed").length))
        ] ?? ledger2.findIndex((r) => r.outcome === "committed");
      if (cIdx < 0) throw new Error("no committed record to tamper");
      const field = pick(["runtimeGeneration", "actionDigest"] as const);
      const tampered = ledger2.map((r, i) => {
        if (i !== cIdx) return { ...r };
        if (field === "runtimeGeneration") {
          return { ...r, runtimeGeneration: r.runtimeGeneration + 99 };
        }
        return { ...r, actionDigest: r.actionDigest + "_TAMPER" };
      });
      // Re-link chain pointers so only content tamper is tested via cross-verify /
      // or leave chain broken — task: verifier must report violation.
      // Prefer cross-verify on exported agent-effect shape with content corruption.
      const records = sink.exportAgentEffectRecords().map((rec, i) => {
        // Map ledger index to export index (same order).
        if (i !== cIdx) return { ...rec };
        if (field === "runtimeGeneration") {
          return { ...rec, runtime_generation: rec.runtime_generation + 99 };
        }
        return { ...rec, action_digest: rec.action_digest + "_TAMPER" };
      });
      const bad = verifyCrossRecords(records);
      if (bad.ok) {
        throw new Error(`tamper of ${field} at ${cIdx} did not produce violation`);
      }
      // Also: chain with content change but unbroken pointers should still change
      // final hash vs expected head.
      const chainTamper = verify_chain(tampered, sink.getLastEvidenceHash());
      // Pointers still match structurally but record hashes change → final head differs
      // OR intermediate break if we didn't recompute. Either ok=false or head_mismatch.
      if (chainTamper.ok) {
        throw new Error("tampered ledger still verified against original head");
      }
    } catch (e) {
      // On failure print seed + op sequence (required).
      // eslint-disable-next-line no-console
      console.error(
        `GENERATIVE FAIL seed=${SEED} opCount=${ops.length} ops=${JSON.stringify(ops)}`,
      );
      throw e;
    }
  });
});
