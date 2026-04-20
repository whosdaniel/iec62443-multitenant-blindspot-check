// Adversarial-input tests for web/persistence.js::validateSnapshot.
//
// validateSnapshot is the trust boundary between an arbitrary user-
// supplied .blindspot.json file and the Cytoscape canvas. These tests
// cover every rejection path so a crafted or accidentally-malformed
// file cannot reach the canvas with unchecked strings, unknown ids, or
// dangling edge references.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSnapshot, SaveFileError } from '../../web/persistence.js';

function base() {
  return {
    version: 2,
    app: 'BlindSpotCheck',
    saved_at: '2026-04-19T00:00:00.000Z',
    meta: { name: 't', domain: 'test', evidence_level: 'custom' },
    custom_owners: [],
    zones: [],
    nodes: [
      { id: 'n1', label: 'A', owners: ['APT'], x: 0, y: 0 },
      { id: 'n2', label: 'B', owners: ['ALN'], x: 50, y: 0 },
    ],
    edges: [
      { id: 'E1', source: 'n1', target: 'n2' },
    ],
  };
}

test('accepts a minimal valid snapshot', () => {
  assert.doesNotThrow(() => validateSnapshot(base()));
});

test('rejects non-object top level', () => {
  assert.throws(() => validateSnapshot([]), SaveFileError);
  assert.throws(() => validateSnapshot('string'), SaveFileError);
  assert.throws(() => validateSnapshot(null), SaveFileError);
});

test('rejects wrong app tag', () => {
  const s = base(); s.app = 'NotBlindSpotCheck';
  assert.throws(() => validateSnapshot(s), /Unexpected app tag/);
});

test('rejects unsupported version', () => {
  const s = base(); s.version = 3;
  assert.throws(() => validateSnapshot(s), /Unsupported file version/);
});

test('rejects malformed id (leading digit)', () => {
  const s = base();
  s.nodes[0].id = '1badstart';
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects id exceeding 64 chars', () => {
  const s = base();
  s.nodes[0].id = 'a' + 'x'.repeat(64);
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects __proto__ as an id', () => {
  // __proto__ starts with underscore which is not in the [A-Za-z] leading
  // class, so ID_PATTERN already rejects it. This test pins that guarantee.
  const s = base();
  s.nodes[0].id = '__proto__';
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects duplicate node id', () => {
  const s = base();
  s.nodes[1].id = s.nodes[0].id;
  assert.throws(() => validateSnapshot(s), /Duplicate id/);
});

test('rejects zone id colliding with node id', () => {
  const s = base();
  s.zones.push({ id: 'n1', label: 'collides', authority: 'APT' });
  assert.throws(() => validateSnapshot(s), /Duplicate id/);
});

test('rejects duplicate edge id', () => {
  const s = base();
  s.edges.push({ id: 'E1', source: 'n2', target: 'n1' });
  assert.throws(() => validateSnapshot(s), /Duplicate edge id/);
});

test('rejects edge.source referring to undeclared node', () => {
  const s = base();
  s.edges[0].source = 'nonexistent';
  assert.throws(() => validateSnapshot(s), /not a declared node/);
});

test('rejects edge.target referring to undeclared node', () => {
  const s = base();
  s.edges[0].target = 'nonexistent';
  assert.throws(() => validateSnapshot(s), /not a declared node/);
});

test('rejects non-string label', () => {
  const s = base();
  s.nodes[0].label = 12345;
  assert.throws(() => validateSnapshot(s), /must be a string/);
});

test('rejects non-finite position (NaN)', () => {
  const s = base();
  s.nodes[0].x = NaN;
  assert.throws(() => validateSnapshot(s), /must be a finite number/);
});

test('rejects non-finite position (Infinity)', () => {
  const s = base();
  s.nodes[0].y = Infinity;
  assert.throws(() => validateSnapshot(s), /must be a finite number/);
});

test('rejects owners array containing non-ID strings', () => {
  const s = base();
  s.nodes[0].owners = ['valid-id', 'invalid id with spaces'];
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects zone.authority with bad id pattern', () => {
  const s = base();
  s.zones.push({ id: 'Z1', label: 'z', authority: '1bad' });
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects node.parent with bad id pattern', () => {
  const s = base();
  s.zones.push({ id: 'Z1', label: 'z', authority: 'APT' });
  s.nodes[0].parent = 'no such';
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects notes that is not a string', () => {
  const s = base();
  s.nodes[0].notes = { malicious: 'object' };
  assert.throws(() => validateSnapshot(s), /must be a string/);
});

test('rejects non-array collections', () => {
  const s = base();
  s.nodes = 'should be array';
  assert.throws(() => validateSnapshot(s), /must be an array/);
});

test('accepts snapshot without app or version fields (backward compat)', () => {
  const s = base();
  delete s.app;
  delete s.version;
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('accepts snapshot with empty zones/edges/owners arrays', () => {
  const s = base();
  s.zones = [];
  s.edges = [];
  s.custom_owners = [];
  assert.doesNotThrow(() => validateSnapshot(s));
});

// --- Batch 7: role context + endpoint owner override fields ---

test('accepts node with valid roleContext string', () => {
  const s = base();
  s.nodes[0].roleContext = 'APT HW / VND maint.';
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('rejects non-string roleContext', () => {
  const s = base();
  s.nodes[0].roleContext = { malicious: 'obj' };
  assert.throws(() => validateSnapshot(s), /roleContext must be a string/);
});

test('rejects roleContext exceeding 128 chars', () => {
  const s = base();
  s.nodes[0].roleContext = 'x'.repeat(129);
  assert.throws(() => validateSnapshot(s), /roleContext exceeds 128 chars/);
});

test('accepts edge with valid sourceOwner / targetOwner overrides', () => {
  const s = base();
  s.edges[0].sourceOwner = 'APT';
  s.edges[0].targetOwner = 'ALN';
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('rejects edge sourceOwner that fails ID_PATTERN', () => {
  const s = base();
  s.edges[0].sourceOwner = '1bad';
  assert.throws(() => validateSnapshot(s), /does not match/);
});

test('rejects edge targetOwner with non-string payload', () => {
  const s = base();
  s.edges[0].targetOwner = 123;
  assert.throws(() => validateSnapshot(s), /does not match/);
});

// --- Batch 8: face / endpoint / controlPoint / direction persistence ---

test('accepts edge with valid sourceFace / targetFace', () => {
  const s = base();
  s.edges[0].sourceFace = 'top';
  s.edges[0].targetFace = 'right';
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('rejects sourceFace outside the 4-cardinal set', () => {
  const s = base();
  s.edges[0].sourceFace = 'diagonal';
  assert.throws(() => validateSnapshot(s), /must be one of/);
});

test('accepts free-form sourceEndpoint / targetEndpoint percentages', () => {
  const s = base();
  s.edges[0].sourceEndpoint = '42.5% -30%';
  s.edges[0].targetEndpoint = '-50% 0%';
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('rejects malformed endpoint string', () => {
  const s = base();
  s.edges[0].sourceEndpoint = 'top-left';
  assert.throws(() => validateSnapshot(s), /must match/);
});

test('rejects endpoint string without the % suffix', () => {
  const s = base();
  s.edges[0].sourceEndpoint = '50 -50';
  assert.throws(() => validateSnapshot(s), /must match/);
});

test('accepts direction enum values (4-state + legacy one-way alias)', () => {
  for (const v of ['none', 'forward', 'reverse', 'two-way', 'one-way']) {
    const s = base();
    s.edges[0].direction = v;
    assert.doesNotThrow(() => validateSnapshot(s), `rejected valid direction ${v}`);
  }
});

test('rejects direction outside enum', () => {
  const s = base();
  s.edges[0].direction = 'diagonal';
  assert.throws(() => validateSnapshot(s), /must be one of/);
});

test('accepts a single-control-point bezier', () => {
  const s = base();
  s.edges[0].controlPointDistances = [80];
  s.edges[0].controlPointWeights   = [0.5];
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('accepts a multi-control-point bezier', () => {
  const s = base();
  s.edges[0].controlPointDistances = [-60, 60, -60];
  s.edges[0].controlPointWeights   = [0.25, 0.5, 0.75];
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('rejects control-point arrays of mismatched length', () => {
  const s = base();
  s.edges[0].controlPointDistances = [10, 20];
  s.edges[0].controlPointWeights   = [0.5];
  assert.throws(() => validateSnapshot(s), /length mismatch/);
});

test('rejects control-point weight outside [0, 1]', () => {
  const s = base();
  s.edges[0].controlPointDistances = [10];
  s.edges[0].controlPointWeights   = [1.5];
  assert.throws(() => validateSnapshot(s), /must be in \[0,1\]/);
});

test('rejects non-finite control-point distance', () => {
  const s = base();
  s.edges[0].controlPointDistances = [Number.POSITIVE_INFINITY];
  s.edges[0].controlPointWeights   = [0.5];
  assert.throws(() => validateSnapshot(s), /must be a finite number/);
});

test('rejects non-array control-point payload', () => {
  const s = base();
  s.edges[0].controlPointDistances = 'not an array';
  s.edges[0].controlPointWeights   = [0.5];
  assert.throws(() => validateSnapshot(s), /must both be arrays/);
});

test('rejects self-loop edge (source == target)', () => {
  const s = base();
  s.edges[0].source = 'n1';
  s.edges[0].target = 'n1';
  assert.throws(() => validateSnapshot(s), /self-loops are not allowed/);
});

test('full canvas-visual snapshot validates end-to-end', () => {
  // One big snapshot that exercises every visual field added since
  // Batch 7 (role context, face, endpoint, controlPoint, direction,
  // endpoint-owner override, spSubtype). If any of these regress the
  // validator, this test trips first.
  const s = base();
  s.nodes[0].roleContext = 'APT HW / VND maint.';
  s.nodes[1].roleContext = '3-tenant APT+ALN';
  s.edges[0] = {
    id: 'CD-rich',
    source: 'n1',
    target: 'n2',
    label: 'CD-rich',
    directed: true,
    direction: 'one-way',
    spCovered: true,
    spSubtype: 'maintenance',
    notes: 'Round-trip me',
    sourceOwner: 'APT',
    targetOwner: 'ALN',
    sourceFace: 'right',
    targetFace: 'left',
    sourceEndpoint: '50% -25%',
    targetEndpoint: '-50% 25%',
    controlPointDistances: [-100, 100],
    controlPointWeights:   [0.3, 0.7],
  };
  assert.doesNotThrow(() => validateSnapshot(s));
});
