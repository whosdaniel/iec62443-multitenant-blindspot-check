// Verify bundled templates against the schema + evaluator.
// Critical: airport-cupps-1.0 must reproduce Paper Table 3 ID-for-ID,
// matching tests/test_samples.py::test_airport_sample_reproduces_paper_table3
// on the Python side. Template drift from the paper fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEMPLATES, TEMPLATE_ORDER } from '../../web/templates.js';
import { evaluateArchitecture, Verdict } from '../../web/evaluator.js';
import { validateArchitecture } from '../../web/schema-validator.js';

// Mirrors web/serialize.js::canvasToArchitecture but operates on the
// template data directly (no Cytoscape DOM). Kept tight: only the
// fields the evaluator + schema actually read. Honours per-edge
// sourceOwner/targetOwner overrides (Batch 7) so multi-tenant endpoint
// conduits classify using the declared tenant, not owners[0].
function templateToArch(template) {
  const declaredOwners = new Map((template.owners ?? []).map((o) => [o.id, o]));
  const referencedOwners = new Set();

  for (const n of template.nodes ?? []) {
    for (const o of n.owners ?? []) referencedOwners.add(o);
  }
  for (const z of template.zones ?? []) {
    if (z.authority) referencedOwners.add(z.authority);
  }

  const ownerIds = [...referencedOwners].sort();
  const asset_owners = ownerIds.map((id) => ({
    id,
    role: declaredOwners.get(id)?.role ?? 'AO',
  }));

  const zone_authorities = (template.zones ?? [])
    .filter((z) => z.authority)
    .map((z) => ({ zone: z.id, org: z.authority }));
  const declaredZones = new Set(zone_authorities.map((z) => z.zone));

  const nodeIndex = new Map();
  for (const n of template.nodes ?? []) nodeIndex.set(n.id, n);

  const conduits = [];
  const sp_relations = [];
  for (const e of template.edges ?? []) {
    const src = nodeIndex.get(e.source);
    const tgt = nodeIndex.get(e.target);
    if (!src || !tgt) continue;
    const srcOwners = src.owners ?? [];
    const tgtOwners = tgt.owners ?? [];
    if (srcOwners.length === 0 || tgtOwners.length === 0) continue;
    const srcOwner = e.sourceOwner && srcOwners.includes(e.sourceOwner) ? e.sourceOwner : srcOwners[0];
    const tgtOwner = e.targetOwner && tgtOwners.includes(e.targetOwner) ? e.targetOwner : tgtOwners[0];
    const sZone = src.parent && declaredZones.has(src.parent) ? src.parent : null;
    const tZone = tgt.parent && declaredZones.has(tgt.parent) ? tgt.parent : null;
    const conduit = {
      id: e.id,
      from: sZone ? { owner: srcOwner, zone: sZone } : { owner: srcOwner },
      to:   tZone ? { owner: tgtOwner, zone: tZone } : { owner: tgtOwner },
    };
    if (typeof e.transitOwner === 'string' && e.transitOwner.length > 0) {
      conduit.transit_owner = e.transitOwner;
    }
    if (typeof e.transitAsset === 'string' && e.transitAsset.length > 0) {
      conduit.transit_asset = e.transitAsset;
    }
    conduits.push(conduit);
    if (e.spCovered) {
      sp_relations.push({ sp: srcOwner, ao: tgtOwner, scope: [e.id] });
    }
  }

  return {
    meta: { schema_version: '1', domain: template.meta?.domain ?? 'custom' },
    asset_owners,
    sp_relations,
    zone_authorities,
    conduits,
  };
}

test('every template id appears in TEMPLATE_ORDER and vice versa', () => {
  const ids = Object.keys(TEMPLATES).sort();
  const order = [...TEMPLATE_ORDER].sort();
  assert.deepEqual(order, ids);
});

test('every non-empty template passes schema validation', () => {
  for (const [id, t] of Object.entries(TEMPLATES)) {
    const arch = templateToArch(t);
    if (arch.conduits.length === 0) continue; // empty-canvas template
    assert.doesNotThrow(
      () => validateArchitecture(arch),
      `${id} must pass schema validation`,
    );
  }
});

test('every template declares evidence_level from the allowed set', () => {
  const allowed = new Set(['measured', 'analytic-hypothesis', 'custom']);
  for (const [id, t] of Object.entries(TEMPLATES)) {
    assert.ok(allowed.has(t.meta.evidence_level), `${id}: ${t.meta.evidence_level}`);
  }
});

test('airport-cupps-1.0 CD-01 carries Fig 2 visual routing data', () => {
  // The template must persist the visual routing (right-wall
  // endpoints + westward bezier control point) so loading the
  // template reproduces the paper Fig 2 layout. A template edit that
  // drops sourceFace / targetFace / controlPoint* would silently
  // degrade CD-01 to a straight diagonal through Airport IT.
  const t = TEMPLATES['airport-cupps-1.0'];
  const cd01 = t.edges.find((e) => e.id === 'CD-01');
  assert.ok(cd01, 'CD-01 missing from airport template');
  assert.equal(cd01.sourceFace, 'right');
  assert.equal(cd01.targetFace, 'right');
  assert.ok(Array.isArray(cd01.controlPointDistances) && cd01.controlPointDistances.length === 1);
  assert.ok(Array.isArray(cd01.controlPointWeights)   && cd01.controlPointWeights.length === 1);
  assert.ok(cd01.controlPointDistances[0] < 0,
    'CD-01 control-point distance must be negative (westward) to clear Airport IT');
});

test('airport-cupps-1.0 reproduces Paper Table 3 verdicts ID-for-ID (drawn 13)', () => {
  // The canvas template draws the 13 conduits that paper Fig 2 shows;
  // CD-20..23, 25..26 (6 single-tenant internal conduits) are omitted
  // for visual clarity and are documented in meta.description. The
  // authoritative 19-row Table 3 reproduction lives in
  // examples/airport-common-use-terminal.yaml and is exercised by
  // tests/test_samples.py::test_airport_sample_reproduces_paper_table3.
  const arch = templateToArch(TEMPLATES['airport-cupps-1.0']);
  validateArchitecture(arch);
  const report = evaluateArchitecture(arch);

  const actual = {};
  for (const r of report.results) actual[r.conduit_id] = r.verdict;

  const expected = {
    'CD-01':  Verdict.RESOLVED_BY_SP,
    'CD-02':  Verdict.NO_CROSS_AO,
    'CD-03':  Verdict.NO_CROSS_AO,
    'CD-04':  Verdict.BORDERLINE,
    'CD-05':  Verdict.BORDERLINE,
    'CD-06':  Verdict.BLIND_SPOT,
    'CD-07':  Verdict.NO_CROSS_AO,
    'CD-08a': Verdict.BLIND_SPOT,
    'CD-08b': Verdict.BLIND_SPOT,
    'CD-09':  Verdict.RESOLVED_BY_SP,
    'CD-10':  Verdict.NO_CROSS_AO,
    'CD-11':  Verdict.NO_CROSS_AO,
    'CD-24':  Verdict.NO_CROSS_AO,
  };

  assert.deepEqual(actual, expected);

  const dist = report.distribution();
  assert.equal(dist[Verdict.BLIND_SPOT], 3);
  assert.equal(dist[Verdict.BORDERLINE], 2);
  assert.equal(dist[Verdict.RESOLVED_BY_SP], 2);
  assert.equal(dist[Verdict.NO_CROSS_AO], 6);
  assert.equal(Object.values(dist).reduce((a, b) => a + b, 0), 13);
});

test('rail template produces at least 4 blind-spot verdicts (paper §8.1 hypothesis)', () => {
  const arch = templateToArch(TEMPLATES['rail-passenger-station']);
  validateArchitecture(arch);
  const report = evaluateArchitecture(arch);
  const bs = report.results.filter((r) => r.verdict === Verdict.BLIND_SPOT).length;
  assert.ok(bs >= 4, `expected >=4 blind-spots, got ${bs}`);
});

test('power-grid template produces cross-AO blind spots', () => {
  const arch = templateToArch(TEMPLATES['power-grid-tso-dso']);
  validateArchitecture(arch);
  const report = evaluateArchitecture(arch);
  const bs = report.results.filter((r) => r.verdict === Verdict.BLIND_SPOT).length;
  assert.ok(bs >= 2, `expected >=2 blind-spots, got ${bs}`);
});

test('empty template has no edges and trivially evaluates', () => {
  const arch = templateToArch(TEMPLATES['empty']);
  assert.equal(arch.conduits.length, 0);
  // An empty architecture has no nodes to evaluate; that's fine - the
  // user hasn't drawn anything yet.
});
