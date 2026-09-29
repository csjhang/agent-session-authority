#!/usr/bin/env tsx
/**
 * For each target with a history artifact, run asa check and emit
 * targets/<target>/results/capability_vector.json.
 *
 * Hand-written explanations live in the `notes` field (and optional
 * per-invariant `explanation`). Live-derived conclusions for
 * claude-agent-acp are recorded as not_tested — withdrawn pending
 * re-run with the fixed multi-generation adapter. Wording: not
 * supported by reproducible evidence (not "found a defect").
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load_history_file } from "../packages/core/src/history.js";
import { load_profile } from "../packages/core/src/declaration.js";
import { load_assessment, default_assessment } from "../packages/core/src/assessment.js";
import { run_checkers } from "../packages/core/src/index.js";
import { build_report } from "../packages/core/src/report.js";

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
      "WITHDRAWN (2026-09-29): previously published live permission-axis conclusions are not supported by reproducible evidence — the published live history does not encode runtime generation, the restart fault, approval↔action binding, or effect receipts, so asa check cannot reproduce those conclusions. Pending re-run with the fixed adapter. See AUTH_*_LIVE.md / LIVE_CAPPED.md status blocks and README.",
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

const TARGETS: Array<{
  id: string;
  history: string;
  assessment?: string;
  extra?: Record<string, unknown>;
}> = [
  {
    id: "claude-agent-acp",
    history: "targets/claude-agent-acp/results/history-fixture.jsonl",
    assessment: "targets/claude-agent-acp/authority-assessment.json",
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

function main(): void {
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
    const profile = load_profile(undefined);
    const findings = run_checkers(events, profile, assessment);
    const report = build_report(findings, assessment, profile);

    // Live-derived path for claude-agent-acp: do not promote live conclusions;
    // record withdrawal on the notes axis. Fixture asa-check results remain.
    const notes = HAND_NOTES[t.id];
    const explanation: Record<string, string> = { ...(notes?.invariants ?? {}) };
    for (const f of findings) {
      if (!explanation[f.invariant] && f.explanation) {
        explanation[f.invariant] = f.explanation;
      }
    }

    const out = {
      target: t.id,
      profile_version: report.profile_version,
      test_basis: report.test_basis,
      ...t.extra,
      capability_vector: report.capability_vector,
      claim_status_vector: report.claim_status_vector,
      explanation,
      notes: notes
        ? {
            summary: notes.summary,
            ...(notes.live_status ? { live_status: notes.live_status } : {}),
          }
        : undefined,
      history_artifact: t.history,
      generated_by: "scripts/generate-capability-vectors.ts",
      generated_at: "2026-09-29",
    };

    const out_path = path.join(repo_root, "targets", t.id, "results", "capability_vector.json");
    fs.mkdirSync(path.dirname(out_path), { recursive: true });
    fs.writeFileSync(out_path, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`wrote ${path.relative(repo_root, out_path)}`);
  }
}

main();
