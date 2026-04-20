// Pure evaluator for the SC-1 / NC-1 / NC-2 biconditional from
// W. Kim (2026) "Compliant Yet Blind" §4.1.
//
// This module is a line-for-line port of blindspotcheck/evaluator.py.
// The Python implementation is the authoritative reference; parity is
// verified by tests/test_parity.py which compares verdicts cell-by-cell
// on every bundled example.
//
// No I/O, no DOM, no fetch. Pure functions over plain JS objects. Safe
// to import from both Node (tests) and a browser (the canvas UI in
// later stages).

export const Verdict = Object.freeze({
  BLIND_SPOT: 'blind-spot',
  BORDERLINE: 'borderline',
  RESOLVED_BY_SP: 'resolved-by-sp',
  NO_CROSS_AO: 'no-cross-ao',
});

/**
 * Run SC-1/NC-1/NC-2 evaluation across every conduit in `arch`.
 * Caller must have validated `arch` against the schema first.
 *
 * @param {object} arch  pre-validated architecture dict
 * @returns {{
 *   domain: string,
 *   source_standards: string[],
 *   results: Array<object>,
 *   distribution: () => Record<string, number>,
 *   blind_spots: () => Array<object>,
 * }}
 */
export function evaluateArchitecture(arch) {
  const assetOwners = arch.asset_owners ?? [];
  const roleById = Object.fromEntries(assetOwners.map((ao) => [ao.id, ao.role]));
  const spRelations = indexSpRelations(arch.sp_relations ?? []);
  const zoneAuthorities = arch.zone_authorities ?? [];
  const zoneOrg = Object.fromEntries(zoneAuthorities.map((z) => [z.zone, z.org]));

  const conduits = arch.conduits ?? [];
  const results = conduits.map((c) =>
    evaluateConduit(c, roleById, spRelations, zoneOrg),
  );

  const meta = arch.meta ?? {};
  const source = meta.source ?? {};
  const standards = Array.isArray(source.standards) ? source.standards.slice() : [];

  return {
    domain: meta.domain ?? 'unknown',
    source_standards: standards,
    results,
    distribution: () => distributionOf(results),
    blind_spots: () => results.filter((r) => r.verdict === Verdict.BLIND_SPOT),
  };
}

function distributionOf(results) {
  const counts = {
    [Verdict.BLIND_SPOT]: 0,
    [Verdict.BORDERLINE]: 0,
    [Verdict.RESOLVED_BY_SP]: 0,
    [Verdict.NO_CROSS_AO]: 0,
  };
  for (const r of results) counts[r.verdict] += 1;
  return counts;
}

/**
 * Index SP-AO relations by (sp, ao) pair.
 *
 * Each key maps to an array of relation entries
 *   { scope: Set<string> | null, subtype: string }
 * kept as a list (not folded) because a single (sp, ao) pair can carry
 * two distinct relationships (one integration, one maintenance) that
 * must be evaluated independently. The default `subtype` is 'both' for
 * entries where `sp_subtype` is absent, preserving pre-Batch-4 behaviour.
 */
function indexSpRelations(relations) {
  const idx = new Map();
  for (const rel of relations) {
    const key = spKey(rel.sp, rel.ao);
    const entry = {
      scope: Array.isArray(rel.scope) ? new Set(rel.scope) : null,
      subtype: rel.sp_subtype ?? 'both',
    };
    const existing = idx.get(key);
    if (existing) existing.push(entry);
    else idx.set(key, [entry]);
  }
  return idx;
}

function spKey(sp, ao) {
  // Distinct separator so ids containing "->" do not collide.
  return `${sp}\u0000${ao}`;
}

/**
 * True when an SP-AO relation whose sub-type reaches monitoring scope
 * (maintenance or both) covers this conduit. Integration-only SPs do
 * NOT reach monitoring per IEC 62443-2-4 Cl. 3.1.12 vs 3.1.13; paper
 * §2.3. Mirrors blindspotcheck/evaluator.py::_covers.
 */
function covers(spRelations, sp, ao, cid) {
  const key = spKey(sp, ao);
  const entries = spRelations.get(key);
  if (!entries) return false;
  for (const entry of entries) {
    if (entry.subtype === 'integration') continue;
    if (entry.scope === null) return true;
    if (entry.scope.has(cid)) return true;
  }
  return false;
}

function evaluateConduit(c, roleById, spRelations, zoneOrg) {
  const conduitId = c.id;
  const fromOwner = c.from.owner;
  const toOwner = c.to.owner;
  const fromZone = c.from.zone;
  const toZone = c.to.zone;

  // SC-1 (scope): endpoints belong to distinct asset owners.
  const sc1 = fromOwner !== toOwner;

  const isAo = (ownerId) => roleById[ownerId] === 'AO';

  // NC-1 (role-typing): no SP-AO relationship covers this conduit AND both
  // endpoint owners are independent asset owners (not SPs of each other).
  let nc1;
  if (!sc1) {
    // Same-owner conduit: NC-1 is trivially not satisfied (single-AO).
    nc1 = false;
  } else {
    const bilateralCovered =
      covers(spRelations, fromOwner, toOwner, conduitId) ||
      covers(spRelations, toOwner, fromOwner, conduitId);
    const bothAos = isAo(fromOwner) && isAo(toOwner);
    nc1 = !bilateralCovered && bothAos;
  }

  // NC-2 (governance): no single organisation designates the zones at both
  // endpoints. Falls back to SC-1 parity when no zone metadata is present.
  let nc2;
  const hasZoneMeta = fromZone && toZone && Object.keys(zoneOrg).length > 0;
  if (hasZoneMeta) {
    const fromOrg = zoneOrg[fromZone];
    const toOrg = zoneOrg[toZone];
    if (fromOrg === undefined || toOrg === undefined) {
      // Missing zone designation => conservative fallback.
      nc2 = true;
    } else {
      nc2 = fromOrg !== toOrg;
    }
  } else {
    nc2 = sc1;
  }

  const { verdict, mitigation, rationale } = classify(sc1, nc1, nc2);

  return {
    conduit_id: conduitId,
    sc1,
    nc1,
    nc2,
    verdict,
    mitigation,
    rationale,
  };
}

function classify(sc1, nc1, nc2) {
  if (sc1 && nc1 && nc2) {
    return {
      verdict: Verdict.BLIND_SPOT,
      mitigation: [
        'Break SC-1: consolidate endpoints under a single asset owner.',
        'Break NC-1: establish a contractual SP-AO relationship covering the conduit.',
        'Break NC-2: assign a single partitioning authority over both endpoints (out-of-band agreement).',
      ],
      rationale:
        'SC-1 AND NC-1 AND NC-2: structural monitoring blind spot (biconditional \u00a74.1).',
    };
  }
  if (sc1 && nc1 && !nc2) {
    return {
      verdict: Verdict.BORDERLINE,
      mitigation: ['Clarify zone designation to confirm or exclude NC-2.'],
      rationale:
        'SC-1 AND NC-1 hold but a single organisation bridges both endpoint zones (NC-2 fails): borderline.',
    };
  }
  if (sc1 && !nc1) {
    return {
      verdict: Verdict.RESOLVED_BY_SP,
      mitigation: [],
      rationale:
        'Cross-AO conduit but an SP-AO relationship covers it: obligations flow via IEC 62443-2-4.',
    };
  }
  // not sc1: same-owner conduit (no cross-AO split)
  return {
    verdict: Verdict.NO_CROSS_AO,
    mitigation: [],
    rationale: 'Both endpoints owned by the same party: not a multi-tenant conduit.',
  };
}
