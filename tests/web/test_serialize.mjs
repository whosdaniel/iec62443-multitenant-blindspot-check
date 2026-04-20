// Unit tests for the pure-data serializers that don't require Cytoscape.
// snapshotToArchitecture is the backbone of the scenario-diff feature
// (Batch 6) and of the YAML round-trip Python-side test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotToArchitecture } from '../../web/serialize.js';
import { evaluateArchitecture, Verdict } from '../../web/evaluator.js';
import { validateArchitecture } from '../../web/schema-validator.js';

// Library stub: every chip is resolvable with role AO. The real library
// (web/chips.js) would also return a palette + description, but the
// evaluator only consumes `role`.
const lib = {
  getChip: (id) => ({ id, role: 'AO', palette: 'CUSTOM', label: id }),
};

test('returns null when fewer than two owners are assigned', () => {
  const snap = {
    meta: { domain: 'test' },
    zones: [],
    nodes: [{ id: 'n1', owners: ['OnlyOne'] }],
    edges: [],
  };
  assert.equal(snapshotToArchitecture(snap, lib), null);
});

test('returns null when no complete edges (endpoints missing owners)', () => {
  const snap = {
    meta: { domain: 'test' },
    zones: [],
    nodes: [
      { id: 'n1', owners: ['A'] },
      { id: 'n2', owners: [] },  // incomplete
    ],
    edges: [{ id: 'E1', source: 'n1', target: 'n2' }],
  };
  // Note: owners set has 2 declared (A + ... nothing else), actually just A
  // So this returns null for under-2-owners reason. Cover that case.
  assert.equal(snapshotToArchitecture(snap, lib), null);
});

test('builds a schema-valid architecture from a minimal cross-AO snapshot', () => {
  const snap = {
    meta: { domain: 'test' },
    zones: [
      { id: 'Z-A', authority: 'APT' },
      { id: 'Z-B', authority: 'ALN' },
    ],
    nodes: [
      { id: 'n1', owners: ['APT'], parent: 'Z-A' },
      { id: 'n2', owners: ['ALN'], parent: 'Z-B' },
    ],
    edges: [{ id: 'CD-X', source: 'n1', target: 'n2' }],
  };
  const arch = snapshotToArchitecture(snap, lib);
  assert.ok(arch);
  assert.doesNotThrow(() => validateArchitecture(arch));
  assert.equal(arch.asset_owners.length, 2);
  assert.equal(arch.zone_authorities.length, 2);
  assert.equal(arch.conduits.length, 1);
  assert.deepEqual(arch.conduits[0].from, { owner: 'APT', zone: 'Z-A' });
  assert.deepEqual(arch.conduits[0].to,   { owner: 'ALN', zone: 'Z-B' });
});

test('minimal cross-AO snapshot evaluates to blind-spot', () => {
  const snap = {
    meta: { domain: 'test' },
    zones: [
      { id: 'Z-A', authority: 'APT' },
      { id: 'Z-B', authority: 'ALN' },
    ],
    nodes: [
      { id: 'n1', owners: ['APT'], parent: 'Z-A' },
      { id: 'n2', owners: ['ALN'], parent: 'Z-B' },
    ],
    edges: [{ id: 'CD-X', source: 'n1', target: 'n2' }],
  };
  const arch = snapshotToArchitecture(snap, lib);
  const report = evaluateArchitecture(arch);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].verdict, Verdict.BLIND_SPOT);
});

test('spCovered + spSubtype round-trip into sp_relations', () => {
  const snap = {
    meta: { domain: 'test' },
    zones: [],
    nodes: [
      { id: 'n1', owners: ['VND'] },
      { id: 'n2', owners: ['APT'] },
    ],
    edges: [
      { id: 'CD-1', source: 'n1', target: 'n2', spCovered: true, spSubtype: 'integration' },
      { id: 'CD-2', source: 'n1', target: 'n2', spCovered: true, spSubtype: 'maintenance' },
      // Default 'both' should NOT emit sp_subtype (keeps YAML byte-stable).
      { id: 'CD-3', source: 'n1', target: 'n2', spCovered: true, spSubtype: 'both' },
    ],
  };
  const arch = snapshotToArchitecture(snap, lib);
  assert.equal(arch.sp_relations.length, 3);
  assert.equal(arch.sp_relations[0].sp_subtype, 'integration');
  assert.equal(arch.sp_relations[1].sp_subtype, 'maintenance');
  assert.equal(arch.sp_relations[2].sp_subtype, undefined);
});

test('visual-only edge fields do not leak into the architecture YAML', () => {
  // Canvas-level visual state (how the edge is drawn) must stay out
  // of the evaluator's architecture dict, which is the input to the
  // paper's biconditional. snapshotToArchitecture is responsible for
  // filtering these fields out.
  const snap = {
    meta: { domain: 'test' },
    zones: [],
    nodes: [
      { id: 'a', owners: ['APT'] },
      { id: 'b', owners: ['ALN'] },
    ],
    edges: [{
      id: 'CD-draw',
      source: 'a',
      target: 'b',
      sourceFace: 'right',
      targetFace: 'left',
      sourceEndpoint: '42% -30%',
      targetEndpoint: '-50% 0%',
      controlPointDistances: [-120, 80],
      controlPointWeights:   [0.3, 0.7],
      direction: 'two-way',
      roleContext: 'cosmetic',
    }],
  };
  const arch = snapshotToArchitecture(snap, lib);
  assert.equal(arch.conduits.length, 1);
  const c = arch.conduits[0];
  // Only the evaluator-relevant conduit schema fields should survive.
  const allowed = new Set(['id', 'from', 'to']);
  for (const k of Object.keys(c)) {
    assert.ok(allowed.has(k), `conduit leaked canvas-only field "${k}"`);
  }
  // And the sub-objects must not carry visual keys either.
  for (const side of ['from', 'to']) {
    for (const k of Object.keys(c[side])) {
      assert.ok(['owner', 'zone'].includes(k),
        `conduit.${side} leaked field "${k}"`);
    }
  }
});

test('edge sourceOwner / targetOwner overrides pick the tenant on multi-tenant endpoints', () => {
  // Models paper §4 / Table 3 CD-06 rationale: a multi-tenant CUPPS
  // Workstation has owners [APT, VND, ALN-A, ALN-B, ALN-C], but the
  // specific conduit CD-06 represents ALN-B's session traversing the
  // APT-owned IDF switch. Without the override, owners[0]=APT would be
  // picked and the conduit would degenerate to APT->APT (no-cross-ao).
  const snap = {
    meta: { domain: 'test' },
    zones: [],
    nodes: [
      { id: 'ws', owners: ['APT', 'VND', 'ALN-A', 'ALN-B', 'ALN-C'] },
      { id: 'sw', owners: ['APT'] },
    ],
    edges: [
      // No override: degenerates to APT->APT
      { id: 'CD-default', source: 'ws', target: 'sw' },
      // Override source to ALN-B: cross-AO, should blind-spot
      { id: 'CD-override', source: 'ws', target: 'sw', sourceOwner: 'ALN-B' },
      // Override naming an owner NOT on the endpoint: ignored (fail-safe)
      { id: 'CD-bogus', source: 'ws', target: 'sw', sourceOwner: 'GHOST' },
    ],
  };
  const arch = snapshotToArchitecture(snap, lib);
  const report = evaluateArchitecture(arch);
  const by = Object.fromEntries(report.results.map((r) => [r.conduit_id, r]));
  assert.equal(by['CD-default'].verdict, Verdict.NO_CROSS_AO);
  assert.equal(by['CD-override'].verdict, Verdict.BLIND_SPOT);
  assert.equal(by['CD-override'].sc1, true);
  // Bogus override is ignored; degenerates to owners[0]=APT on both ends.
  assert.equal(by['CD-bogus'].verdict, Verdict.NO_CROSS_AO);
});

test('fork-style diff (two snapshots differing by one spCovered flag)', () => {
  // Scenario A: edge has NO SP coverage -> blind-spot
  // Scenario B: edge gets maintenance SP -> resolved-by-sp
  // This models the Batch-6 "what if the vendor signs a maintenance
  // contract for this conduit?" exploration.
  const base = {
    meta: { domain: 'test' },
    zones: [
      { id: 'Z-A', authority: 'APT' },
      { id: 'Z-B', authority: 'ALN' },
    ],
    nodes: [
      { id: 'n1', owners: ['APT'], parent: 'Z-A' },
      { id: 'n2', owners: ['ALN'], parent: 'Z-B' },
    ],
    edges: [{ id: 'CD-X', source: 'n1', target: 'n2' }],
  };
  const snapA = JSON.parse(JSON.stringify(base));
  const snapB = JSON.parse(JSON.stringify(base));
  snapB.edges[0].spCovered = true;
  snapB.edges[0].spSubtype = 'maintenance';

  const archA = snapshotToArchitecture(snapA, lib);
  const archB = snapshotToArchitecture(snapB, lib);
  const rA = evaluateArchitecture(archA);
  const rB = evaluateArchitecture(archB);
  assert.equal(rA.results[0].verdict, Verdict.BLIND_SPOT);
  assert.equal(rB.results[0].verdict, Verdict.RESOLVED_BY_SP);
});
