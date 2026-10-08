/**
 * Pure helpers for scripts/verify-disclosures.ts (AUTH-08 citation check).
 *
 * No network and no file I/O here, so the matching rules can be tested offline.
 * Normalization is deliberately minimal:
 * - HTML: drop <script>/<style> elements whole, strip every other tag, decode entities;
 * - markdown: `[text](url)` → `text`, drop the backticks around inline code;
 * - every kind (including plain text): collapse each run of whitespace to one space, trim.
 * Nothing else (no case folding, no punctuation or quote-style changes, no stemming).
 * The same normalization is applied to the quote and to the page; the quote must then be an
 * exact substring of the page.
 */
import { createHash } from "node:crypto";

export type PageKind = "html" | "markdown" | "text";

/** code.claude.com pages are fetched as the same path with `.md` appended; other URLs as-is. */
export function fetch_url_for(url: string): string {
  const u = new URL(url);
  if (u.hostname === "code.claude.com" && !u.pathname.endsWith(".md")) {
    u.pathname = `${u.pathname.replace(/\/+$/, "")}.md`;
    return u.toString();
  }
  return url;
}

/** Page kind from the response content type, falling back to the fetched URL's extension. */
export function page_kind(content_type: string | null | undefined, fetched_url: string): PageKind {
  const ct = (content_type ?? "").toLowerCase();
  if (ct.includes("html")) return "html";
  if (ct.includes("markdown")) return "markdown";
  if (new URL(fetched_url).pathname.endsWith(".md")) return "markdown";
  return "text";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  rarr: "\u2192",
  larr: "\u2190",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

/** Decode numeric (&#39; &#x27;) and common named entities; unknown names are left untouched. */
export function decode_entities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
      return String.fromCodePoint(cp);
    }
    const v = NAMED_ENTITIES[body];
    return v ?? whole;
  });
}

/** Collapse every run of whitespace (Unicode \s, including NBSP) to one space and trim. */
export function collapse_whitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** HTML → text: drop script/style elements, strip remaining tags, decode entities. */
export function strip_html(s: string): string {
  const no_script = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const no_comments = no_script.replace(/<!--[\s\S]*?-->/g, "");
  const no_tags = no_comments.replace(/<[^>]*>/g, "");
  return decode_entities(no_tags);
}

/** Markdown → text: `[text](url)` → `text`; inline code `` `x` `` → `x`. */
export function strip_markdown(s: string): string {
  const no_links = s.replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1");
  return no_links.replace(/(`+)([^`]+?)\1(?!`)/g, "$2");
}

/** Normalize page text or a quote for the given page kind (see module comment). */
export function normalize(s: string, kind: PageKind): string {
  let t = s;
  if (kind === "html") t = strip_html(t);
  else if (kind === "markdown") t = strip_markdown(t);
  return collapse_whitespace(t);
}

/** True iff the normalized quote is a non-empty exact substring of the normalized page. */
export function quote_found_in_page(page: string, quote: string, kind: PageKind): boolean {
  const q = normalize(quote, kind);
  if (q.length === 0) return false;
  return normalize(page, kind).includes(q);
}

export function sha256_hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** ISO-8601 timestamp in Asia/Taipei (UTC+08:00, no DST), e.g. 2026-10-09T03:12:45+08:00. */
export function taipei_iso(d: Date = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.toISOString().slice(0, 19)}+08:00`;
}

/** verification.notes for a fetched page. */
export function verification_notes(fetched: string, normalized_page: string, content_type: string): string {
  return `fetched=${fetched}; sha256=${sha256_hex(normalized_page)}; content_type=${content_type}`;
}
