import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run_cli } from "../src/cli_run.js";
import { run_checkers } from "../src/index.js";
import type { HistoryEvent } from "../src/history.js";

function capture_run(argv: string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const code = run_cli(argv, { cwd, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

describe("CLI routes history vocabulary warnings through io.stderr", () => {
  it("unknown op: warning is captured on io.stderr and --json stdout is still pure JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-pr6g-"));
    const history = path.join(dir, "h.jsonl");
    fs.writeFileSync(history, '{"seq":1,"kind":"ok","op":"custom.unknown_op","attrs":{}}\n');
    const { code, stdout, stderr } = capture_run(["node", "asa", "check", history, "--json"], dir);
    expect(code).toBe(0);
    expect(stderr).toMatch(/unknown op "custom\.unknown_op"/);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe("AUTH-06 writes one sentence per event", () => {
  const auth06 = (events: HistoryEvent[]) =>
    run_checkers(events, null, { test_basis: "synthetic_fixture" }).find((f) => f.invariant === "AUTH-06")!;

  it("dispatch status=completed without a committed receipt: violation with only the 'Effect marked' sentence", () => {
    const f = auth06([{ seq: 1, kind: "ok", op: "effect.dispatch", attrs: { effect_id: "e1", status: "completed" } }]);
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(/Effect marked completed without trusted committed EffectReceipt for e1/);
    expect(f.explanation).not.toMatch(/Implicit success/);
  });

  it("dispatch status=dispatched with effect_status=committed and no receipt: still a violation (Implicit success)", () => {
    const f = auth06([
      { seq: 1, kind: "ok", op: "effect.dispatch", attrs: { effect_id: "e1", status: "dispatched", effect_status: "committed" } },
    ]);
    expect(f.observed_result).toBe("violation");
    expect(f.explanation).toMatch(/Implicit success without committed EffectReceipt at seq=1/);
  });
});
