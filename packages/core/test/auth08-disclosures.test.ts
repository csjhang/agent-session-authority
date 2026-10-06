import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  count_english_words,
  load_auth08_disclosures,
} from "../src/auth08_disclosures.js";

function write_tmp(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-auth08-disc-"));
  const p = path.join(dir, "disclosures.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
}

const base_entry = {
  bypass_path_id: "mode:bypassPermissions",
  quote: "Bypass permissions mode will skip all permission prompts.",
  url: "https://example.invalid/docs",
  retrieved: "2026-10-06 Asia/Taipei",
  section: "Permission modes",
  doc_product_version: "0.0.0",
  version_relationship: "matches pinned_version",
  kind: "bypass",
  verification: { status: "found" },
};

describe("count_english_words", () => {
  it("trims and splits on whitespace", () => {
    expect(count_english_words("  one two  three ")).toBe(3);
    expect(count_english_words("")).toBe(0);
    expect(count_english_words("   ")).toBe(0);
  });
  it("25 words = 25, 26 words = 26", () => {
    expect(count_english_words(words(25))).toBe(25);
    expect(count_english_words(words(26))).toBe(26);
  });
});

describe("load_auth08_disclosures", () => {
  it("accepts 25-word quote and matching target", () => {
    const p = write_tmp({
      target: "synthetic",
      pinned_version: "0.0.0",
      entries: [{ ...base_entry, quote: words(25) }],
    });
    const d = load_auth08_disclosures(p, { target: "synthetic" });
    expect(d.entries).toHaveLength(1);
    expect(count_english_words(d.entries[0]!.quote)).toBe(25);
  });

  it("rejects 26-word quote", () => {
    const p = write_tmp({
      target: "synthetic",
      pinned_version: "0.0.0",
      entries: [{ ...base_entry, quote: words(26) }],
    });
    expect(() => load_auth08_disclosures(p, { target: "synthetic" })).toThrow(
      /quote exceeds 25 English words at entries\[0\] \(got 26\)/,
    );
  });

  it("rejects empty quote", () => {
    const p = write_tmp({
      target: "synthetic",
      pinned_version: "0.0.0",
      entries: [{ ...base_entry, quote: "   " }],
    });
    expect(() => load_auth08_disclosures(p, { target: "synthetic" })).toThrow(
      /quote empty at entries\[0\]/,
    );
  });

  it("rejects target mismatch", () => {
    const p = write_tmp({
      target: "other",
      pinned_version: "0.0.0",
      entries: [],
    });
    expect(() => load_auth08_disclosures(p, { target: "synthetic" })).toThrow(
      /disclosures target mismatch: file=other expect=synthetic/,
    );
  });

  it("rejects schema failure (missing required)", () => {
    const p = write_tmp({ target: "synthetic" });
    expect(() => load_auth08_disclosures(p, { target: "synthetic" })).toThrow(
      /disclosures schema validation failed/,
    );
  });

  it("rejects empty bypass_path_id after trim", () => {
    const p = write_tmp({
      target: "synthetic",
      pinned_version: "0.0.0",
      entries: [{ ...base_entry, bypass_path_id: "  " }],
    });
    expect(() => load_auth08_disclosures(p, { target: "synthetic" })).toThrow(
      /bypass_path_id empty at entries\[0\]/,
    );
  });
});
