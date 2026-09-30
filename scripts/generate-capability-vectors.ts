#!/usr/bin/env tsx
/**
 * For each target with a history artifact, run asa check and emit
 * targets/<target>/results/capability_vector.json.
 *
 * Separation of axes:
 * - `fixture_vector` — asa-check results against fixture history
 *   (adapter+checker self-consistency only; digests/fence_epoch may be
 *   adapter-synthesized).
 * - `capability_vector` — target capability labels from live evidence only
 *   (scripts/live-vector.ts): claim-rewritten under the target's live
 *   test_basis (`capability_basis`). `not_tested` where no admissible live
 *   evidence exists. Fixture asa-check results MUST NOT be promoted here.
 * - `observed_vector` — raw aggregated live observed_result per invariant.
 * - `capability_sources` — invariant → repo-relative live history.jsonl paths
 *   backing each non-`not_tested` capability label.
 * - `capability_exclusions` — invariant → why live runs can never promote it
 *   for this target (probe-derived or not examined by the adapter).
 * - `live_runs` — included runs (with per-run observed), excluded runs (with
 *   reasons) and per-scenario run disagreements (reported, never voted).
 * - `claim_status_vector` — from profile claims. `load_profile(undefined)`
 *   currently loads no target profile, so every invariant is
 *   `not_declared`.
 * - `checker_explanation` — verbatim explanations from the checker run.
 * - `notes.invariants` / `notes.summary` — handwritten notes; never
 *   overwritten by checker text (and vice versa).
 *
 * `generated_at` is the calendar date of the run (YYYY-MM-DD, Asia/Taipei).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load_history_file } from "../packages/core/src/history.js";
import { load_profile } from "../packages/core/src/declaration.js";
import { load_assessment, default_assessment } from "../packages/core/src/assessment.js";
import { run_checkers } from "../packages/core/src/index.js";
import { build_report } from "../packages/core/src/report.js";
import type { ResultLabel } from "../packages/core/src/assessment.js";
import { aggregate_live, load_live_runs, no_live_vector, type LiveConfig, type LiveVector } from "./live-vector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "..");

type NotesBlock = {
  summary: string;
  live_status?: string;
  invariants?: Record<string, string>;
};

const HAND_NOTES: Record<string, NotesBlock> = {
  "claude-agent-acp": {
    summary:
      "Fixture vector from asa check against history-fixture.jsonl. Public ACP docs do not declare portable ActionBinding+generation; digests and fence_epoch are adapter-synthesized for the probe.",
    live_status:
      "Re-run (PR-7b, 2026-09-30): 13 valid live runs under targets/claude-agent-acp/results/live-runs (see live_runs, observed_vector and capability_vector). The earlier live permission-axis conclusions (2026-09-06..14) remain WITHDRAWN and are not used as evidence.",
    invariants: {
      "AUTH-02":
        "Fixture maps ACP permission allow/deny to approval.grant/deny with synthesized action_digest; public docs describe permission extension but not canonical ActionBinding+generation binding. Measured fixture only.",
      "AUTH-05":
        "Permission responses are client-driven; fixture cannot show ControlLease vs Approver separation as first-class ACP objects.",
      "AUTH-04":
        "No fence token / fence epoch in public ACP agent surface observed in claim_sources.",
      "AUTH-06":
        "ACP agent alone does not emit native EffectReceipt; adapter may derive effect.receipt from wait_for_write_effect FS observation with field_provenance=derived.",
    },
  },
  "vscode-agent-host": {
    summary:
      "Fixture vector from asa check against history-fixture.jsonl (AHP mock peer). Digests/fence_epoch are adapter-synthesized; public AHP does not define portable RuntimeGeneration across host restart.",
    invariants: {
      "AUTH-02":
        "Fixture maps in-process first-wins tool confirmation to approval.grant with synthesized action_digest; public AHP docs do not define canonical ActionBinding+generation.",
      "AUTH-03":
        "Turn ownership is a weak mutex in public docs — underspecified vs ControlLease expiry/fencing.",
      "AUTH-01b":
        "Host process death is modeled as fault; cross-restart generation bump is not defined in public AHP — not_declared.",
      "AUTH-04": "No FenceToken/FenceEpoch in public AHP surface.",
      "AUTH-05": "No Approver!=Controller SoD as first-class AHP objects.",
      "AUTH-06": "AHP alone does not emit EffectReceipt.",
    },
  },
  ably: {
    summary:
      "Fixture vector from asa check against history-fixture.jsonl (MockAblyPeer). Cloud-only constraint; no air-gap / self-host path.",
    invariants: {
      "AUTH-02":
        "Fixture maps toolCallId HITL allow/deny to approval ops with synthesized digest; docs bind toolCallId/first-response-wins, not portable ActionDigest+generation.",
      "AUTH-01b":
        "Resume = new invocation; old approval validity across invocation undefined — not_declared for generation-bound restart.",
      "AUTH-05":
        "Multi-device approval possible; fixture cannot prove ControlLease vs Approver separation as first-class objects.",
      "AUTH-04": "No fence token in Ably AI Transport public surface.",
      "AUTH-06": "Transport does not emit EffectReceipt.",
    },
  },
  "acp-mux": {
    summary:
      "Fixture vector from asa check against history-fixture.jsonl (MockAcpMuxPeer / RFD #533 observation attach). Explicit non-claims: no fencing, lease, digest, generation, or revocation in acp-mux.",
    invariants: {
      "AUTH-02":
        "Pending permission re-issue on attach is observable; adapter synthesizes digest for probe only — acp-mux has no native ActionDigest+generation.",
      "AUTH-01": "No RuntimeGeneration in acp-mux — not_declared.",
      "AUTH-03": "No ControlLease — not_declared.",
      "AUTH-04": "No fencing — not_declared.",
      "AUTH-05": "Observation attach is not Approver/Controller SoD — not_declared.",
      "AUTH-06": "No EffectReceipt — not_declared.",
    },
  },
};

/**
 * claude-agent-acp live promotion rules. Listed invariants are never promoted from live runs
 * because the live history only reflects the probe itself (or the adapter never examines them).
 */
export const ACP_LIVE: LiveConfig = {
  runs_dir: "targets/claude-agent-acp/results/live-runs",
  pinned_version: "0.75.1",
  test_basis: "research_profile",
  exclusions: {
    "AUTH-01a": "profile-only: claude-agent-acp publishes no authority profile or generation_model",
    "AUTH-01b":
      "probe-derived: live runtime_generation is counted by the adapter from process spawns (issuer_id=acp_adapter_live), not reported by claude-agent-acp",
    "AUTH-01c": "probe-derived: the only generation issuer in live history is the adapter itself (acp_adapter_live)",
    "AUTH-06":
      "not examined: claude-agent-acp has no effect receipts of its own and reports tool completion before the probe checks the disk, so AUTH-06 (success only after a committed receipt) would flag every write by construction; whether its completed/failed reports match the disk is checked under AUTH-07",
    "AUTH-07":
      "held back: claude-agent-acp's own tool-call status is recorded as terminal events, but promotion waits until the live aggregation requires at least one claude-agent-acp-reported terminal among each supported run's witnesses",
    "AUTH-08": "no checker (always not_tested)",
  },
};

const TARGETS: Array<{
  id: string;
  history: string;
  assessment?: string;
  extra?: Record<string, unknown>;
  live?: LiveConfig;
}> = [
  {
    id: "claude-agent-acp",
    history: "targets/claude-agent-acp/results/history-fixture.jsonl",
    assessment: "targets/claude-agent-acp/authority-assessment.json",
    live: ACP_LIVE,
    extra: {
      mode: "FIXTURE",
      package_name: "@agentclientprotocol/claude-agent-acp",
      package_version_pinned: "0.75.1",
    },
  },
  {
    id: "vscode-agent-host",
    history: "targets/vscode-agent-host/results/history-fixture.jsonl",
    assessment: "targets/vscode-agent-host/authority-assessment.json",
    extra: {
      mode: "FIXTURE",
      protocol: "AHP",
      fixture_limitations: ["synthetic_fixture only", "no live Agent Host"],
    },
  },
  {
    id: "ably",
    history: "targets/ably/results/history-fixture.jsonl",
    assessment: "targets/ably/authority-assessment.json",
    extra: {
      mode: "FIXTURE",
      constraints: ["cloud_only", "no_air_gap"],
      fixture_limitations: ["synthetic_fixture only", "live path optional later with ABLY_API_KEY"],
    },
  },
  {
    id: "acp-mux",
    history: "targets/acp-mux/results/history-fixture.jsonl",
    assessment: "targets/acp-mux/authority-assessment.json",
    extra: {
      mode: "FIXTURE",
      fixture_limitations: ["RFD #533 observation-only semantics", "no fencing/lease/digest/generation"],
    },
  },
];

function today_ymd(): string {
  // Box clock is Asia/Taipei; prefer explicit Taipei calendar date.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type CapabilityVectorDoc = {
  target: string;
  profile_version: string;
  /** Basis of fixture_vector (synthetic_fixture). */
  test_basis: string;
  capability_vector: Record<string, ResultLabel>;
  /** Basis of capability_vector; null while no live run is included. */
  capability_basis: string | null;
  /**
   * For each capability_vector key that is not `not_tested`: repo-relative
   * non-fixture live history.jsonl paths that back the label (each must exist).
   */
  capability_sources: Record<string, string[]>;
  observed_vector: Record<string, ResultLabel>;
  capability_exclusions: Record<string, string>;
  live_runs: LiveVector["live_runs"];
  fixture_vector: Record<string, ResultLabel>;
  claim_status_vector: Record<string, string>;
  checker_explanation: Record<string, string>;
  notes?: {
    summary: string;
    live_status?: string;
    invariants?: Record<string, string>;
  };
  history_artifact: string;
  generated_by: string;
  generated_at: string;
  [extra: string]: unknown;
};

export function generate_all(opts: { write?: boolean; live_runs_root?: string } = {}): CapabilityVectorDoc[] {
  const write = opts.write !== false;
  const generated_at = today_ymd();
  const docs: CapabilityVectorDoc[] = [];

  for (const t of TARGETS) {
    const history_path = path.join(repo_root, t.history);
    if (!fs.existsSync(history_path)) {
      console.error(`SKIP ${t.id}: missing history ${t.history}`);
      continue;
    }
    const events = load_history_file(history_path, { warn_unknown_vocab: false });
    const assessment =
      load_assessment(t.assessment ? path.join(repo_root, t.assessment) : undefined) ??
      default_assessment();
    assessment.target = assessment.target ?? t.id;
    assessment.test_basis = assessment.test_basis ?? "synthetic_fixture";
    // No per-target profile path is loaded today → claim_status stays not_declared.
    const profile = load_profile(undefined);
    const findings = run_checkers(events, profile, assessment);
    const report = build_report(findings, assessment, profile);

    const checker_explanation: Record<string, string> = {};
    for (const f of findings) {
      if (f.explanation) checker_explanation[f.invariant] = f.explanation;
    }

    const notes = HAND_NOTES[t.id];

    // Target capability comes from live runs only (never from the fixture above).
    let live = no_live_vector();
    if (t.live) {
      const runs_root = opts.live_runs_root ?? path.join(repo_root, t.live.runs_dir);
      const { included, excluded } = load_live_runs(runs_root, repo_root, t.live, t.id);
      live = aggregate_live(included, excluded, t.live);
    }

    const out: CapabilityVectorDoc = {
      target: t.id,
      profile_version: report.profile_version,
      test_basis: report.test_basis,
      ...t.extra,
      // Target capability: live evidence only (not fixture asa-check).
      capability_vector: live.capability_vector,
      capability_basis: live.capability_basis,
      capability_sources: live.capability_sources,
      observed_vector: live.observed_vector,
      capability_exclusions: live.capability_exclusions,
      live_runs: live.live_runs,
      // Adapter+checker self-consistency against fixture history only.
      fixture_vector: report.capability_vector,
      claim_status_vector: report.claim_status_vector,
      checker_explanation,
      notes: notes
        ? {
            summary: notes.summary,
            ...(notes.live_status ? { live_status: notes.live_status } : {}),
            ...(notes.invariants ? { invariants: notes.invariants } : {}),
          }
        : undefined,
      history_artifact: t.history,
      generated_by: "scripts/generate-capability-vectors.ts",
      generated_at,
    };

    docs.push(out);

    if (write) {
      const out_path = path.join(repo_root, "targets", t.id, "results", "capability_vector.json");
      fs.mkdirSync(path.dirname(out_path), { recursive: true });
      fs.writeFileSync(out_path, JSON.stringify(out, null, 2) + "\n", "utf8");
      console.log(`wrote ${path.relative(repo_root, out_path)}`);
    }
  }
  return docs;
}

function main(): void {
  generate_all({ write: true });
}

const is_direct =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]!);
if (is_direct) {
  main();
}
