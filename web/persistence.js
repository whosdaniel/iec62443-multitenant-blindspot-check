// File I/O and LocalStorage auto-save.
//
// Save format (version 2):
//   {
//     version: 2,
//     app: "BlindSpotCheck",
//     saved_at: ISO-8601 timestamp,
//     meta:      { name, domain, evidence_level, source, description },
//     custom_owners: [...chips not in DEFAULT_CHIPS],
//     zones:     [{id, label, authority, x, y, notes}],
//     nodes:     [{id, label, owners, parent, x, y, notes}],
//     edges:     [{id, label, source, target, directed, spCovered, notes}],
//   }
//
// Security:
//   - Saved files are plain JSON, loaded via FileReader + JSON.parse only.
//   - We never eval() anything from file content.
//   - Size cap: 4 MiB (much larger than our worst-case 500-node canvas
//     but bounded against accidental OOM on pathological inputs).
//   - Notes fields are sanitized on import (control chars stripped).
//   - LocalStorage is scoped per-origin; no cookies/credentials involved.

import { loadTemplateIntoCanvas } from './serialize.js';
import { ID_PATTERN, sanitizeText } from './ui.js';

const FILE_EXT = '.blindspot.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const LS_STATE_KEY    = 'blindspotcheck.autosave.state';
const LS_ENABLED_KEY  = 'blindspotcheck.autosave.enabled';
const LS_FILENAME_KEY = 'blindspotcheck.filename';

// ---------------------------------------------------------------------------
// canvas -> snapshot
// ---------------------------------------------------------------------------

export function canvasToSnapshot(canvas, library) {
  const cy = canvas.cy;

  const customOwners = library.chips
    .filter((c) => !library.isDefault(c.id))
    .map((c) => ({
      id: c.id,
      label: c.label,
      role: c.role,
      palette: c.palette,
      description: c.description,
    }));

  const zones = cy
    .$('node.zone')
    .map((z) => ({
      id: z.id(),
      label: z.data('label'),
      authority: z.data('zoneAuthority') ?? null,
      x: z.position().x,
      y: z.position().y,
      notes: z.data('notes') ?? '',
    }));

  const nodes = cy
    .nodes()
    .filter((n) => !n.hasClass('zone') && !n.hasClass('edge-bend-handle') && !n.hasClass('edge-endpoint-handle'))
    .map((n) => {
      const parent = n.parent();
      const snap = {
        id: n.id(),
        label: n.data('label'),
        owners: Array.from(n.data('owners') ?? []),
        parent: parent.nonempty() ? parent.id() : null,
        x: n.position().x,
        y: n.position().y,
        notes: n.data('notes') ?? '',
      };
      const ctx = n.data('roleContext');
      if (typeof ctx === 'string' && ctx.length > 0) snap.roleContext = ctx;
      return snap;
    });

  const edges = cy.edges().map((e) => {
    const direction = e.data('direction') ?? (e.data('directed') ? 'one-way' : 'none');
    const snap = {
      id: e.id(),
      label: e.data('label') ?? e.id(),
      source: e.source().id(),
      target: e.target().id(),
      directed: direction !== 'none',
      direction,
      spCovered: !!e.data('spCovered'),
      spSubtype: e.data('spSubtype') ?? 'both',
      notes: e.data('notes') ?? '',
    };
    const so = e.data('sourceOwner');
    const to = e.data('targetOwner');
    if (typeof so === 'string' && so.length > 0) snap.sourceOwner = so;
    if (typeof to === 'string' && to.length > 0) snap.targetOwner = to;
    const sf = e.data('sourceFace');
    const tf = e.data('targetFace');
    if (typeof sf === 'string' && sf.length > 0) snap.sourceFace = sf;
    if (typeof tf === 'string' && tf.length > 0) snap.targetFace = tf;
    const se = e.data('sourceEndpoint');
    const te = e.data('targetEndpoint');
    if (typeof se === 'string' && se.length > 0) snap.sourceEndpoint = se;
    if (typeof te === 'string' && te.length > 0) snap.targetEndpoint = te;
    const cpd = e.data('controlPointDistances');
    const cpw = e.data('controlPointWeights');
    if (Array.isArray(cpd) && Array.isArray(cpw) && cpd.length === cpw.length && cpd.length > 0) {
      snap.controlPointDistances = cpd.slice();
      snap.controlPointWeights   = cpw.slice();
    }
    return snap;
  });

  return {
    version: 2,
    app: 'BlindSpotCheck',
    saved_at: new Date().toISOString(),
    meta: {
      name: canvas.templateName ?? 'Custom architecture',
      domain: canvas.domain ?? 'custom',
      evidence_level: canvas.evidenceLevel ?? 'custom',
      description: canvas.templateDescription ?? '',
      source: canvas.templateSource ?? '',
      measurement_prerequisites: Array.isArray(canvas.measurementPrerequisites)
        ? canvas.measurementPrerequisites.slice()
        : [],
      review: canvas.review ? { ...canvas.review } : null,
    },
    custom_owners: customOwners,
    zones,
    nodes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// snapshot -> canvas
// ---------------------------------------------------------------------------

/**
 * Restore a snapshot. Accepts both save-format (custom_owners) and the
 * template-format (owners) for convenience.
 *
 * Callers must have validated the snapshot via validateSnapshot first
 * (loadFromFile does this automatically). We still defensively sanitise
 * user-facing strings at load time in case an in-memory snapshot is
 * passed in from a path that bypasses validateSnapshot.
 */
export function loadSnapshotIntoCanvas(snapshot, canvas, library) {
  const templatish = {
    meta: snapshot.meta ?? {},
    owners: snapshot.custom_owners ?? snapshot.owners ?? [],
    zones: (snapshot.zones ?? []).map(sanitizeUserStrings),
    nodes: (snapshot.nodes ?? []).map(sanitizeUserStrings),
    edges: (snapshot.edges ?? []).map(sanitizeUserStrings),
  };
  loadTemplateIntoCanvas(templatish, canvas, library);
}

function sanitizeUserStrings(item) {
  if (!item || typeof item !== 'object') return item;
  const copy = { ...item };
  if (typeof copy.label === 'string') {
    copy.label = sanitizeText(copy.label, 128);
  }
  if (typeof copy.notes === 'string') {
    copy.notes = sanitizeText(copy.notes, 2000);
  }
  // roleContext is free-text that rides into the node sub-label. A
  // malicious save file could put C0/C1 controls or separators there
  // to glitch the canvas label renderer - strip them on load too.
  if (typeof copy.roleContext === 'string') {
    copy.roleContext = sanitizeText(copy.roleContext, 128);
  }
  return copy;
}

// ---------------------------------------------------------------------------
// File save / load
// ---------------------------------------------------------------------------

/** Kicks off a download of `snapshot` as a JSON file named `filename`. */
export function saveToFile(snapshot, filename) {
  const safeName = toSafeFilename(filename);
  const payload = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Release the blob; some browsers want a microtask gap before revoke.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return safeName;
}

/**
 * Read a single File from an <input type="file"> change event. Throws
 * SaveFileError on size violation, JSON parse error, or missing required
 * fields.
 */
export function loadFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new SaveFileError('No file selected.'));
    if (file.size > MAX_FILE_BYTES) {
      return reject(new SaveFileError(
        `File is ${file.size} bytes; limit is ${MAX_FILE_BYTES}.`,
      ));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new SaveFileError('Could not read file.'));
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        validateSnapshot(parsed);
        resolve(parsed);
      } catch (err) {
        if (err instanceof SaveFileError) reject(err);
        else reject(new SaveFileError(`Invalid file: ${err.message}`));
      }
    };
    reader.readAsText(file);
  });
}

export class SaveFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SaveFileError';
  }
}

/**
 * Top-level shape + per-element validator for save files.
 *
 * Exported so the Node test suite can feed adversarial inputs (proto
 * keys, bad id patterns, unbalanced edges, finite-number checks) and
 * prove each one is rejected before the blob reaches Cytoscape.
 *
 * Validation rules (fail-closed, throws SaveFileError on any violation):
 *   - Top level must be a JSON object tagged app=BlindSpotCheck
 *     (or untagged for backward compat) and version=2.
 *   - zones/nodes/edges/custom_owners/owners must each be an array if
 *     present.
 *   - Every id must match ID_PATTERN (^[A-Za-z][A-Za-z0-9_-]{0,63}$).
 *     This inherently rejects "__proto__", "constructor" leading with _,
 *     and any name starting with a digit or punctuation.
 *   - Labels, if present, must be strings; numeric-position fields must
 *     be finite numbers.
 *   - Owner arrays must contain only strings matching ID_PATTERN.
 *   - Edge source/target must refer to a declared node.
 *   - No duplicate ids across zones + nodes, nor within edges.
 */
export function validateSnapshot(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    throw new SaveFileError('Top level must be a JSON object.');
  }
  if (snap.app && snap.app !== 'BlindSpotCheck') {
    throw new SaveFileError(`Unexpected app tag: ${snap.app}`);
  }
  if (snap.version !== undefined && snap.version !== 2) {
    throw new SaveFileError(
      `Unsupported file version: ${snap.version} (this build handles version 2).`,
    );
  }
  for (const arr of ['zones', 'nodes', 'edges', 'custom_owners', 'owners']) {
    if (arr in snap && !Array.isArray(snap[arr])) {
      throw new SaveFileError(`Field '${arr}' must be an array.`);
    }
  }

  const allIds = new Set();

  for (const z of snap.zones ?? []) {
    assertObject(z, 'zone entry');
    assertId(z.id, `zone.id '${z.id}'`);
    if (allIds.has(z.id)) {
      throw new SaveFileError(`Duplicate id across zones/nodes: '${z.id}'`);
    }
    allIds.add(z.id);
    assertOptionalString(z.label, `zone '${z.id}'.label`);
    assertOptionalFinite(z.x, `zone '${z.id}'.x`);
    assertOptionalFinite(z.y, `zone '${z.id}'.y`);
    if (z.authority !== undefined && z.authority !== null) {
      assertId(z.authority, `zone '${z.id}'.authority`);
    }
    assertOptionalString(z.notes, `zone '${z.id}'.notes`);
  }

  const nodeIds = new Set();
  for (const n of snap.nodes ?? []) {
    assertObject(n, 'node entry');
    assertId(n.id, `node.id '${n.id}'`);
    if (allIds.has(n.id)) {
      throw new SaveFileError(`Duplicate id across zones/nodes: '${n.id}'`);
    }
    allIds.add(n.id);
    nodeIds.add(n.id);
    assertOptionalString(n.label, `node '${n.id}'.label`);
    assertOptionalFinite(n.x, `node '${n.id}'.x`);
    assertOptionalFinite(n.y, `node '${n.id}'.y`);
    assertOptionalString(n.notes, `node '${n.id}'.notes`);
    if (n.owners !== undefined) {
      if (!Array.isArray(n.owners)) {
        throw new SaveFileError(`node '${n.id}'.owners must be an array`);
      }
      for (const o of n.owners) assertId(o, `node '${n.id}'.owners entry '${o}'`);
    }
    if (n.parent !== undefined && n.parent !== null) {
      assertId(n.parent, `node '${n.id}'.parent '${n.parent}'`);
    }
    if (n.roleContext !== undefined && n.roleContext !== null) {
      if (typeof n.roleContext !== 'string') {
        throw new SaveFileError(`node '${n.id}'.roleContext must be a string`);
      }
      if (n.roleContext.length > 128) {
        throw new SaveFileError(`node '${n.id}'.roleContext exceeds 128 chars`);
      }
    }
  }

  const edgeIds = new Set();
  const SP_SUBTYPES = ['integration', 'maintenance', 'both'];
  for (const e of snap.edges ?? []) {
    assertObject(e, 'edge entry');
    assertId(e.id, `edge.id '${e.id}'`);
    if (edgeIds.has(e.id)) {
      throw new SaveFileError(`Duplicate edge id: '${e.id}'`);
    }
    edgeIds.add(e.id);
    assertOptionalString(e.label, `edge '${e.id}'.label`);
    assertOptionalString(e.notes, `edge '${e.id}'.notes`);
    if (!e.source || !nodeIds.has(e.source)) {
      throw new SaveFileError(
        `edge '${e.id}'.source '${e.source}' is not a declared node`,
      );
    }
    if (!e.target || !nodeIds.has(e.target)) {
      throw new SaveFileError(
        `edge '${e.id}'.target '${e.target}' is not a declared node`,
      );
    }
    if (e.source === e.target) {
      throw new SaveFileError(
        `edge '${e.id}' source equals target; self-loops are not allowed`,
      );
    }
    if (e.directed !== undefined && typeof e.directed !== 'boolean') {
      throw new SaveFileError(`edge '${e.id}'.directed must be a boolean`);
    }
    if (e.direction !== undefined && e.direction !== null) {
      // Legacy save files may carry 'one-way' which maps to 'forward'
      // at load time; accept it here so round-trip stays compatible.
      const ALLOWED_DIR = ['none', 'forward', 'reverse', 'two-way', 'one-way'];
      if (!ALLOWED_DIR.includes(e.direction)) {
        throw new SaveFileError(
          `edge '${e.id}'.direction '${e.direction}' must be one of ${JSON.stringify(ALLOWED_DIR)}`,
        );
      }
    }
    if (e.spCovered !== undefined && typeof e.spCovered !== 'boolean') {
      throw new SaveFileError(`edge '${e.id}'.spCovered must be a boolean`);
    }
    if (
      e.spSubtype !== undefined &&
      e.spSubtype !== null &&
      !SP_SUBTYPES.includes(e.spSubtype)
    ) {
      throw new SaveFileError(
        `edge '${e.id}'.spSubtype '${e.spSubtype}' must be one of ${JSON.stringify(SP_SUBTYPES)}`,
      );
    }
    if (e.sourceOwner !== undefined && e.sourceOwner !== null) {
      assertId(e.sourceOwner, `edge '${e.id}'.sourceOwner`);
    }
    if (e.targetOwner !== undefined && e.targetOwner !== null) {
      assertId(e.targetOwner, `edge '${e.id}'.targetOwner`);
    }
    const FACES = ['top', 'bottom', 'left', 'right'];
    if (e.sourceFace !== undefined && e.sourceFace !== null) {
      if (!FACES.includes(e.sourceFace)) {
        throw new SaveFileError(
          `edge '${e.id}'.sourceFace '${e.sourceFace}' must be one of ${JSON.stringify(FACES)}`,
        );
      }
    }
    if (e.targetFace !== undefined && e.targetFace !== null) {
      if (!FACES.includes(e.targetFace)) {
        throw new SaveFileError(
          `edge '${e.id}'.targetFace '${e.targetFace}' must be one of ${JSON.stringify(FACES)}`,
        );
      }
    }
    const ENDPOINT_RE = /^\s*-?\d+(?:\.\d+)?%\s+-?\d+(?:\.\d+)?%\s*$/;
    if (e.sourceEndpoint !== undefined && e.sourceEndpoint !== null) {
      if (typeof e.sourceEndpoint !== 'string' || !ENDPOINT_RE.test(e.sourceEndpoint)) {
        throw new SaveFileError(
          `edge '${e.id}'.sourceEndpoint '${e.sourceEndpoint}' must match "<n>% <n>%"`,
        );
      }
    }
    if (e.targetEndpoint !== undefined && e.targetEndpoint !== null) {
      if (typeof e.targetEndpoint !== 'string' || !ENDPOINT_RE.test(e.targetEndpoint)) {
        throw new SaveFileError(
          `edge '${e.id}'.targetEndpoint '${e.targetEndpoint}' must match "<n>% <n>%"`,
        );
      }
    }
    if (e.controlPointDistances !== undefined || e.controlPointWeights !== undefined) {
      validateBendArrays(e.id, 'controlPoint', e.controlPointDistances, e.controlPointWeights);
    }
  }

  for (const o of snap.custom_owners ?? snap.owners ?? []) {
    assertObject(o, 'owner entry');
    assertId(o.id, `owner.id '${o.id}'`);
    assertOptionalString(o.label, `owner '${o.id}'.label`);
  }
}

function validateBendArrays(edgeId, kind, distances, weights) {
  if (!Array.isArray(distances) || !Array.isArray(weights)) {
    throw new SaveFileError(`edge '${edgeId}'.${kind}Distances/${kind}Weights must both be arrays`);
  }
  if (distances.length !== weights.length) {
    throw new SaveFileError(`edge '${edgeId}'.${kind}Distances and .${kind}Weights length mismatch`);
  }
  for (const d of distances) {
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      throw new SaveFileError(`edge '${edgeId}'.${kind}Distances entry must be a finite number`);
    }
  }
  for (const w of weights) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1) {
      throw new SaveFileError(`edge '${edgeId}'.${kind}Weights entry must be in [0,1]`);
    }
  }
}

function assertObject(v, label) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SaveFileError(`${label} must be a plain object`);
  }
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new SaveFileError(
      `${label} does not match ^[A-Za-z][A-Za-z0-9_-]{0,63}$`,
    );
  }
}

function assertOptionalString(v, label) {
  if (v !== undefined && v !== null && typeof v !== 'string') {
    throw new SaveFileError(`${label} must be a string`);
  }
}

function assertOptionalFinite(v, label) {
  if (v === undefined || v === null) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SaveFileError(`${label} must be a finite number`);
  }
}

function toSafeFilename(raw) {
  let name = (raw ?? '').trim();
  if (!name) name = 'architecture';
  // Strip anything that isn't alphanumeric / dash / underscore / dot.
  name = name.replace(/[^A-Za-z0-9._-]+/g, '-');
  // Collapse consecutive separators.
  name = name.replace(/-+/g, '-').replace(/\.+/g, '.');
  // Remove leading/trailing dots to prevent hidden-file or empty-stem results.
  name = name.replace(/^\.+|\.+$/g, '');
  if (!name) name = 'architecture';
  if (!name.endsWith(FILE_EXT)) {
    // If user typed foo.json, keep one extension; otherwise append ours.
    if (name.endsWith('.json')) name = name.slice(0, -5) + FILE_EXT;
    else name = name + FILE_EXT;
  }
  return name;
}

// ---------------------------------------------------------------------------
// LocalStorage auto-save
// ---------------------------------------------------------------------------

export function saveAutosave(snapshot) {
  try {
    localStorage.setItem(LS_STATE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // Quota exceeded or disabled.
    return false;
  }
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(LS_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    validateSnapshot(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  try {
    localStorage.removeItem(LS_STATE_KEY);
  } catch {
    // Ignore.
  }
}

export function setAutosaveEnabled(enabled) {
  try {
    localStorage.setItem(LS_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore.
  }
}

export function getAutosaveEnabled() {
  try {
    return localStorage.getItem(LS_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSavedFilename(name) {
  try {
    if (name) localStorage.setItem(LS_FILENAME_KEY, name);
    else localStorage.removeItem(LS_FILENAME_KEY);
  } catch {
    // Ignore.
  }
}

export function getSavedFilename() {
  try {
    return localStorage.getItem(LS_FILENAME_KEY) || null;
  } catch {
    return null;
  }
}
