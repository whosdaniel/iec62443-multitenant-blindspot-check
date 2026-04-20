// Vanilla schema validator for architecture-v1.json.
//
// Implements just the JSON Schema Draft 2020-12 subset we use. The
// subset is pinned in KNOWN_SCHEMA_KEYWORDS below. If web/schema.js
// (or the Python-side JSON file it mirrors) grows a new keyword the
// validator hasn't been extended to handle, the walker throws loudly
// rather than silently pretending the new constraint is satisfied.
// That fail-closed posture protects the Python<->JS parity story: the
// Python side (jsonschema.Draft202012Validator) knows every keyword in
// the spec, so silent skipping on the JS side would leave a window
// where the Python CLI rejects malformed input while the browser
// accepts it.
//
// Referential-integrity checks that JSON Schema cannot express
// (duplicate ids, unknown cross-references) are mirrored from
// blindspotcheck/schema.py::_validate_referential_integrity below.
//
// Why vanilla: avoids adding Ajv (or any other validator) as a dependency.
// The schema surface is small and stable, so a ~180-line validator is a
// smaller attack surface than a general-purpose validator.

import { ARCHITECTURE_SCHEMA_V1 } from './schema.js';

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

export class InputTooLarge extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputTooLarge';
  }
}

export const MAX_INPUT_BYTES = 1 * 1024 * 1024; // 1 MiB, matches Python side.

// The exact set of JSON Schema Draft 2020-12 keywords this validator
// implements. Any other keyword appearing in a schema triggers a
// SchemaError at validation time. These are additionally allowed as
// annotations (title, description) or structural helpers ($schema, $id).
export const KNOWN_SCHEMA_KEYWORDS = Object.freeze(new Set([
  // Core / meta
  '$schema', '$id', '$ref', '$defs',
  'title', 'description',
  // Type + generic
  'type', 'enum',
  // String
  'pattern', 'minLength', 'maxLength',
  // Object
  'required', 'additionalProperties', 'properties',
  // Array
  'items', 'minItems', 'maxItems',
]));

/**
 * Validate `arch` against the bundled architecture schema and the
 * referential-integrity rules. Throws SchemaError on any failure.
 *
 * @param {object} arch  architecture dict (already JSON.parsed)
 * @param {object} [schema=ARCHITECTURE_SCHEMA_V1]  override for tests
 */
export function validateArchitecture(arch, schema = ARCHITECTURE_SCHEMA_V1) {
  const errors = [];
  validateNode(arch, schema, schema, [], errors);
  if (errors.length > 0) {
    const msg = errors
      .map((e) => `  ${e.path || '<root>'}: ${e.message}`)
      .join('\n');
    throw new SchemaError(`Schema validation failed:\n${msg}`);
  }
  validateReferentialIntegrity(arch);
}

function validateNode(value, subSchema, rootSchema, path, errors) {
  // Fail-closed on any schema keyword we have not implemented. Rationale
  // in KNOWN_SCHEMA_KEYWORDS docstring above.
  for (const key of Object.keys(subSchema)) {
    if (!KNOWN_SCHEMA_KEYWORDS.has(key)) {
      throw new SchemaError(
        `Unsupported JSON Schema keyword '${key}' at ${pathStr(path) || '<root>'}. ` +
        `The web validator implements a subset of Draft 2020-12; extend ` +
        `KNOWN_SCHEMA_KEYWORDS in web/schema-validator.js before using this keyword.`,
      );
    }
  }

  if (subSchema.$ref) {
    const resolved = resolveRef(subSchema.$ref, rootSchema);
    validateNode(value, resolved, rootSchema, path, errors);
    return;
  }

  if (subSchema.type) {
    if (!matchesType(value, subSchema.type)) {
      errors.push({
        path: pathStr(path),
        message: `expected type ${subSchema.type}, got ${typeOf(value)}`,
      });
      return;
    }
  }

  if (subSchema.enum) {
    if (!subSchema.enum.includes(value)) {
      errors.push({
        path: pathStr(path),
        message: `value ${JSON.stringify(value)} not in enum ${JSON.stringify(subSchema.enum)}`,
      });
    }
  }

  if (subSchema.pattern && typeof value === 'string') {
    if (!new RegExp(subSchema.pattern).test(value)) {
      errors.push({
        path: pathStr(path),
        message: `string '${value}' does not match pattern ${subSchema.pattern}`,
      });
    }
  }

  if (subSchema.maxLength !== undefined && typeof value === 'string') {
    if (value.length > subSchema.maxLength) {
      errors.push({
        path: pathStr(path),
        message: `string length ${value.length} exceeds maxLength ${subSchema.maxLength}`,
      });
    }
  }

  if (subSchema.minLength !== undefined && typeof value === 'string') {
    if (value.length < subSchema.minLength) {
      errors.push({
        path: pathStr(path),
        message: `string length ${value.length} is below minLength ${subSchema.minLength}`,
      });
    }
  }

  if (isPlainObject(value)) {
    if (subSchema.required) {
      for (const key of subSchema.required) {
        if (!(key in value)) {
          errors.push({
            path: pathStr([...path, key]),
            message: 'missing required property',
          });
        }
      }
    }
    if (subSchema.properties) {
      for (const [key, val] of Object.entries(value)) {
        if (key in subSchema.properties) {
          validateNode(val, subSchema.properties[key], rootSchema, [...path, key], errors);
        } else if (subSchema.additionalProperties === false) {
          errors.push({
            path: pathStr([...path, key]),
            message: `additional property '${key}' not allowed`,
          });
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (subSchema.minItems !== undefined && value.length < subSchema.minItems) {
      errors.push({
        path: pathStr(path),
        message: `array has ${value.length} items, minItems is ${subSchema.minItems}`,
      });
    }
    if (subSchema.maxItems !== undefined && value.length > subSchema.maxItems) {
      errors.push({
        path: pathStr(path),
        message: `array has ${value.length} items, maxItems is ${subSchema.maxItems}`,
      });
    }
    if (subSchema.items) {
      value.forEach((item, i) => {
        validateNode(item, subSchema.items, rootSchema, [...path, i], errors);
      });
    }
  }
}

function resolveRef(ref, rootSchema) {
  if (!ref.startsWith('#/')) {
    throw new SchemaError(`unsupported $ref (must start with #/): ${ref}`);
  }
  const parts = ref.slice(2).split('/').map(decodeRefSegment);
  let current = rootSchema;
  for (const part of parts) {
    if (current === undefined || current === null) {
      throw new SchemaError(`$ref ${ref} not found`);
    }
    current = current[part];
  }
  if (current === undefined) {
    throw new SchemaError(`$ref ${ref} not found`);
  }
  return current;
}

function decodeRefSegment(segment) {
  // JSON Pointer unescape per RFC 6901: ~1 -> /, ~0 -> ~
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function pathStr(path) {
  return path.join('/');
}

// ---------------------------------------------------------------------------
// Referential integrity (mirror of blindspotcheck/schema.py)
// ---------------------------------------------------------------------------

function validateReferentialIntegrity(arch) {
  const problems = [];

  const ownerIds = (arch.asset_owners ?? []).map((ao) => ao.id);
  const ownerSet = new Set(ownerIds);
  if (ownerIds.length !== ownerSet.size) {
    const seen = new Set();
    const dupes = new Set();
    for (const i of ownerIds) {
      if (seen.has(i)) dupes.add(i);
      seen.add(i);
    }
    problems.push(
      `asset_owners: duplicate id(s): ${JSON.stringify([...dupes].sort())}`,
    );
  }

  const zoneAuthorities = arch.zone_authorities ?? [];
  const zoneSet = new Set(zoneAuthorities.map((z) => z.zone));
  for (const z of zoneAuthorities) {
    if (!ownerSet.has(z.org)) {
      problems.push(
        `zone_authorities: zone '${z.zone}' references unknown org '${z.org}'`,
      );
    }
  }

  for (const rel of arch.sp_relations ?? []) {
    if (!ownerSet.has(rel.sp)) {
      problems.push(`sp_relations: sp '${rel.sp}' is not in asset_owners`);
    }
    if (!ownerSet.has(rel.ao)) {
      problems.push(`sp_relations: ao '${rel.ao}' is not in asset_owners`);
    }
  }

  const conduitIds = [];
  for (const c of arch.conduits ?? []) {
    const cid = c.id;
    if (cid !== undefined) conduitIds.push(cid);
    for (const side of ['from', 'to']) {
      const ep = c[side] ?? {};
      const owner = ep.owner;
      if (owner !== undefined && !ownerSet.has(owner)) {
        problems.push(
          `conduits[${cid}].${side}.owner '${owner}' is not in asset_owners`,
        );
      }
      const z = ep.zone;
      if (z !== undefined && zoneAuthorities.length > 0 && !zoneSet.has(z)) {
        problems.push(
          `conduits[${cid}].${side}.zone '${z}' is not declared in zone_authorities`,
        );
      }
    }
  }

  if (new Set(conduitIds).size !== conduitIds.length) {
    const seen = new Set();
    const dupes = new Set();
    for (const i of conduitIds) {
      if (seen.has(i)) dupes.add(i);
      seen.add(i);
    }
    problems.push(`conduits: duplicate id(s): ${JSON.stringify([...dupes].sort())}`);
  }

  const conduitIdSet = new Set(conduitIds);
  for (const rel of arch.sp_relations ?? []) {
    const scope = rel.scope;
    if (!scope) continue;
    for (const cid of scope) {
      if (!conduitIdSet.has(cid)) {
        problems.push(
          `sp_relations(${rel.sp}->${rel.ao}).scope references unknown conduit '${cid}'`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new SchemaError(
      `Referential integrity failed:\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
  }
}
