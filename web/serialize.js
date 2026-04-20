// Convert the live Cytoscape canvas into an architecture dict that the
// JS evaluator (web/evaluator.js) can consume. Also converts a template
// dict back into canvas elements.

import { applyOwnerColors } from './owner-colors.js';
//
// Conventions:
//   - A node's "primary owner" is the first entry of node.data('owners').
//     If a node has zero owners, every edge touching it is skipped (no
//     SC-1 can be computed).
//   - A zone is a Cytoscape compound node with class 'zone'; its
//     'zoneAuthority' data field names the designating organisation.
//   - An edge with data('spCovered') = true generates an sp_relations
//     entry `{sp: sourceOwner, ao: targetOwner, scope: [edge.id]}`. The
//     evaluator's _covers probe is symmetric so the source/target choice
//     does not affect the verdict.

export function canvasToArchitecture(canvas, library) {
  const cy = canvas.cy;

  // Collect every owner id referenced anywhere so the resulting
  // architecture passes referential-integrity checks.
  const assignedOwners = new Set();
  cy.nodes().forEach((n) => {
    if (n.hasClass('edge-bend-handle') || n.hasClass('edge-endpoint-handle')) return;
    if (n.hasClass('zone')) {
      const auth = n.data('zoneAuthority');
      if (auth) assignedOwners.add(auth);
    } else {
      const owners = n.data('owners') ?? [];
      for (const o of owners) assignedOwners.add(o);
    }
  });

  const reasons = [];
  if (assignedOwners.size < 2) {
    reasons.push(
      `Need at least 2 distinct owners to evaluate (currently ${assignedOwners.size}).`,
    );
  }

  const asset_owners = [...assignedOwners].sort().map((id) => {
    const chip = library.getChip(id);
    return { id, role: chip?.role ?? 'AO' };
  });

  const zone_authorities = [];
  cy.$('node.zone').forEach((z) => {
    const auth = z.data('zoneAuthority');
    if (auth) zone_authorities.push({ zone: z.id(), org: auth });
  });
  const declaredZones = new Set(zone_authorities.map((z) => z.zone));

  // Note: a zone's designating authority is a governance property
  // (who can partition the zone), not an ownership property. The
  // paper's federation-trust pattern (CD-04/CD-05) legitimately
  // places VND/ALN-owned OIDC clients inside an APT-designated zone,
  // so we do NOT warn when authority != any child's owner.

  const conduits = [];
  const sp_relations = [];
  const skipped = [];

  cy.edges().forEach((e) => {
    const src = e.source();
    const tgt = e.target();
    const srcOwners = src.data('owners') ?? [];
    const tgtOwners = tgt.data('owners') ?? [];
    if (srcOwners.length === 0 || tgtOwners.length === 0) {
      skipped.push({
        id: e.id(),
        reason: 'An endpoint has no owner assigned.',
      });
      return;
    }
    // Edge-level endpoint owner overrides let a multi-tenant endpoint
    // (e.g. 3-tenant CUPPS Workstation) declare which specific owner's
    // traffic this conduit represents. Falls back to the endpoint's
    // first owner when unset; the override is ignored if it names an
    // owner not actually assigned to the endpoint node (fail-safe).
    const srcOverride = e.data('sourceOwner');
    const tgtOverride = e.data('targetOwner');
    const srcOwner = srcOverride && srcOwners.includes(srcOverride) ? srcOverride : srcOwners[0];
    const tgtOwner = tgtOverride && tgtOwners.includes(tgtOverride) ? tgtOverride : tgtOwners[0];

    const srcParent = src.parent();
    const tgtParent = tgt.parent();
    const srcZoneRaw = srcParent.nonempty() ? srcParent.id() : null;
    const tgtZoneRaw = tgtParent.nonempty() ? tgtParent.id() : null;
    // Only declare a zone on an endpoint if the zone has an authority
    // registered. Referring to an undeclared zone would fail schema
    // validation.
    const srcZone = srcZoneRaw && declaredZones.has(srcZoneRaw) ? srcZoneRaw : null;
    const tgtZone = tgtZoneRaw && declaredZones.has(tgtZoneRaw) ? tgtZoneRaw : null;

    conduits.push({
      id: e.id(),
      from: srcZone ? { owner: srcOwner, zone: srcZone } : { owner: srcOwner },
      to:   tgtZone ? { owner: tgtOwner, zone: tgtZone } : { owner: tgtOwner },
    });

    if (e.data('spCovered')) {
      const entry = { sp: srcOwner, ao: tgtOwner, scope: [e.id()] };
      const subtype = e.data('spSubtype');
      // Only emit sp_subtype when it differs from the schema default
      // ('both'); keeps existing YAML fixtures byte-stable.
      if (subtype && subtype !== 'both') {
        entry.sp_subtype = subtype;
      }
      sp_relations.push(entry);
    }
  });

  if (conduits.length === 0) {
    reasons.push('No complete edges to evaluate (need both endpoints to have owners).');
  }

  if (reasons.length > 0) {
    return { arch: null, reasons, skipped };
  }

  return {
    arch: {
      meta: { schema_version: '1', domain: canvas.domain ?? 'custom' },
      asset_owners,
      sp_relations,
      zone_authorities,
      conduits,
    },
    reasons: [],
    skipped,
  };
}

/**
 * Like canvasToArchitecture, but enriched for YAML export: adds the
 * owner descriptions, conduit descriptions (edge label), conduit notes,
 * and canvas-level provenance (meta.source.paper, meta.disclaimer) so
 * the exported YAML is a self-contained human-readable artefact rather
 * than just the minimum the evaluator needs.
 *
 * Returns the same shape as canvasToArchitecture but always with
 * optional schema fields populated where they have meaningful values.
 */
export function canvasToFullArchitecture(canvas, library) {
  const base = canvasToArchitecture(canvas, library);
  if (!base.arch) return base;

  const arch = base.arch;
  const cy = canvas.cy;

  // Enrich asset_owners with chip descriptions.
  arch.asset_owners = arch.asset_owners.map((ao) => {
    const chip = library.getChip(ao.id);
    const out = { id: ao.id, role: ao.role };
    if (chip && chip.description && chip.description !== ao.id) {
      out.description = chip.description;
    }
    return out;
  });

  // Enrich conduits with description (edge label when it differs from id),
  // notes, and the optional direction annotation (unidirectional edges
  // only; bidirectional is the schema default and left implicit).
  arch.conduits = arch.conduits.map((c) => {
    const edge = cy.getElementById(c.id);
    const enriched = {
      id: c.id,
      from: c.from,
      to: c.to,
    };
    if (!edge.empty()) {
      const label = edge.data('label');
      if (label && label !== c.id) enriched.description = label;
      const notes = edge.data('notes');
      if (notes && notes.trim().length > 0) enriched.notes = notes;
      if (edge.data('directed')) {
        // Canvas-side "directed" is a UI-only arrowhead toggle; on YAML
        // export it becomes the richer direction / traffic_direction
        // pair so the Python CLI and audit workpapers see the intent.
        enriched.direction = 'unidirectional';
        enriched.traffic_direction = 'from-to';
      }
    }
    return enriched;
  });

  // Canvas-level provenance mirrored into meta.
  if (canvas.templateSource) {
    arch.meta.source = { paper: canvas.templateSource };
  }
  if (canvas.evidenceLevel) {
    arch.meta.evidence_level = canvas.evidenceLevel;
  }
  if (canvas.evidenceLevel === 'analytic-hypothesis') {
    arch.meta.disclaimer =
      'Analytic hypothesis per paper §8.1. Structural mapping from public standards; NOT empirically validated.';
  } else if (canvas.evidenceLevel === 'custom') {
    arch.meta.disclaimer =
      'User-drawn architecture. Verdicts reflect the inputs supplied by the author.';
  }
  if (
    Array.isArray(canvas.measurementPrerequisites) &&
    canvas.measurementPrerequisites.length > 0
  ) {
    arch.meta.measurement_prerequisites = canvas.measurementPrerequisites.slice();
  }

  if (canvas.review && (canvas.review.reviewer || canvas.review.reviewed_on)) {
    const rv = {};
    if (canvas.review.reviewer) rv.reviewer = canvas.review.reviewer;
    if (canvas.review.reviewed_on) rv.reviewed_on = canvas.review.reviewed_on;
    if (canvas.review.artefact_hash) rv.artefact_hash = canvas.review.artefact_hash;
    arch.meta.review = rv;
  }

  return { arch, reasons: [], skipped: base.skipped };
}

/**
 * Pure-data variant of canvasToArchitecture: converts a save-snapshot /
 * template-shape object directly into an evaluator input without
 * touching any Cytoscape instance. Used by the scenario-diff feature
 * (app.js) to evaluate a frozen fork snapshot alongside the live
 * canvas, and by the Node-side test harness.
 *
 * Returns `null` when the snapshot cannot produce a valid
 * architecture (fewer than 2 distinct owners, or zero complete edges).
 */
export function snapshotToArchitecture(snapshot, library) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const assigned = new Set();
  for (const n of snapshot.nodes ?? []) {
    for (const o of n.owners ?? []) assigned.add(o);
  }
  for (const z of snapshot.zones ?? []) {
    if (z.authority) assigned.add(z.authority);
  }
  if (assigned.size < 2) return null;

  const asset_owners = [...assigned].sort().map((id) => {
    const chip = library?.getChip?.(id);
    return { id, role: chip?.role ?? 'AO' };
  });

  const zone_authorities = (snapshot.zones ?? [])
    .filter((z) => z.authority)
    .map((z) => ({ zone: z.id, org: z.authority }));
  const declaredZones = new Set(zone_authorities.map((z) => z.zone));

  const nodeIndex = new Map();
  for (const n of snapshot.nodes ?? []) nodeIndex.set(n.id, n);

  const conduits = [];
  const sp_relations = [];

  for (const e of snapshot.edges ?? []) {
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

    conduits.push({
      id: e.id,
      from: sZone ? { owner: srcOwner, zone: sZone } : { owner: srcOwner },
      to:   tZone ? { owner: tgtOwner, zone: tZone } : { owner: tgtOwner },
    });

    if (e.spCovered) {
      const entry = { sp: srcOwner, ao: tgtOwner, scope: [e.id] };
      if (e.spSubtype && e.spSubtype !== 'both') entry.sp_subtype = e.spSubtype;
      sp_relations.push(entry);
    }
  }

  if (conduits.length === 0) return null;

  return {
    meta: {
      schema_version: '1',
      domain: snapshot.meta?.domain ?? 'custom',
    },
    asset_owners,
    sp_relations,
    zone_authorities,
    conduits,
  };
}

/**
 * Load a template into the canvas: replaces all existing elements,
 * declares any custom chips on the library, and paints evidence/domain.
 */
export function loadTemplateIntoCanvas(template, canvas, library) {
  const cy = canvas.cy;

  // 1. Ensure any owners the template declares exist in the library.
  for (const o of template.owners ?? []) {
    if (!library.getChip(o.id)) {
      try {
        library.addChip({
          id: o.id,
          label: o.label ?? o.id,
          role: o.role ?? 'AO',
          palette: o.palette ?? 'CUSTOM',
          description: o.description ?? o.label ?? o.id,
        });
      } catch (err) {
        console.warn(`template: could not register chip ${o.id}: ${err.message}`);
      }
    }
  }

  // 2. Replace all elements.
  cy.elements().remove();

  // 3. Add zones first (so child nodes can reference parent).
  for (const z of template.zones ?? []) {
    const colors = z.authority ? library.colorsFor(z.authority) : { border: '#bee3f8' };
    cy.add({
      group: 'nodes',
      data: {
        id: z.id,
        label: z.label ?? z.id,
        zoneAuthority: z.authority ?? null,
        borderColor: colors.border ?? '#bee3f8',
        notes: z.notes ?? '',
      },
      classes: 'zone',
      position: z.x !== undefined && z.y !== undefined ? { x: z.x, y: z.y } : undefined,
    });
  }

  // 4. Add regular nodes.
  for (const n of template.nodes ?? []) {
    const owners = n.owners ?? [];
    const label = n.label ?? n.id;
    const roleContext = typeof n.roleContext === 'string' ? n.roleContext : '';
    const displayLabel = roleContext.trim().length > 0 ? `${label}\n[${roleContext}]` : label;
    // Templates may set `multiTenant` explicitly to override the
    // auto-derived "owners.length > 1" rule. The paper's Fig 2 treats
    // CUPPS Workstation as multi-tenant (tenant coexistence) but CUPPS
    // Middleware as single-tenant despite also having two owners
    // (APT-HW / VND-software) - the distinction is coexistence of
    // independent sessions, not plain owner count.
    const multiTenant = typeof n.multiTenant === 'boolean'
      ? n.multiTenant
      : owners.length > 1;
    const added = cy.add({
      group: 'nodes',
      data: {
        id: n.id,
        label,
        displayLabel,
        roleContext,
        owners: [...owners],
        bgColor: '#e2e8f0',
        borderColor: '#a0aec0',
        multiTenant,
        notes: n.notes ?? '',
        parent: n.parent ?? undefined,
      },
      position: { x: n.x ?? 0, y: n.y ?? 0 },
    });
    applyOwnerColors(added, owners, library);
  }

  // 5. Add edges.
  for (const e of template.edges ?? []) {
    // Accept legacy `directed: bool`, legacy 'one-way' string, and the
    // current 4-state enum ('none' | 'forward' | 'reverse' | 'two-way').
    // Normalize so downstream code only sees the new enum, and keep
    // `directed` bool in sync for the legacy CSS selector.
    let direction = e.direction;
    if (direction === 'one-way') direction = 'forward';
    let directed = !!e.directed;
    if (!direction) direction = directed ? 'forward' : 'none';
    directed = direction !== 'none';
    const data = {
      id: e.id,
      label: e.label ?? e.id,
      source: e.source,
      target: e.target,
      directed,
      direction,
      spCovered: !!e.spCovered,
      spSubtype: e.spSubtype ?? 'both',
      notes: e.notes ?? '',
    };
    // Endpoint owner overrides are optional; only set when the template
    // explicitly provides them, to avoid polluting exported canvas state
    // with null keys.
    if (typeof e.sourceOwner === 'string' && e.sourceOwner.length > 0) {
      data.sourceOwner = e.sourceOwner;
    }
    if (typeof e.targetOwner === 'string' && e.targetOwner.length > 0) {
      data.targetOwner = e.targetOwner;
    }
    // Bezier control points: one or more (perpendicular distance,
    // weight) pairs along the source-to-target line. Templates use
    // these to route around intermediate nodes; user drag also writes
    // here. See web/canvas.js for the style mapper that feeds
    // Cytoscape's unbundled-bezier.
    if (Array.isArray(e.controlPointDistances) && Array.isArray(e.controlPointWeights) &&
        e.controlPointDistances.length === e.controlPointWeights.length &&
        e.controlPointDistances.length > 0) {
      data.controlPointDistances = e.controlPointDistances.slice();
      data.controlPointWeights   = e.controlPointWeights.slice();
    }
    // Legacy pre-unification save files used segmentDistances/Weights
    // for orthogonal routing. Migrate by keeping the MIDDLE bend as a
    // single bezier control point so the curve roughly matches the
    // user's earlier layout instead of silently collapsing to a
    // straight line (UX agent 2 #12).
    else if (Array.isArray(e.segmentDistances) && Array.isArray(e.segmentWeights) &&
             e.segmentDistances.length === e.segmentWeights.length &&
             e.segmentDistances.length > 0) {
      const mid = Math.floor(e.segmentDistances.length / 2);
      data.controlPointDistances = [e.segmentDistances[mid]];
      data.controlPointWeights   = [e.segmentWeights[mid]];
    }
    // Face-specific endpoints drive source-endpoint / target-endpoint
    // styles so the edge attaches to a chosen side of each node.
    const FACES = new Set(['top', 'bottom', 'left', 'right']);
    if (typeof e.sourceFace === 'string' && FACES.has(e.sourceFace)) {
      data.sourceFace = e.sourceFace;
    }
    if (typeof e.targetFace === 'string' && FACES.has(e.targetFace)) {
      data.targetFace = e.targetFace;
    }
    // Free-form endpoint overrides ("<n>% <n>%") take precedence over
    // the 4-cardinal face rules - they drive a per-element style
    // override set just below once the element is created.
    const sEp = typeof e.sourceEndpoint === 'string' ? e.sourceEndpoint : null;
    const tEp = typeof e.targetEndpoint === 'string' ? e.targetEndpoint : null;
    if (sEp) data.sourceEndpoint = sEp;
    if (tEp) data.targetEndpoint = tEp;
    const added = cy.add({ group: 'edges', data });
    if (sEp) added.style('source-endpoint', sEp);
    if (tEp) added.style('target-endpoint', tEp);
  }

  // 6. Tag has-notes for visual indicator.
  cy.elements().forEach((el) => {
    const n = el.data('notes');
    if (typeof n === 'string' && n.trim().length > 0) el.addClass('has-notes');
  });

  // 7. Canvas-level metadata.
  canvas.domain = template.meta?.domain ?? 'custom';
  canvas.evidenceLevel = template.meta?.evidence_level ?? 'custom';
  canvas.templateName = template.meta?.name ?? 'Custom architecture';
  canvas.templateDescription = template.meta?.description ?? '';
  canvas.templateSource = template.meta?.source ?? '';
  canvas.measurementPrerequisites = Array.isArray(template.meta?.measurement_prerequisites)
    ? template.meta.measurement_prerequisites.slice()
    : [];
  // Preserve review block if the template / snapshot carries one.
  // Defensive null-safe shape check: only accept reviewer / reviewed_on
  // / artefact_hash fields; everything else is dropped.
  const rv = template.meta?.review;
  if (rv && typeof rv === 'object' && !Array.isArray(rv)) {
    canvas.review = {
      reviewer: typeof rv.reviewer === 'string' ? rv.reviewer : null,
      reviewed_on: typeof rv.reviewed_on === 'string' ? rv.reviewed_on : null,
      artefact_hash: typeof rv.artefact_hash === 'string' ? rv.artefact_hash : null,
    };
  } else {
    canvas.review = null;
  }
}
