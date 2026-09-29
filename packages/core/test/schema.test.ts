import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate_json } from "../src/schema.js";

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function load_schema(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repo_root, "spec", name), "utf8"));
}

function walk_json_files(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk_json_files(full, pred));
    else if (ent.isFile() && pred(ent.name)) out.push(full);
  }
  return out;
}

describe("validate_json against repo profiles and assessments", () => {
  const profile_schema = load_schema("authority-profile.schema.json");
  const assessment_schema = load_schema("authority-assessment.schema.json");

  it("all corpus/*/profile.json validate", () => {
    const profiles = walk_json_files(path.join(repo_root, "corpus"), (n) => n === "profile.json");
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      const value = JSON.parse(fs.readFileSync(p, "utf8"));
      const errs = validate_json(profile_schema, value);
      expect(errs, p).toEqual([]);
    }
  });

  it("all targets/*/authority-assessment.json and findings/**/authority-assessment.json validate", () => {
    const files = [
      ...walk_json_files(path.join(repo_root, "targets"), (n) => n === "authority-assessment.json"),
      ...walk_json_files(path.join(repo_root, "findings"), (n) => n === "authority-assessment.json"),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const p of files) {
      const value = JSON.parse(fs.readFileSync(p, "utf8"));
      const errs = validate_json(assessment_schema, value);
      expect(errs, p).toEqual([]);
    }
  });
});

describe("validate_json counterexamples", () => {
  const profile_schema = load_schema("authority-profile.schema.json");
  const assessment_schema = load_schema("authority-assessment.schema.json");

  it("claimed_invariants string → errors include /claimed_invariants", () => {
    const errs = validate_json(profile_schema, { claimed_invariants: "AUTH-02" });
    expect(errs.some((e) => e.includes("/claimed_invariants"))).toBe(true);
  });

  it('generation_model "G3" → errors', () => {
    const errs = validate_json(profile_schema, { generation_model: "G3" });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("/generation_model") || e.includes("G3"))).toBe(true);
  });

  it("scope_map row missing scope_id → errors", () => {
    const errs = validate_json(profile_schema, {
      scope_map: [{ action_type: "a", target: "t" }],
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("scope_id") || e.includes("/scope_map"))).toBe(true);
  });

  it("scope_map unknown field → errors", () => {
    const errs = validate_json(profile_schema, {
      scope_map: [{ action_type: "a", target: "t", scope_id: "s", extra: 1 }],
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("extra") || e.includes("additional"))).toBe(true);
  });

  it("test_basis not in enum → errors", () => {
    const errs = validate_json(assessment_schema, { test_basis: "live" });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("/test_basis"))).toBe(true);
  });

  it('schema with "minimum" → validate_json throws', () => {
    expect(() => validate_json({ type: "number", minimum: 0 }, 1)).toThrow(/minimum/);
  });
});

describe("validate_json schema-walk and Object.hasOwn", () => {
  it('nested unsupported keyword "minimum" under properties throws even when data is {}', () => {
    const schema = {
      type: "object",
      properties: {
        generation_model: { type: "string", minimum: 0 },
      },
    };
    expect(() => validate_json(schema, {})).toThrow(/minimum/);
  });

  it('required:["constructor"] on {} → error /constructor missing (Object.hasOwn, not in)', () => {
    const schema = {
      type: "object",
      required: ["constructor"],
      properties: {
        constructor: { type: "string" },
      },
    };
    const errs = validate_json(schema, {});
    expect(errs.some((e) => e.includes("/constructor") && /missing|required/i.test(e))).toBe(true);
  });
});

describe("validate_json RFC 6901 pointer escape", () => {
  it("escapes / as ~1 and ~ as ~0 in error paths", () => {
    const schema = {
      type: "object",
      properties: {
        "a/b": { type: "string" },
        "c~d": { type: "string" },
      },
    };
    const errs = validate_json(schema, { "a/b": 1, "c~d": 2 });
    expect(errs.some((e) => e.startsWith("/a~1b"))).toBe(true);
    expect(errs.some((e) => e.startsWith("/c~0d"))).toBe(true);
  });
});
