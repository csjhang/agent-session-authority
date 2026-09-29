import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MockEffectSink,
  hash_receipt,
  start_sink_server,
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
    const grant = {
      approval_id: "appr_x",
      action_digest: "d1",
      runtime_generation: 3,
      decision: "grant" as const,
    };
    const stale = await sink.accept({
      effectId: "e_stale",
      actionDigest: "d1",
      fenceEpoch: 4,
      runtimeGeneration: 3,
      controller: "alice",
      scopeId: "scope_a",
      approval: grant,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe("stale_fence");

    const gen = await sink.accept({
      effectId: "e_gen",
      actionDigest: "d1",
      fenceEpoch: 5,
      runtimeGeneration: 2,
      controller: "alice",
      scopeId: "scope_a",
      approval: { ...grant, runtime_generation: 2 },
    });
    expect(gen.accepted).toBe(false);
    expect(gen.reason).toBe("generation_mismatch");

    const nh = await sink.accept({
      effectId: "e_nh",
      actionDigest: "d1",
      fenceEpoch: 5,
      runtimeGeneration: 3,
      controller: "bob",
      scopeId: "scope_a",
      approval: grant,
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

    const old = await sink.accept({
      effectId: "e_handoff",
      actionDigest: "d1",
      fenceEpoch: 2,
      runtimeGeneration: 2,
      controller: "alice",
      scopeId: "scope_a",
      approval: {
        approval_id: "appr_h",
        action_digest: "d1",
        runtime_generation: 2,
        decision: "grant",
      },
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

describe("PR-2: enforce approval binding", () => {
  function enforced() {
    return new MockEffectSink({
      enforce: true,
      fenceEpoch: 1,
      runtimeGeneration: 1,
      holders: { s: "c1" },
    });
  }

  it("missing_approval / approval_denied / digest / generation / reused", async () => {
    const sink = enforced();
    const base = {
      fenceEpoch: 1,
      runtimeGeneration: 1,
      controller: "c1",
      scopeId: "s",
    };

    const missing = await sink.accept({ effectId: "e_m", actionDigest: "d", ...base });
    expect(missing.reason).toBe("missing_approval");

    const denied = await sink.accept({
      effectId: "e_d",
      actionDigest: "d",
      ...base,
      approval: {
        approval_id: "a1",
        action_digest: "d",
        runtime_generation: 1,
        decision: "deny",
      },
    });
    expect(denied.reason).toBe("approval_denied");

    const dig = await sink.accept({
      effectId: "e_ad",
      actionDigest: "d",
      ...base,
      approval: {
        approval_id: "a2",
        action_digest: "other",
        runtime_generation: 1,
        decision: "grant",
      },
    });
    expect(dig.reason).toBe("approval_digest_mismatch");

    const gen = await sink.accept({
      effectId: "e_ag",
      actionDigest: "d",
      ...base,
      approval: {
        approval_id: "a3",
        action_digest: "d",
        runtime_generation: 0,
        decision: "grant",
      },
    });
    expect(gen.reason).toBe("approval_generation_mismatch");

    const first = await sink.accept({
      effectId: "e_ok",
      actionDigest: "d",
      ...base,
      approval: {
        approval_id: "a_shared",
        action_digest: "d",
        runtime_generation: 1,
        decision: "grant",
      },
    });
    expect(first.accepted).toBe(true);
    expect(first.receipt?.approvalId).toBe("a_shared");

    const reused = await sink.accept({
      effectId: "e_other",
      actionDigest: "d2",
      ...base,
      approval: {
        approval_id: "a_shared",
        action_digest: "d2",
        runtime_generation: 1,
        decision: "grant",
      },
    });
    expect(reused.reason).toBe("approval_reused");
  });
});

describe("PR-2: evidence hash (JCS)", () => {
  it("same receipt different key order → same hash; previousEvidenceHash excluded but chains", () => {
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

    // Chain into next: next.previousEvidenceHash = this hash; next's own hash differs by other fields.
    const h1 = hash_receipt(base);
    const next: EffectReceipt = {
      ...base,
      effectId: "e2",
      previousEvidenceHash: h1,
    };
    const nextAlt: EffectReceipt = {
      ...base,
      effectId: "e2",
      previousEvidenceHash: "ffffffffffffffff",
    };
    // Changing previousEvidenceHash alone does not change this record's hash.
    expect(hash_receipt(next)).toBe(hash_receipt(nextAlt));
    // But the chain pointer is still carried on the receipt for the next link.
    expect(next.previousEvidenceHash).toBe(h1);
    expect(next.previousEvidenceHash).not.toBe(nextAlt.previousEvidenceHash);
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

    const c = await sink.accept({
      effectId: "eff-1",
      actionDigest: "sha256:deadbeef",
      runtimeGeneration: 1,
      fenceEpoch: 1,
      controller: "alice",
      scopeId: "scope_a",
      approval: {
        approval_id: "appr-1",
        action_digest: "sha256:deadbeef",
        runtime_generation: 1,
        decision: "grant",
      },
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
      approval: {
        approval_id: "appr-2",
        action_digest: "sha256:cafe",
        runtime_generation: 2,
        decision: "grant",
      },
    });
    expect(old.accepted).toBe(false);
    expect(old.reason).toBe("not_holder");
    expect(old.receipt?.outcome).toBe("rejected");

    const records = sink.exportAgentEffectRecords();
    expect(records.every((r) => r.schema_version === "asa.agent-effect/0.1")).toBe(true);
    expect(records[0]!.stream_id).toBe("boundary/fs-gateway");
    expect(records.map((r) => r.sequence_number)).toEqual([1, 2, 3]);
    expect(records[1]!.approval_id).toBe("appr-1");
    expect(records[1]!.approval_runtime_generation).toBe(1);

    const crossPath = join(repoRoot, "spec/vectors/agent-effect/cross-verify.ts");
    const mod = await import(pathToFileURL(crossPath).href);
    const verifyCrossRecords = mod.verifyCrossRecords as (recs: unknown[]) => {
      ok: boolean;
      violations: { code: string }[];
    };

    const ok = verifyCrossRecords(records);
    expect(ok.ok).toBe(true);

    const corrupted = records.map((r, i) =>
      i === 1 ? { ...r, runtime_generation: 99 } : { ...r },
    );
    const bad = verifyCrossRecords(corrupted);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.code === "cross_generation_reuse")).toBe(true);

    // HTTP JSONL export
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
    } finally {
      await srv.close();
    }
  });
});

describe("PR-2: jcs re-export still works for vectors", () => {
  it("spec jcs re-exports canonicalize from core", async () => {
    const jcsPath = join(repoRoot, "spec/vectors/agent-effect/jcs.ts");
    // file exists and is a re-export
    const src = readFileSync(jcsPath, "utf8");
    expect(src).toMatch(/packages\/core\/src\/jcs/);
    const { canonicalize } = await import(pathToFileURL(jcsPath).href);
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
