#!/usr/bin/env tsx
/**
 * Manual AUTH-08 citation check: for every entry of a disclosures.json, fetch the cited page and
 * test whether the quote appears on it word for word. Writes only `verification`
 * (status, verified_at, notes) back into the same file; page bodies are never stored.
 *
 *   pnpm exec tsx scripts/verify-disclosures.ts [targets/claude-agent-acp/disclosures.json]
 *
 * - Manual only: not run in CI and never called by `asa check` or the vector generator
 *   (they read verification.status and never touch the network).
 * - code.claude.com URLs are fetched as the same path with `.md` appended (the docs publish a
 *   markdown copy of each page); every other URL is fetched as-is.
 * - Normalization and matching: scripts/lib/disclosure-verify.ts (HTML tags/entities, markdown
 *   links and inline-code backticks, whitespace; nothing else).
 * - notes: `fetched=<url actually fetched>; sha256=<hex of the normalized page>; content_type=<...>`.
 * - Exit code 1 if any entry is not_found; 2 on a usage or file error.
 *
 * Pages that need JavaScript to render: there is no headless browser here. Such a page
 * normalizes to an empty or partial body, so the quote is not found and the entry becomes
 * not_found; cite a statically fetchable copy instead (a `.md` sibling, a raw.githubusercontent.com
 * tag URL) rather than weakening the match.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load_auth08_disclosures, type Auth08Disclosures } from "../packages/core/src/auth08_disclosures.js";
import {
  fetch_url_for,
  normalize,
  page_kind,
  quote_found_in_page,
  taipei_iso,
  verification_notes,
  type PageKind,
} from "./lib/disclosure-verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "..");

type Fetched =
  | { ok: true; fetched: string; body: string; content_type: string; kind: PageKind }
  | { ok: false; fetched: string; error: string };

async function fetch_page(url: string): Promise<Fetched> {
  const fetched = fetch_url_for(url);
  try {
    const res = await fetch(fetched, {
      redirect: "follow",
      headers: { "user-agent": "agent-session-authority verify-disclosures (manual citation check)" },
    });
    if (!res.ok) return { ok: false, fetched, error: `HTTP ${res.status}` };
    const content_type = res.headers.get("content-type") ?? "unknown";
    const body = await res.text();
    return { ok: true, fetched, body, content_type, kind: page_kind(content_type, fetched) };
  } catch (err) {
    return { ok: false, fetched, error: String(err instanceof Error ? err.message : err) };
  }
}

async function main(): Promise<number> {
  const arg = process.argv[2] ?? "targets/claude-agent-acp/disclosures.json";
  const file = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  let raw: Auth08Disclosures;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Auth08Disclosures;
    // Schema + ≤25-word + non-empty field checks (same loader as asa check).
    load_auth08_disclosures(file, { target: raw.target, pinned_version: raw.pinned_version });
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 2;
  }

  const pages = new Map<string, Promise<Fetched>>();
  let not_found = 0;
  for (let i = 0; i < raw.entries.length; i++) {
    const entry = raw.entries[i]!;
    if (!pages.has(entry.url)) pages.set(entry.url, fetch_page(entry.url));
    const page = await pages.get(entry.url)!;
    const verified_at = taipei_iso();
    if (!page.ok) {
      entry.verification = { status: "not_found", verified_at, notes: `fetched=${page.fetched}; error=${page.error}` };
    } else {
      const found = quote_found_in_page(page.body, entry.quote, page.kind);
      entry.verification = {
        status: found ? "found" : "not_found",
        verified_at,
        notes: verification_notes(page.fetched, normalize(page.body, page.kind), page.content_type),
      };
    }
    if (entry.verification.status !== "found") not_found++;
    console.log(`entries[${i}] ${entry.bypass_path_id} ${entry.verification.status} — ${entry.verification.notes}`);
  }

  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
  console.log(`wrote ${path.relative(repo_root, file) || file}: ${raw.entries.length - not_found} found, ${not_found} not_found`);
  return not_found > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
