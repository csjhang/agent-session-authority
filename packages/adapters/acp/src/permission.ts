/** session/request_permission option parsing + allow/deny/always picks. */

export type PermissionPickMode = "allow" | "deny" | "allow_always" | "reject_always" | "hold";
export type OptionHit = { id: string; kind: string };

export function parse_permission_options(options: unknown): OptionHit[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const x = v as Record<string, unknown>;
    const id = x.optionId ?? x.option_id ?? x.id;
    return typeof id === "string" ? [{ id, kind: String(x.kind ?? "") }] : [];
  });
}

export function pick_allow_option_id(options: unknown): string | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["allow_once", "allow_always", "allow"]) {
    const hit = values.find((x) => x.id === preferred || x.kind === preferred || x.id.replace(/-/g, "_") === preferred);
    if (hit) return hit.id;
  }
  return values.find((x) => /allow/i.test(x.id) && !/deny|reject|cancel/i.test(x.id))?.id;
}

/**
 * Prefer explicit allow_always / allow-always kind.
 * claude-agent-acp Write typically offers optionId=allow-with-updates with kind=allow_always
 * when a durableChangeSet is present; otherwise the option may be absent.
 */
export function pick_allow_always_option_id(options: unknown): string | undefined {
  return pick_allow_always_option(options)?.id;
}

/** Return optionId + kind for allow_always selection (for notes/history attrs). */
export function pick_allow_always_option(options: unknown): OptionHit | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["allow_always", "allow-always"]) {
    const norm = preferred.replace(/-/g, "_");
    const hit = values.find(
      (x) =>
        x.kind === preferred ||
        x.kind === norm ||
        x.kind.replace(/-/g, "_") === norm ||
        x.id === preferred ||
        x.id.replace(/-/g, "_") === norm,
    );
    if (hit) return hit;
  }
  // ACP filesystem Write uses optionId allow-with-updates with kind allow_always
  const by_updates = values.find((x) => x.id === "allow-with-updates" || x.id === "allow_with_updates");
  if (by_updates && /allow_always|allow-always/i.test(by_updates.kind)) return by_updates;
  return undefined;
}


/** Prefer explicit reject_always / reject-always kind (strict; no reject_once fallback). */
export function pick_reject_always_option_id(options: unknown): string | undefined {
  return pick_reject_always_option(options)?.id;
}

/** Return optionId + kind for reject_always selection (for notes/history attrs). */
export function pick_reject_always_option(options: unknown): OptionHit | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["reject_always", "reject-always"]) {
    const norm = preferred.replace(/-/g, "_");
    const hit = values.find(
      (x) =>
        x.kind === preferred ||
        x.kind === norm ||
        x.kind.replace(/-/g, "_") === norm ||
        x.id === preferred ||
        x.id.replace(/-/g, "_") === norm,
    );
    if (hit) return hit;
  }
  return undefined;
}

/** Prefer explicit ACP reject/deny option (claude-agent-acp uses optionId=reject, kind=reject_once). */
export function pick_deny_option_id(options: unknown): string | undefined {
  const values = parse_permission_options(options);
  for (const preferred of ["reject", "reject_once", "deny", "reject_always", "cancel"]) {
    const hit = values.find((x) => x.id === preferred || x.kind === preferred || x.id.replace(/-/g, "_") === preferred);
    if (hit) return hit.id;
  }
  return values.find((x) => /deny|reject|cancel/i.test(x.id) || /deny|reject|cancel/i.test(x.kind))?.id;
}

export function option_kind_for_id(options: unknown, option_id: string): string | undefined {
  return parse_permission_options(options).find((x) => x.id === option_id)?.kind;
}
