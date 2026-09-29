/**
 * Multi-seed generative test for the enforce-mode sink.
 *
 * Every seed runs one short random sequence; after each sequence the evidence
 * chain (with expected head) and verifyCrossRecords on the agent-effect export
 * must both be ok. Each sequence also tampers one committed record's
 * runtime_generation and action_digest, and the verifier must catch both.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MockEffectSink, verify_chain, type ApprovalBinding, type SinkSnapshot } from "../src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const SEEDS = 300;
const OPS_PER_SEQUENCE = 25;

const KINDS = [
  "grant",
  "grant_deny",
  "deny_existing",
  "accept",
  "accept_resend",
  "bad_digest",
  "bad_ctrl",
  "stale_fence",
  "bad_gen",
  "unknown_appr",
  "wrong_effect",
  "fence_gen",
  "fence_epoch",
  "handoff",
  "snapshot",
  "restore",
  "concurrent",
  "failed_outcome",
] as const;

/** Reasons the sink must produce at least once across all seeds. */
const EXPECTED_REASONS = [
  "unknown_approval",
  "generation_mismatch",
  "approval_generation_mismatch",
  "approval_digest_mismatch",
  "stale_fence",
  "not_holder",
  "approval_effect_mismatch",
  "approval_denied",
  "digest_mismatch",
  "effect_denied",
];

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

const appr = (approval_id: string) => ({ approval_id }) as unknown as ApprovalBinding;

describe("multi-seed generative enforce sequences", () => {
  it(
    `${SEEDS} seeds x ${OPS_PER_SEQUENCE} ops: chain+cross ok per sequence; tamper always detected`,
    async () => {
      const mod = await import(
        pathToFileURL(join(repoRoot, "spec/vectors/agent-effect/cross-verify.ts")).href
      );
      const verifyCrossRecords = mod.verifyCrossRecords as (
        recs: unknown[],
        options?: { requireIssuance?: boolean },
      ) => {
        ok: boolean;
        violations: { code: string }[];
      };
      const crossOpts = { requireIssuance: true };

      const failures: string[] = [];
      const reasonsSeen = new Set<string>();
      let tamperChecks = 0;

      for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = makeRng(seed);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
        let tick = 0;
        const sink = new MockEffectSink({
          enforce: true,
          holders: { ws: "c1" },
          clock: () => new Date(Date.UTC(2026, 8, 29, 0, 0, 0, ++tick)).toISOString(),
        });
        let holder = "c1";
        let n = 0;
        const grants: { a: string; e: string; d: string }[] = [];
        const snaps: SinkSnapshot[] = [];
        const ops: string[] = [];
        const auth = (o: Record<string, unknown> = {}) => ({
          controller: holder,
          scopeId: "ws",
          fenceEpoch: sink.getFenceEpoch(),
          runtimeGeneration: sink.getRuntimeGeneration(),
          ...o,
        });
        const note = (r: { reason?: string }) => {
          if (r.reason) reasonsSeen.add(r.reason);
        };

        try {
          for (let i = 0; i < OPS_PER_SEQUENCE; i++) {
            const k = pick(KINDS);
            ops.push(k);
            const g = grants.length ? pick(grants) : undefined;
            switch (k) {
              case "grant":
              case "grant_deny": {
                n += 1;
                const e = `e${n}`;
                const d = `d${n}`;
                const a = `a${n}`;
                sink.grant({
                  effectId: e,
                  actionDigest: d,
                  approvalId: a,
                  decision: k === "grant" ? "grant" : "deny",
                });
                grants.push({ a, e, d });
                break;
              }
              case "deny_existing": {
                if (g) {
                  n += 1;
                  const a = `a${n}`;
                  sink.grant({
                    effectId: g.e,
                    actionDigest: g.d,
                    approvalId: a,
                    decision: "deny",
                  });
                  grants.push({ a, e: g.e, d: g.d });
                }
                break;
              }
              case "accept":
              case "accept_resend":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: g.d, approval: appr(g.a), ...auth() }));
                break;
              case "bad_digest":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: `X${g.d}`, approval: appr(g.a), ...auth() }));
                break;
              case "bad_ctrl":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: g.d, approval: appr(g.a), ...auth({ controller: "mallory" }) }));
                break;
              case "stale_fence":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: g.d, approval: appr(g.a), ...auth({ fenceEpoch: sink.getFenceEpoch() - 1 }) }));
                break;
              case "bad_gen":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: g.d, approval: appr(g.a), ...auth({ runtimeGeneration: sink.getRuntimeGeneration() + 1 }) }));
                break;
              case "unknown_appr":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: g.d, approval: appr("nope"), ...auth() }));
                break;
              case "wrong_effect":
                if (g) note(await sink.accept({ effectId: `${g.e}x`, actionDigest: g.d, approval: appr(g.a), ...auth() }));
                break;
              case "fence_gen":
                sink.fence({ runtimeGeneration: sink.getRuntimeGeneration() + 1 });
                break;
              case "fence_epoch":
                sink.fence({ fenceEpoch: sink.getFenceEpoch() + 1 });
                break;
              case "handoff":
                holder = holder === "c1" ? "c2" : "c1";
                sink.fence({ scopeId: "ws", holder });
                break;
              case "snapshot":
                snaps.push(sink.snapshot());
                break;
              case "restore":
                if (snaps.length) sink.restore(pick(snaps));
                break;
              case "concurrent":
                if (g) {
                  sink.setFaultMode("delay", 3);
                  const req = { effectId: g.e, actionDigest: g.d, approval: appr(g.a), ...auth() };
                  (await Promise.all([sink.accept(req), sink.accept(req)])).forEach(note);
                  sink.setFaultMode("none");
                }
                break;
              case "failed_outcome":
                if (g) note(await sink.accept({ effectId: g.e, actionDigest: g.d, approval: appr(g.a), forceOutcome: "failed", ...auth() }));
                break;
            }
          }

          const chain = verify_chain(sink.exportLedger(), sink.getLastEvidenceHash());
          const records = sink.exportAgentEffectRecords() as unknown as Record<string, unknown>[];
          const cross = verifyCrossRecords(records, crossOpts);
          if (!chain.ok || !cross.ok) {
            failures.push(
              `seed=${seed} chain_ok=${chain.ok} chain_reason=${chain.reason ?? ""} violations=${cross.violations
                .map((v) => v.code)
                .join(",")} ops=${ops.join(",")}`,
            );
            continue;
          }

          const ci = records.findIndex((r) => r.outcome === "committed");
          if (ci >= 0) {
            for (const field of ["runtime_generation", "action_digest"] as const) {
              const tampered = records.map((r) => ({ ...r }));
              tampered[ci]![field] =
                field === "action_digest" ? "TAMPERED" : (tampered[ci]![field] as number) + 7;
              tamperChecks += 1;
              if (verifyCrossRecords(tampered, crossOpts).ok) {
                failures.push(`seed=${seed} tamper ${field} at record ${ci} not detected ops=${ops.join(",")}`);
              }
            }
            // Tamper approval_id across effects when another approval exists.
            const otherAppr = records.find(
              (r, i) =>
                i !== ci &&
                typeof r.approval_id === "string" &&
                r.approval_id !== records[ci]!.approval_id,
            );
            if (otherAppr && records[ci]!.approval_id) {
              const swapped = records.map((r) => ({ ...r }));
              swapped[ci] = { ...swapped[ci]!, approval_id: otherAppr.approval_id };
              tamperChecks += 1;
              if (verifyCrossRecords(swapped, crossOpts).ok) {
                failures.push(
                  `seed=${seed} tamper approval_id at record ${ci} not detected ops=${ops.join(",")}`,
                );
              }
            }
          }
        } catch (e) {
          failures.push(`seed=${seed} threw ${(e as Error).message} ops=${ops.join(",")}`);
        }
      }

      if (failures.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`GENERATIVE FAIL (${failures.length})\n${failures.slice(0, 10).join("\n")}`);
      }
      expect(failures).toEqual([]);
      expect(tamperChecks).toBeGreaterThan(100);
      for (const reason of EXPECTED_REASONS) {
        expect(reasonsSeen.has(reason), `reason never produced: ${reason}`).toBe(true);
      }
    },
    120_000,
  );
});
