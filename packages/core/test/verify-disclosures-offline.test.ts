/**
 * Offline tests for the AUTH-08 citation matcher (scripts/lib/disclosure-verify.ts).
 * Hand-made fictional pages only; no network.
 */
import { describe, expect, it } from "vitest";
import {
  collapse_whitespace,
  decode_entities,
  fetch_url_for,
  normalize,
  page_kind,
  quote_found_in_page,
  sha256_hex,
  taipei_iso,
  verification_notes,
} from "../../../scripts/lib/disclosure-verify.js";

describe("verify-disclosures offline matcher (HTML)", () => {
  it("exact substring → found", () => {
    expect(quote_found_in_page("<p>Hello world foo</p>", "Hello world", "html")).toBe(true);
  });

  it("entities are decoded on the page (and in the quote)", () => {
    expect(quote_found_in_page("<p>A &amp; B</p>", "A & B", "html")).toBe(true);
    expect(quote_found_in_page("<p>it&#39;s &#x27;x&#x27; &quot;y&quot;</p>", `it's 'x' "y"`, "html")).toBe(true);
    expect(quote_found_in_page("<p>A &amp; B</p>", "A &amp; B", "html")).toBe(true);
  });

  it("whitespace runs (spaces, newline, tab) collapse to one space", () => {
    expect(quote_found_in_page("<p>A   \n\t B</p>", "A B", "html")).toBe(true);
  });

  it("script and style elements are dropped whole; other tags are stripped", () => {
    const page = "<style>.x{}</style><script>var q = 'Hidden quote';</script><p>Visible <b>bold</b> text</p>";
    expect(quote_found_in_page(page, "Hidden quote", "html")).toBe(false);
    expect(quote_found_in_page(page, "Visible bold text", "html")).toBe(true);
  });

  it("non-adjacent fragments spliced together → not_found", () => {
    expect(quote_found_in_page("<p>foo bar baz</p>", "foo baz", "html")).toBe(false);
  });

  it("quote absent from the page → not_found", () => {
    expect(quote_found_in_page("<p>Nothing relevant here.</p>", "Always ask", "html")).toBe(false);
  });

  it("no other normalization: case, punctuation and quote style must match exactly", () => {
    expect(quote_found_in_page("<p>Always ask before making changes</p>", "always ask before making changes", "html")).toBe(false);
    expect(quote_found_in_page("<p>Accepts all permissions.</p>", "Accepts all permissions!", "html")).toBe(false);
    expect(quote_found_in_page("<p>it\u2019s</p>", "it's", "html")).toBe(false);
  });

  it("an empty or whitespace-only quote never matches", () => {
    expect(quote_found_in_page("<p>x</p>", "   ", "html")).toBe(false);
  });
});

describe("verify-disclosures offline matcher (markdown and plain text)", () => {
  it("markdown link [text](url) is reduced to its text", () => {
    const md = "| `bypassPermissions` | Skips prompts, except for the [actions no mode auto-approves](/docs/en/x#y) |";
    expect(quote_found_in_page(md, "except for the actions no mode auto-approves", "markdown")).toBe(true);
    expect(quote_found_in_page("[actions no mode auto-approves](/x)", "actions no mode auto-approves", "markdown")).toBe(true);
  });

  it("inline-code backticks are removed on both page and quote", () => {
    const md = "In addition, `acceptEdits` mode auto-approves `mkdir`, `touch`, and `sed`.";
    expect(quote_found_in_page(md, "`acceptEdits` mode auto-approves `mkdir`, `touch`, and `sed`", "markdown")).toBe(true);
    expect(quote_found_in_page(md, "acceptEdits mode auto-approves mkdir, touch, and sed", "markdown")).toBe(true);
  });

  it("whitespace across lines collapses (soft-wrapped markdown)", () => {
    const md = "Claude Code checks the redirect target\nagainst your file   rules\n\n as if";
    expect(quote_found_in_page(md, "Claude Code checks the redirect target against your file rules as if", "markdown")).toBe(true);
  });

  it("markdown pages are not HTML-stripped and plain text is only whitespace-collapsed", () => {
    expect(normalize("a <b>x</b> &amp; [t](u) `c`", "markdown")).toBe("a <b>x</b> &amp; t c");
    expect(normalize('  description: "Always ask before making changes",\n', "text")).toBe(
      'description: "Always ask before making changes",',
    );
    expect(quote_found_in_page('description: "Accepts all permissions",', "Accepts all permissions", "text")).toBe(true);
    expect(quote_found_in_page("[Accepts](x) all", "Accepts all", "text")).toBe(false);
  });

  it("spliced markdown fragments still do not match", () => {
    expect(quote_found_in_page("Reads, file edits, and commands", "Reads, and commands", "markdown")).toBe(false);
  });
});

describe("verify-disclosures helpers", () => {
  it("code.claude.com is fetched as the .md sibling; other URLs as-is", () => {
    expect(fetch_url_for("https://code.claude.com/docs/en/permissions")).toBe("https://code.claude.com/docs/en/permissions.md");
    expect(fetch_url_for("https://code.claude.com/docs/en/permission-modes.md")).toBe(
      "https://code.claude.com/docs/en/permission-modes.md",
    );
    const raw = "https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/v0.75.1/src/session-mode.ts";
    expect(fetch_url_for(raw)).toBe(raw);
  });

  it("page kind follows content type, then the .md extension", () => {
    expect(page_kind("text/html; charset=utf-8", "https://x.test/a")).toBe("html");
    expect(page_kind("text/markdown; charset=utf-8", "https://x.test/a")).toBe("markdown");
    expect(page_kind("text/plain", "https://x.test/a.md")).toBe("markdown");
    expect(page_kind("text/plain; charset=utf-8", "https://x.test/a.ts")).toBe("text");
  });

  it("entity decoding, whitespace collapse, notes and timestamp format", () => {
    expect(decode_entities("&lt;a&gt; &nbsp;&unknown;")).toBe("<a> \u00a0&unknown;");
    expect(collapse_whitespace(" a\u00a0\n b ")).toBe("a b");
    expect(verification_notes("https://x.test/a.md", "abc", "text/markdown")).toBe(
      `fetched=https://x.test/a.md; sha256=${sha256_hex("abc")}; content_type=text/markdown`,
    );
    expect(sha256_hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(taipei_iso(new Date("2026-10-08T19:00:00Z"))).toBe("2026-10-09T03:00:00+08:00");
  });
});
