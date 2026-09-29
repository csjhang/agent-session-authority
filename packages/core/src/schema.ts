/**
 * Minimal JSON Schema validator for keywords used in spec/*.schema.json.
 * No external deps. Returns JSON-pointer + reason strings; unknown keywords throw.
 */

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "enum",
  "properties",
  "additionalProperties",
  "items",
  "required",
]);

/** RFC 6901 JSON Pointer: ~ → ~0, / → ~1 (tilde first). */
function escape_pointer_segment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function child_pointer(pointer: string, segment: string): string {
  return `${pointer}/${escape_pointer_segment(segment)}`;
}

function is_object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function type_of(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matches_type(v: unknown, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  return type_of(v) === t;
}

/**
 * Walk the entire schema tree (independent of data) and throw on unsupported keywords.
 * Recurses into properties values, object-form additionalProperties, and items.
 */
function assert_supported_keywords_tree(schema: unknown, pointer: string): void {
  if (!is_object(schema)) {
    throw new Error(`schema at ${pointer || "/"} must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(
        `unsupported JSON Schema keyword "${key}" at ${pointer || "/"} (validator supports only: ${[...SUPPORTED_KEYWORDS].join(", ")})`,
      );
    }
  }
  if (is_object(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      assert_supported_keywords_tree(child, `${pointer}/properties/${escape_pointer_segment(key)}`);
    }
  }
  if ("additionalProperties" in schema) {
    const ap = schema.additionalProperties;
    if (is_object(ap)) {
      assert_supported_keywords_tree(ap, `${pointer}/additionalProperties`);
    }
  }
  if ("items" in schema) {
    assert_supported_keywords_tree(schema.items, `${pointer}/items`);
  }
}

function validate_against(
  schema: unknown,
  value: unknown,
  pointer: string,
  errors: string[],
): void {
  if (!is_object(schema)) {
    throw new Error(`schema at ${pointer || "/"} must be an object`);
  }

  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.every((t) => typeof t === "string")) {
      throw new Error(`schema type at ${pointer || "/"} must be string or string[]`);
    }
    if (!types.some((t) => matches_type(value, t as string))) {
      errors.push(
        `${pointer || "/"}: expected type ${types.join("|")}, got ${type_of(value)}`,
      );
      return;
    }
  }

  if ("enum" in schema) {
    if (!Array.isArray(schema.enum)) {
      throw new Error(`schema enum at ${pointer || "/"} must be an array`);
    }
    if (!schema.enum.some((opt) => Object.is(opt, value) || (opt === value))) {
      // deep-ish equality via JSON for objects/arrays; primitive Object.is above
      const ok = schema.enum.some((opt) => {
        try {
          return JSON.stringify(opt) === JSON.stringify(value);
        } catch {
          return false;
        }
      });
      if (!ok) {
        errors.push(
          `${pointer || "/"}: value not in enum ${JSON.stringify(schema.enum)}`,
        );
      }
    }
  }

  if ("properties" in schema || "additionalProperties" in schema || "required" in schema) {
    if (!is_object(value)) {
      // type check already reported if type was set; otherwise report
      if (!("type" in schema)) {
        errors.push(`${pointer || "/"}: expected object`);
      }
      return;
    }
    const props = is_object(schema.properties) ? schema.properties : {};
    if ("required" in schema) {
      if (!Array.isArray(schema.required)) {
        throw new Error(`schema required at ${pointer || "/"} must be an array`);
      }
      for (const key of schema.required) {
        if (typeof key !== "string") continue;
        if (!Object.hasOwn(value, key)) {
          errors.push(`${child_pointer(pointer, key)}: required property missing`);
        }
      }
    }
    for (const [key, child_schema] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) {
        validate_against(child_schema, value[key], child_pointer(pointer, key), errors);
      }
    }
    if ("additionalProperties" in schema) {
      const ap = schema.additionalProperties;
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(props, key)) continue;
        if (ap === false) {
          errors.push(`${child_pointer(pointer, key)}: additional property not allowed`);
        } else if (ap === true || ap === undefined) {
          // allow
        } else {
          validate_against(ap, value[key], child_pointer(pointer, key), errors);
        }
      }
    }
  }

  if ("items" in schema) {
    if (!Array.isArray(value)) {
      if (!("type" in schema)) {
        errors.push(`${pointer || "/"}: expected array`);
      }
      return;
    }
    for (let i = 0; i < value.length; i++) {
      validate_against(schema.items, value[i], `${pointer}/${i}`, errors);
    }
  }
}

/**
 * Validate `value` against `schema`. Returns a list of "pointer: reason" strings.
 * Throws if the schema uses an unsupported keyword (whole-tree walk, independent of data).
 */
export function validate_json(schema: unknown, value: unknown): string[] {
  assert_supported_keywords_tree(schema, "");
  const errors: string[] = [];
  validate_against(schema, value, "", errors);
  return errors;
}
