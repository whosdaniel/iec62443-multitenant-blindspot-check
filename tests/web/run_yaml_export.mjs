// Helper for tests/test_parity.py: given a template id on argv, resolve
// the template to an architecture dict (mirror of what the canvas
// serializer does) and print YAML to stdout. The Python side then
// loads and validates the YAML via blindspotcheck.load_architecture_from_text.

import { TEMPLATES } from '../../web/templates.js';
import { archToYaml } from '../../web/yaml-export.js';

const templateId = process.argv[2];
if (!templateId) {
  console.error('Usage: node run_yaml_export.mjs <template-id>');
  process.exit(2);
}
const template = TEMPLATES[templateId];
if (!template) {
  console.error(`Unknown template: ${templateId}`);
  process.exit(2);
}

// Mirror the minimal subset of canvasToArchitecture that a template
// needs. Same logic lives in tests/web/test_templates.mjs.
function templateToArch(t) {
  const declaredOwners = new Map((t.owners ?? []).map((o) => [o.id, o]));
  const referenced = new Set();
  for (const n of t.nodes ?? []) for (const o of n.owners ?? []) referenced.add(o);
  for (const z of t.zones ?? []) if (z.authority) referenced.add(z.authority);

  const asset_owners = [...referenced].sort().map((id) => {
    const o = declaredOwners.get(id);
    const out = { id, role: o?.role ?? 'AO' };
    if (o?.description) out.description = o.description;
    return out;
  });

  const zone_authorities = (t.zones ?? [])
    .filter((z) => z.authority)
    .map((z) => ({ zone: z.id, org: z.authority }));
  const declaredZones = new Set(zone_authorities.map((z) => z.zone));

  const nodeIndex = new Map();
  for (const n of t.nodes ?? []) nodeIndex.set(n.id, n);

  const conduits = [];
  const sp_relations = [];
  for (const e of t.edges ?? []) {
    const src = nodeIndex.get(e.source);
    const tgt = nodeIndex.get(e.target);
    if (!src || !tgt) continue;
    const srcOwners = src.owners ?? [];
    const tgtOwners = tgt.owners ?? [];
    if (srcOwners.length === 0 || tgtOwners.length === 0) continue;
    const sZone = src.parent && declaredZones.has(src.parent) ? src.parent : null;
    const tZone = tgt.parent && declaredZones.has(tgt.parent) ? tgt.parent : null;
    const srcOwner = e.sourceOwner && srcOwners.includes(e.sourceOwner) ? e.sourceOwner : srcOwners[0];
    const tgtOwner = e.targetOwner && tgtOwners.includes(e.targetOwner) ? e.targetOwner : tgtOwners[0];
    const c = {
      id: e.id,
      from: sZone ? { owner: srcOwner, zone: sZone } : { owner: srcOwner },
      to:   tZone ? { owner: tgtOwner, zone: tZone } : { owner: tgtOwner },
    };
    if (e.notes) c.notes = e.notes;
    conduits.push(c);
    if (e.spCovered) {
      sp_relations.push({ sp: srcOwner, ao: tgtOwner, scope: [e.id] });
    }
  }

  return {
    meta: { schema_version: '1', domain: t.meta?.domain ?? 'custom' },
    asset_owners,
    sp_relations,
    zone_authorities,
    conduits,
  };
}

const arch = templateToArch(template);
const header =
  `Round-trip fixture - template ${templateId}\n` +
  `Evidence level: ${template.meta?.evidence_level ?? 'custom'}\n` +
  `Source: ${template.meta?.source ?? '(none)'}`;
process.stdout.write(archToYaml(arch, { header }));
