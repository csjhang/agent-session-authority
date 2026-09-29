import { describe, expect, it } from "vitest";
import { action_digest } from "../src/action_digest.js";

const BASE = {
  action_type: "tool.Write",
  target: "/ws/a.txt",
  args: { file_path: "/ws/a.txt", content: "Aa" },
  policy_version: "acp-permission-ext" as string | null,
};

describe("action_digest goldens", () => {
  it("Aa content golden", () => {
    expect(action_digest({ ...BASE, args: { file_path: "/ws/a.txt", content: "Aa" } })).toBe(
      "sha256:4cc15102a073ec265532e1c404594766a84e1cea82a75228b3828a41d2ac1f0e",
    );
  });

  it("BB content golden", () => {
    expect(action_digest({ ...BASE, args: { file_path: "/ws/a.txt", content: "BB" } })).toBe(
      "sha256:8a5eb83a3a10243cf8bca1f39e57190cb254307213c0bd3d14d56534d7aa4db9",
    );
  });

  it("null policy_version golden", () => {
    expect(
      action_digest({
        action_type: "tool.Write",
        target: "/ws/a.txt",
        args: { file_path: "/ws/a.txt", content: "Aa" },
        policy_version: null,
      }),
    ).toBe("sha256:c28aa104f86c1cb379528ed5c660cb836d0aaf97083d8799e2abc2c8dc431654");
  });

  it("key order scrambled (incl. inside args) → same digest", () => {
    const a = action_digest({
      policy_version: "acp-permission-ext",
      args: { content: "Aa", file_path: "/ws/a.txt" },
      target: "/ws/a.txt",
      action_type: "tool.Write",
    });
    const b = action_digest({
      action_type: "tool.Write",
      target: "/ws/a.txt",
      args: { file_path: "/ws/a.txt", content: "Aa" },
      policy_version: "acp-permission-ext",
    });
    expect(a).toBe(b);
    expect(a).toBe("sha256:4cc15102a073ec265532e1c404594766a84e1cea82a75228b3828a41d2ac1f0e");
  });

  it("format /^sha256:[0-9a-f]{64}$/", () => {
    expect(action_digest(BASE)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("args containing NaN throws", () => {
    expect(() =>
      action_digest({
        action_type: "tool.Write",
        target: "/ws/a.txt",
        args: { n: Number.NaN },
        policy_version: null,
      }),
    ).toThrow();
  });
});
