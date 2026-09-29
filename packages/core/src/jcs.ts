/**
 * Minimal RFC 8785 JSON Canonicalization Scheme (JCS).
 * Enough for object/array/string/number/bool/null agent-effect fixtures.
 * Lone UTF-16 surrogates are rejected (they would otherwise UTF-8 as U+FFFD
 * and collide with a real U+FFFD in action_digest).
 */

/** True if `s` contains a UTF-16 lone surrogate (high without low, or low without high). */
export function containsLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function escapeString(s: string): string {
  if (containsLoneSurrogate(s)) {
    throw new Error("JCS: lone surrogate is not permitted");
  }
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      default:
        if (c < 0x20) {
          out += `\\u${c.toString(16).padStart(4, "0")}`;
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

/** ECMAScript NumberToJSON / JCS number production for finite numbers. */
function serializeNumber(n: number): string {
  if (Object.is(n, -0)) return "0";
  if (!Number.isFinite(n)) {
    throw new Error("JCS: NaN and Infinity are not permitted");
  }
  // JSON.stringify already follows the ES NumberToString rules JCS relies on.
  return JSON.stringify(n);
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return serializeNumber(value as number);
  if (t === "string") return escapeString(value as string);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const body = keys.map((k) => `${escapeString(k)}:${canonicalize(obj[k])}`).join(",");
    return `{${body}}`;
  }
  throw new Error(`JCS: unsupported type ${t}`);
}
