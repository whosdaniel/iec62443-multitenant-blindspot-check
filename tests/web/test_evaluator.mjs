// Unit tests for the JS evaluator + schema validator.
// Uses only the Node built-in test runner (node:test) and node:assert.
//
// Run with:   node --test tests/web/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateArchitecture, Verdict } from '../../web/evaluator.js';
import {
  validateArchitecture,
  SchemaError,
} from '../../web/schema-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ARCH = Object.freeze({
  meta: { schema_version: '1', domain: 'test' },
  asset_owners: [
    { id: 'APT', role: 'AO' },
    { id: 'ALN', role: 'AO' },
    { id: 'VND', role: 'AO' },
  ],
});

function arch(overrides) {
  const base = { ...BASE_ARCH };
  Object.assign(base, overrides);
  if (!('sp_relations' in base)) base.sp_relations = [];
  if (!('zone_authorities' in base)) base.zone_authorities = [];
  return base;
}

// ---------------------------------------------------------------------------
// Evaluator: classification logic
// ---------------------------------------------------------------------------

test('blind-spot when SC-1, NC-1, NC-2 all hold', () => {
  const a = arch({
    conduits: [
      {
        id: 'CD-X',
        from: { owner: 'APT', zone: 'Z-APT' },
        to: { owner: 'ALN', zone: 'Z-ALN' },
      },
    ],
    zone_authorities: [
      { zone: 'Z-APT', org: 'APT' },
      { zone: 'Z-ALN', org: 'ALN' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.sc1, true);
  assert.equal(r.nc1, true);
  assert.equal(r.nc2, true);
  assert.equal(r.verdict, Verdict.BLIND_SPOT);
  assert.ok(r.mitigation.length > 0, 'blind spots must expose mitigation options');
});

test('resolved-by-sp when a covering SP-AO relation exists', () => {
  const a = arch({
    conduits: [
      {
        id: 'CD-01',
        from: { owner: 'VND', zone: 'Z-VND' },
        to: { owner: 'APT', zone: 'Z-APT' },
      },
    ],
    sp_relations: [{ sp: 'VND', ao: 'APT', scope: ['CD-01'] }],
    zone_authorities: [
      { zone: 'Z-VND', org: 'VND' },
      { zone: 'Z-APT', org: 'APT' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.sc1, true);
  assert.equal(r.nc1, false);
  assert.equal(r.verdict, Verdict.RESOLVED_BY_SP);
});

test('sp_relations without scope covers all matching pairs', () => {
  const a = arch({
    conduits: [
      {
        id: 'CD-10',
        from: { owner: 'VND', zone: 'Z-VND' },
        to: { owner: 'APT', zone: 'Z-APT' },
      },
      {
        id: 'CD-11',
        from: { owner: 'VND', zone: 'Z-VND' },
        to: { owner: 'APT', zone: 'Z-APT' },
      },
    ],
    sp_relations: [{ sp: 'VND', ao: 'APT' }],
    zone_authorities: [
      { zone: 'Z-VND', org: 'VND' },
      { zone: 'Z-APT', org: 'APT' },
    ],
  });
  const byId = Object.fromEntries(
    evaluateArchitecture(a).results.map((r) => [r.conduit_id, r]),
  );
  assert.equal(byId['CD-10'].verdict, Verdict.RESOLVED_BY_SP);
  assert.equal(byId['CD-11'].verdict, Verdict.RESOLVED_BY_SP);
});

test('no-cross-ao when endpoints share the same owner', () => {
  const a = arch({
    conduits: [
      {
        id: 'CD-INTRA',
        from: { owner: 'APT', zone: 'Z-APT' },
        to: { owner: 'APT', zone: 'Z-APT' },
      },
    ],
    zone_authorities: [{ zone: 'Z-APT', org: 'APT' }],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.sc1, false);
  assert.equal(r.verdict, Verdict.NO_CROSS_AO);
});

test('borderline when a single org bridges both endpoint zones', () => {
  const a = arch({
    conduits: [
      {
        id: 'CD-BORD',
        from: { owner: 'APT', zone: 'Z-APT' },
        to: { owner: 'ALN', zone: 'Z-APT-SHARED' },
      },
    ],
    zone_authorities: [
      { zone: 'Z-APT', org: 'APT' },
      { zone: 'Z-APT-SHARED', org: 'APT' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.sc1, true);
  assert.equal(r.nc1, true);
  assert.equal(r.nc2, false);
  assert.equal(r.verdict, Verdict.BORDERLINE);
});

test('NC-2 falls back to SC-1 when zone metadata is absent', () => {
  const a = arch({
    conduits: [
      {
        id: 'CD-NOZONE',
        from: { owner: 'APT' },
        to: { owner: 'ALN' },
      },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.sc1, true);
  assert.equal(r.nc2, true);
});

test('distribution counts sum to the total number of conduits', () => {
  const a = arch({
    conduits: [
      { id: 'C1', from: { owner: 'APT' }, to: { owner: 'ALN' } },
      { id: 'C2', from: { owner: 'APT' }, to: { owner: 'APT' } },
      { id: 'C3', from: { owner: 'VND' }, to: { owner: 'APT' } },
    ],
    sp_relations: [{ sp: 'VND', ao: 'APT', scope: ['C3'] }],
  });
  const report = evaluateArchitecture(a);
  const dist = report.distribution();
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  assert.equal(total, report.results.length);
  assert.equal(total, 3);
});

test('default sp_subtype "both" covers the conduit (backward compat)', () => {
  const a = arch({
    conduits: [
      { id: 'CD-X',
        from: { owner: 'VND', zone: 'Z-VND' },
        to:   { owner: 'APT', zone: 'Z-APT' } },
    ],
    sp_relations: [{ sp: 'VND', ao: 'APT', scope: ['CD-X'] }],
    zone_authorities: [
      { zone: 'Z-VND', org: 'VND' },
      { zone: 'Z-APT', org: 'APT' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.nc1, false);
  assert.equal(r.verdict, Verdict.RESOLVED_BY_SP);
});

test('maintenance sp_subtype resolves NC-1', () => {
  const a = arch({
    conduits: [
      { id: 'CD-X',
        from: { owner: 'VND', zone: 'Z-VND' },
        to:   { owner: 'APT', zone: 'Z-APT' } },
    ],
    sp_relations: [{ sp: 'VND', ao: 'APT', scope: ['CD-X'], sp_subtype: 'maintenance' }],
    zone_authorities: [
      { zone: 'Z-VND', org: 'VND' },
      { zone: 'Z-APT', org: 'APT' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.verdict, Verdict.RESOLVED_BY_SP);
});

test('integration-only sp_subtype does NOT resolve NC-1 (paper §2.3)', () => {
  // Integration SP (62443-2-4 Cl. 3.1.12) covers design/install/commissioning
  // only; SP.08.02 BR monitoring obligation attaches to maintenance (Cl.
  // 3.1.13). The conduit must still classify as a structural blind spot.
  const a = arch({
    conduits: [
      { id: 'CD-X',
        from: { owner: 'VND', zone: 'Z-VND' },
        to:   { owner: 'APT', zone: 'Z-APT' } },
    ],
    sp_relations: [{ sp: 'VND', ao: 'APT', scope: ['CD-X'], sp_subtype: 'integration' }],
    zone_authorities: [
      { zone: 'Z-VND', org: 'VND' },
      { zone: 'Z-APT', org: 'APT' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.sc1, true);
  assert.equal(r.nc1, true, 'integration-only SP-AO must leave NC-1 satisfied');
  assert.equal(r.nc2, true);
  assert.equal(r.verdict, Verdict.BLIND_SPOT);
});

test('coexisting integration + maintenance relations resolve', () => {
  const a = arch({
    conduits: [
      { id: 'CD-X',
        from: { owner: 'VND', zone: 'Z-VND' },
        to:   { owner: 'APT', zone: 'Z-APT' } },
    ],
    sp_relations: [
      { sp: 'VND', ao: 'APT', scope: ['CD-X'], sp_subtype: 'integration' },
      { sp: 'VND', ao: 'APT', scope: ['CD-X'], sp_subtype: 'maintenance' },
    ],
    zone_authorities: [
      { zone: 'Z-VND', org: 'VND' },
      { zone: 'Z-APT', org: 'APT' },
    ],
  });
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.verdict, Verdict.RESOLVED_BY_SP);
});

test('non-AO role (integrator) does not produce a blind spot', () => {
  const a = {
    meta: { schema_version: '1', domain: 't' },
    asset_owners: [
      { id: 'APT', role: 'AO' },
      { id: 'INT', role: 'integrator' },
    ],
    conduits: [
      { id: 'CD-INT', from: { owner: 'APT' }, to: { owner: 'INT' } },
    ],
    sp_relations: [],
    zone_authorities: [],
  };
  const [r] = evaluateArchitecture(a).results;
  assert.equal(r.nc1, false);
  assert.notEqual(r.verdict, Verdict.BLIND_SPOT);
});

// ---------------------------------------------------------------------------
// Schema validator: accepts minimal valid, rejects malformed
// ---------------------------------------------------------------------------

test('validator accepts the minimal valid architecture', () => {
  assert.doesNotThrow(() => validateArchitecture(arch({
    conduits: [{ id: 'C1', from: { owner: 'APT' }, to: { owner: 'ALN' } }],
  })));
});

test('validator rejects unknown schema_version', () => {
  const bad = arch({
    meta: { schema_version: '99', domain: 'test' },
    conduits: [{ id: 'C1', from: { owner: 'APT' }, to: { owner: 'ALN' } }],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

test('validator rejects additionalProperties', () => {
  const bad = arch({
    conduits: [
      {
        id: 'C1',
        from: { owner: 'APT' },
        to: { owner: 'ALN' },
        typo_field: 'should fail',
      },
    ],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

test('validator rejects bad role enum', () => {
  const bad = arch({
    asset_owners: [
      { id: 'APT', role: 'HACKER' },
      { id: 'ALN', role: 'AO' },
    ],
    conduits: [{ id: 'C1', from: { owner: 'APT' }, to: { owner: 'ALN' } }],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

test('validator rejects bad id pattern (leading digit)', () => {
  const bad = arch({
    conduits: [
      {
        id: '1Cstart-with-digit',
        from: { owner: 'APT' },
        to: { owner: 'ALN' },
      },
    ],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

test('validator rejects endpoint owner not in asset_owners', () => {
  const bad = arch({
    conduits: [{ id: 'C1', from: { owner: 'NOPE' }, to: { owner: 'ALN' } }],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

test('validator rejects duplicate conduit ids', () => {
  const bad = arch({
    conduits: [
      { id: 'DUP', from: { owner: 'APT' }, to: { owner: 'ALN' } },
      { id: 'DUP', from: { owner: 'ALN' }, to: { owner: 'APT' } },
    ],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

test('validator rejects sp_relations.scope referencing unknown conduit', () => {
  const bad = arch({
    conduits: [{ id: 'C1', from: { owner: 'APT' }, to: { owner: 'ALN' } }],
    sp_relations: [{ sp: 'APT', ao: 'ALN', scope: ['CD-UNKNOWN'] }],
  });
  assert.throws(() => validateArchitecture(bad), SchemaError);
});

// ---------------------------------------------------------------------------
// Fail-closed on unknown schema keywords (Stage G / Batch 1)
// ---------------------------------------------------------------------------

test('validator throws when a schema uses an unsupported Draft 2020-12 keyword', async () => {
  // Construct a synthetic schema that uses `oneOf`, a keyword the web
  // validator deliberately does NOT implement. A silent-skip would let
  // invalid data pass on the browser side while the Python jsonschema
  // validator rejected it; we want loud failure instead.
  const schema = {
    type: 'object',
    required: ['meta', 'asset_owners', 'conduits'],
    additionalProperties: false,
    properties: {
      meta: {
        type: 'object',
        properties: {
          schema_version: { type: 'string', oneOf: [{ const: '1' }] },
          domain: { type: 'string' },
        },
        required: ['schema_version', 'domain'],
      },
      asset_owners: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' } } },
      },
      conduits: { type: 'array', items: { type: 'object' } },
    },
  };
  const data = { meta: { schema_version: '1', domain: 't' }, asset_owners: [], conduits: [] };
  assert.throws(
    () => validateArchitecture(data, schema),
    /Unsupported JSON Schema keyword 'oneOf'/,
  );
});

test('the bundled ARCHITECTURE_SCHEMA_V1 uses only keywords the validator knows', async () => {
  // Meta-sweep: walk the bundled schema and assert every key is in
  // KNOWN_SCHEMA_KEYWORDS. If someone adds a new constraint keyword to
  // schema.js without extending the validator, this test fires.
  const { ARCHITECTURE_SCHEMA_V1 } = await import('../../web/schema.js');
  const { KNOWN_SCHEMA_KEYWORDS } = await import('../../web/schema-validator.js');

  const unknown = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const key of Object.keys(node)) {
      if (!KNOWN_SCHEMA_KEYWORDS.has(key)) {
        unknown.push(`${where}.${key}`);
      }
    }
    // Recurse into sub-schemas the validator will walk.
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${where}.properties.${k}`);
    }
    if (node.items) walk(node.items, `${where}.items`);
    if (node.$defs) {
      for (const [k, v] of Object.entries(node.$defs)) walk(v, `${where}.$defs.${k}`);
    }
  };
  walk(ARCHITECTURE_SCHEMA_V1, '');
  assert.deepEqual(
    unknown,
    [],
    `ARCHITECTURE_SCHEMA_V1 uses keywords the validator does not handle: ${unknown.join(', ')}`,
  );
});
