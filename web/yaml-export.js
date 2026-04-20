// Vanilla YAML serializer for architecture dicts.
//
// Emits a YAML subset that Python's yaml.safe_load (PyYAML 6.x) parses
// back into the same architecture dict - round-trip tested by
// tests/test_parity.py::test_js_yaml_export_round_trips.
//
// Design rules:
//   - Every string scalar is double-quoted. This bypasses YAML's type-
//     coercion heuristics (yes/no/null/on/off/true/false, unquoted ids
//     that happen to look numeric or contain colons, etc.) and is still
//     safely accepted by yaml.safe_load. It's slightly less pretty than
//     smart-quoting but removes a whole class of ambiguity.
//   - Top-level collections (asset_owners, sp_relations, ...) are emitted
//     block-style for readability.
//   - Small records inside those collections are emitted flow-style
//     ({ key: "v", ... }) so each entry fits on one line.
//   - No anchors, no merges, no custom tags.
//
// We deliberately do NOT depend on js-yaml (OSV-tracked prototype
// pollution CVE GHSA-mh29-5h37-fv8m in older versions, and Danny's
// project policy rejects it outright). A ~100-line bespoke emitter is
// a smaller, auditable surface.

/**
 * Serialize an `architecture-v1.json`-shaped dict to YAML text.
 *
 * @param {object} arch - an architecture object (meta + asset_owners + ...)
 * @param {{ header?: string }} [opts]  optional `header` block emitted as
 *        leading `# comment` lines.
 * @returns {string} YAML text ending in a newline.
 */
export function archToYaml(arch, { header = null } = {}) {
  const lines = [];
  if (header) {
    for (const line of String(header).split('\n')) {
      lines.push(line.length > 0 ? `# ${line}` : '#');
    }
    lines.push('');
  }

  // meta
  lines.push('meta:');
  lines.push(...emitMap(arch.meta ?? {}, '  '));
  lines.push('');

  // asset_owners
  lines.push('asset_owners:');
  for (const ao of arch.asset_owners ?? []) {
    lines.push(`  - ${flowMap(ao)}`);
  }

  // sp_relations (optional)
  if (Array.isArray(arch.sp_relations) && arch.sp_relations.length > 0) {
    lines.push('');
    lines.push('sp_relations:');
    for (const rel of arch.sp_relations) {
      lines.push(`  - ${flowMap(rel)}`);
    }
  }

  // zone_authorities (optional)
  if (Array.isArray(arch.zone_authorities) && arch.zone_authorities.length > 0) {
    lines.push('');
    lines.push('zone_authorities:');
    for (const z of arch.zone_authorities) {
      lines.push(`  - ${flowMap(z)}`);
    }
  }

  // conduits (required) - block-style, since each conduit has nested
  // from/to and optional description + notes that benefit from multi-line.
  lines.push('');
  lines.push('conduits:');
  for (const c of arch.conduits ?? []) {
    lines.push(...emitConduit(c, '  '));
  }

  return lines.join('\n') + '\n';
}

function emitConduit(c, indent) {
  // For a block-sequence-of-maps like `- id: X`, subsequent keys of the
  // same map must align with `id`, which starts two columns in from
  // `-` (one for `-`, one for the space). So continuation indent is
  // `indent + '  '`, not `indent + '    '`.
  const out = [];
  out.push(`${indent}- id: ${qstr(c.id)}`);
  const inner = indent + '  ';
  if (c.description !== undefined && c.description !== null) {
    out.push(`${inner}description: ${qstr(c.description)}`);
  }
  out.push(`${inner}from: ${flowMap(c.from)}`);
  out.push(`${inner}to:   ${flowMap(c.to)}`);
  if (c.transit_owner !== undefined && c.transit_owner !== null && c.transit_owner !== '') {
    out.push(`${inner}transit_owner: ${qstr(c.transit_owner)}`);
  }
  if (c.transit_asset !== undefined && c.transit_asset !== null && c.transit_asset !== '') {
    out.push(`${inner}transit_asset: ${qstr(c.transit_asset)}`);
  }
  if (c.notes !== undefined && c.notes !== null && c.notes !== '') {
    out.push(`${inner}notes: ${qstr(c.notes)}`);
  }
  return out;
}

function emitMap(obj, indent) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (isPlainObject(v)) {
      if (Object.keys(v).length === 0) {
        out.push(`${indent}${k}: {}`);
        continue;
      }
      out.push(`${indent}${k}:`);
      out.push(...emitMap(v, indent + '  '));
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${indent}${k}: []`);
        continue;
      }
      if (v.every((x) => !isPlainObject(x) && !Array.isArray(x))) {
        out.push(`${indent}${k}: [${v.map(flowScalar).join(', ')}]`);
      } else {
        out.push(`${indent}${k}:`);
        for (const item of v) {
          if (isPlainObject(item)) {
            out.push(`${indent}  - ${flowMap(item)}`);
          } else {
            out.push(`${indent}  - ${flowScalar(item)}`);
          }
        }
      }
    } else {
      out.push(`${indent}${k}: ${flowScalar(v)}`);
    }
  }
  return out;
}

function flowMap(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined) continue;
    parts.push(`${k}: ${flowValue(v)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function flowValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : qstr(String(v));
  if (typeof v === 'string') return qstr(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${v.map(flowValue).join(', ')}]`;
  }
  if (isPlainObject(v)) return flowMap(v);
  return qstr(String(v));
}

function flowScalar(v) {
  return flowValue(v);
}

function qstr(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // YAML spec forbids several control chars even in quoted scalars;
    // replace any remaining low-bytes with their \xNN escape.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (c) =>
      '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
    )
    // DEL + C1 controls. PyYAML 1.1 silently normalises NEL (U+0085)
    // to ASCII space inside double-quoted scalars, which would break
    // byte-faithful round trip. Escape explicitly.
    .replace(/[\u007F-\u009F]/g, (c) =>
      '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
    )
    // Line/paragraph separators. Defensive: sanitizeText strips these
    // upstream, but user-authored YAML input to the canvas could still
    // introduce them. Strip here rather than \uXXXX-escape to keep the
    // emitted YAML free of any line-terminator-ambiguous bytes.
    .replace(/[\u2028\u2029]/g, '') + '"';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
