import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run_checkers } from "../src/index.js";
import type { HistoryEvent } from "../src/history.js";
import { generate_all } from "../../../scripts/generate-capability-vectors.js";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Fake live run folder: corpus/acp-shaped/<corpus>.jsonl copied to history.jsonl plus run.json.
 * a1-reask-after-restart → AUTH-02 supported (AUTH-01b supported, AUTH-06 supported, AUTH-07 inconclusive)
 * a3-deny-then-committed → AUTH-02 violation
 */
function make_run(root: string, scenario: string, run_id: string, corpus: string | null, manifest: Record<string, unknown> | string = {}) {
  const dir = path.join(root, scenario, run_id);
  fs.mkdirSync(dir, { recursive: true });
  if (corpus) fs.copyFileSync(path.join(repo_root, "corpus", "acp-shaped", `${corpus}.jsonl`), path.join(dir, "history.jsonl"));
  const body =
    typeof manifest === "string"
      ? manifest
      : JSON.stringify({ run_valid: true, invalid_reasons: [], package_version_observed: "0.75.1", ...manifest });
  fs.writeFileSync(path.join(dir, "run.json"), body);
  return dir;
}

function acp_doc(runs_root: string) {
  const doc = generate_all({ write: false, live_runs_root: runs_root }).find((d) => d.target === "claude-agent-acp")!;
  expect(doc).toBeTruthy();
  return doc;
}

const history_of = (root: string, scenario: string, run_id: string) =>
  path.relative(repo_root, path.join(root, scenario, run_id, "history.jsonl")).split(path.sep).join("/");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr7a-runs-"));

describe("claude-agent-acp capability vector from live runs", () => {
  it("no live run folders: every capability label is not_tested, capability_basis is null, no sources", () => {
    const doc = acp_doc(tmp());
    expect(new Set(Object.values(doc.capability_vector))).toEqual(new Set(["not_tested"]));
    expect(new Set(Object.values(doc.observed_vector))).toEqual(new Set(["not_tested"]));
    expect(doc.capability_basis).toBeNull();
    expect(doc.capability_sources).toEqual({});
    expect(doc.live_runs).toEqual({ included: [], excluded: [], disagreements: [] });
  });

  it("three agreeing runs of one scenario: AUTH-02 observed supported, capability not_declared (not graded), sources are exactly those runs", () => {
    const root = tmp();
    for (const id of ["r1", "r2", "r3"]) make_run(root, "effect", id, "a1-reask-after-restart");
    const doc = acp_doc(root);
    const runs = ["r1", "r2", "r3"].map((id) => history_of(root, "effect", id));
    expect(doc.capability_basis).toBe("research_profile");
    expect(doc.observed_vector["AUTH-02"]).toBe("supported");
    expect(doc.capability_vector["AUTH-02"]).toBe("not_declared");
    expect(doc.capability_sources["AUTH-02"]).toEqual(runs);
    expect(doc.observed_vector["AUTH-03a"]).toBe("inconclusive");
    expect(doc.capability_vector["AUTH-03a"]).toBe("inconclusive");
    expect(doc.capability_sources["AUTH-03a"]).toEqual(runs);
    expect(doc.live_runs.included.map((r) => r.run_id)).toEqual(["r1", "r2", "r3"]);
    expect(doc.live_runs.disagreements).toEqual([]);
  });

  it("a consistent violation in one scenario wins over a consistent supported in another; sources are the violating runs only", () => {
    const root = tmp();
    for (const id of ["r1", "r2", "r3"]) make_run(root, "effect", id, "a1-reask-after-restart");
    for (const id of ["r1", "r2", "r3"]) make_run(root, "stale-effect", id, "a3-deny-then-committed");
    const doc = acp_doc(root);
    expect(doc.observed_vector["AUTH-02"]).toBe("violation");
    expect(doc.capability_vector["AUTH-02"]).toBe("not_declared");
    expect(doc.capability_sources["AUTH-02"]).toEqual(["r1", "r2", "r3"].map((id) => history_of(root, "stale-effect", id)));
  });

  it("runs of one scenario disagree: reported per run (no majority vote) and the invariant is inconclusive", () => {
    const root = tmp();
    make_run(root, "stale-grant", "r1", "a1-reask-after-restart");
    make_run(root, "stale-grant", "r2", "a1-reask-after-restart");
    make_run(root, "stale-grant", "r3", "a3-deny-then-committed");
    const doc = acp_doc(root);
    expect(doc.observed_vector["AUTH-02"]).toBe("inconclusive");
    expect(doc.capability_vector["AUTH-02"]).toBe("inconclusive");
    expect(doc.live_runs.disagreements).toContainEqual({
      invariant: "AUTH-02",
      scenario: "stale-grant",
      runs: { r1: "supported", r2: "supported", r3: "violation" },
    });
    expect(doc.capability_sources["AUTH-02"]).toEqual(["r1", "r2", "r3"].map((id) => history_of(root, "stale-grant", id)));
  });

  it("a disagreement in one scenario plus a consistent violation in another: violation, and the disagreement is still reported", () => {
    const root = tmp();
    make_run(root, "stale-grant", "r1", "a1-reask-after-restart");
    make_run(root, "stale-grant", "r2", "a3-deny-then-committed");
    for (const id of ["r1", "r2"]) make_run(root, "stale-effect", id, "a3-deny-then-committed");
    const doc = acp_doc(root);
    expect(doc.observed_vector["AUTH-02"]).toBe("violation");
    expect(doc.capability_sources["AUTH-02"]).toEqual(["r1", "r2"].map((id) => history_of(root, "stale-effect", id)));
    expect(doc.live_runs.disagreements.some((d) => d.invariant === "AUTH-02" && d.scenario === "stale-grant")).toBe(true);
  });

  it("invalid runs are excluded with reasons and never counted", () => {
    const root = tmp();
    make_run(root, "effect", "bad-valid", "a3-deny-then-committed", { run_valid: false, invalid_reasons: ["claude-agent-acp agentInfo.version=missing != pinned 0.75.1"] });
    make_run(root, "effect", "bad-version", "a3-deny-then-committed", { package_version_observed: "0.75.0" });
    make_run(root, "effect", "bad-history", null);
    make_run(root, "effect", "bad-manifest", "a3-deny-then-committed", "{not json");
    const doc = acp_doc(root);
    expect(doc.live_runs.included).toEqual([]);
    const reasons = Object.fromEntries(doc.live_runs.excluded.map((r) => [r.run_id, r.reasons.join(" | ")]));
    expect(reasons["bad-valid"]).toMatch(/run_valid is not true: claude-agent-acp agentInfo\.version=missing/);
    expect(reasons["bad-version"]).toMatch(/package_version_observed=0\.75\.0 != pinned 0\.75\.1/);
    expect(reasons["bad-history"]).toMatch(/history\.jsonl missing/);
    expect(reasons["bad-manifest"]).toMatch(/run\.json unreadable/);
    expect(new Set(Object.values(doc.capability_vector))).toEqual(new Set(["not_tested"]));
    expect(doc.capability_basis).toBeNull();
  });

  it("probe-derived or unexamined invariants are never promoted even when every run observes supported", () => {
    const root = tmp();
    for (const id of ["r1", "r2", "r3"]) make_run(root, "effect", id, "a1-reask-after-restart");
    const doc = acp_doc(root);
    for (const inv of ["AUTH-01b", "AUTH-06"]) {
      expect(doc.live_runs.included.every((r) => r.observed[inv] === "supported")).toBe(true);
      expect(doc.observed_vector[inv]).toBe("not_tested");
      expect(doc.capability_vector[inv]).toBe("not_tested");
      expect(doc.capability_sources[inv]).toBeUndefined();
    }
    expect(doc.capability_exclusions["AUTH-01b"]).toMatch(/probe-derived/);
    expect(doc.capability_exclusions["AUTH-06"]).toMatch(/not examined/);
    expect(doc.capability_exclusions["AUTH-07"]).toMatch(/^held back:/);
    expect(Object.keys(doc.capability_exclusions).sort()).toEqual(["AUTH-01a", "AUTH-01b", "AUTH-01c", "AUTH-06", "AUTH-07", "AUTH-08"]);
  });

  it("AUTH-07 observed supported in the committed reject-always/r1 live run (adapter receipt + injected restart only) is never promoted", () => {
    const root = tmp();
    const dir = path.join(root, "reject-always", "r1");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.join(repo_root, "targets/claude-agent-acp/results/live-runs/reject-always/r1/history.jsonl"),
      path.join(dir, "history.jsonl"),
    );
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({ run_valid: true, invalid_reasons: [], package_version_observed: "0.75.1" }),
    );
    const doc = acp_doc(root);
    expect(doc.live_runs.included.map((r) => r.observed["AUTH-07"])).toEqual(["supported"]);
    expect(doc.observed_vector["AUTH-07"]).toBe("not_tested");
    expect(doc.capability_vector["AUTH-07"]).toBe("not_tested");
    expect(doc.capability_sources["AUTH-07"]).toBeUndefined();
  });

  it("other targets have no live configuration: all not_tested and no exclusions", () => {
    const docs = generate_all({ write: false, live_runs_root: tmp() }).filter((d) => d.target !== "claude-agent-acp");
    expect(docs.length).toBe(3);
    for (const d of docs) {
      expect(new Set(Object.values(d.capability_vector))).toEqual(new Set(["not_tested"]));
      expect(d.capability_exclusions).toEqual({});
      expect(d.capability_basis).toBeNull();
    }
  });
});

describe("AUTH-01b derived-generation note", () => {
  it("adapter issuer (acp_adapter_live) without field_provenance still gets the 'derived by probe' note", () => {
    const events: HistoryEvent[] = [
      { seq: 1, kind: "observe", op: "generation.observe", attrs: { runtime_generation: 1, issuer_id: "acp_adapter_live", runtime_id: "r" } },
      { seq: 2, kind: "fault", fault: "runtime.restart", attrs: { runtime_id: "r" } },
      { seq: 3, kind: "observe", op: "generation.observe", attrs: { runtime_generation: 2, issuer_id: "acp_adapter_live", runtime_id: "r" } },
    ];
    const f = run_checkers(events, null, { test_basis: "synthetic_fixture" }).find((x) => x.invariant === "AUTH-01b")!;
    expect(f.observed_result).toBe("supported");
    expect(f.explanation).toMatch(/Note: generation derived by probe, not target-native\./);
  });
});
