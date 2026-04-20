// Architecture schema v1 - mirror of blindspotcheck/schemas/architecture-v1.json.
//
// Inlined as a JS constant so this module works in both Node and the browser
// without a network fetch or a bundler. The parity test
// tests/test_parity.py::test_web_schema_matches_python_schema verifies that
// this copy is byte-structurally identical (after JSON round-trip) to the
// Python-side JSON file, so a desync will fail CI.

export const ARCHITECTURE_SCHEMA_V1 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/whosdaniel/iec62443-multitenant-blindspot-check/schemas/architecture-v1.json",
  "title": "IEC 62443 Multi-Tenant Architecture Specification",
  "description": "Abstract multi-tenant architecture description for SC-1/NC-1/NC-2 blind-spot classification. Labels must be abstract roles (APT, ALN-A, etc.) - real operator identification is prohibited.",
  "type": "object",
  "required": ["meta", "asset_owners", "conduits"],
  "additionalProperties": false,
  "properties": {
    "meta": {
      "type": "object",
      "required": ["schema_version", "domain"],
      "additionalProperties": false,
      "properties": {
        "schema_version": {
          "type": "string",
          "enum": ["1"],
          "description": "Architecture schema version. Only '1' is accepted in this release."
        },
        "domain": {
          "type": "string",
          "description": "Domain tag (e.g. 'airport', 'rail', 'maritime', 'power-grid')."
        },
        "source": {
          "type": "object",
          "description": "Derivation provenance. REQUIRED when sample is derived from standards.",
          "properties": {
            "standards": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Public standards/specifications the architecture derives from."
            },
            "paper": {
              "type": "string",
              "description": "Optional citation of a paper describing the architecture."
            }
          }
        },
        "disclaimer": {
          "type": "string",
          "description": "Free-text disclaimer about label abstraction."
        },
        "evidence_level": {
          "type": "string",
          "enum": ["measured", "analytic-hypothesis", "custom"],
          "description": "How the architecture was produced. 'measured' = reproduces a paper measurement (the airport CUPPS 1.0 template is the only measured artefact in this repo). 'analytic-hypothesis' = structural mapping from public standards, not empirically validated (paper §8.1 cross-domain templates). 'custom' = user-drawn."
        },
        "measurement_prerequisites": {
          "type": "array",
          "maxItems": 50,
          "items": { "type": "string", "maxLength": 500 },
          "description": "For analytic-hypothesis architectures: the experimental or architectural observations that would have to be made to upgrade this artefact from analytic-hypothesis to measured. Paper §8.3 future work scaffold. Optional on measured or custom architectures."
        },
        "review": {
          "type": "object",
          "additionalProperties": false,
          "description": "Audit-trail metadata. 'reviewer' is the signing party, 'reviewed_on' is an ISO-8601 timestamp, 'artefact_hash' is the SHA-256 of the canonical JSON representation of the architecture at sign time. Canvas recomputes and shows the hash on every PDF export; the reviewer / reviewed_on fields are populated only when a user explicitly signs via the canvas UI.",
          "properties": {
            "reviewer": { "type": "string", "maxLength": 200 },
            "reviewed_on": { "type": "string", "maxLength": 40 },
            "artefact_hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
          }
        }
      }
    },
    "asset_owners": {
      "type": "array",
      "minItems": 2,
      "maxItems": 100,
      "items": {
        "type": "object",
        "required": ["id", "role"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
          "role": {
            "type": "string",
            "enum": ["AO", "SP", "integrator", "product_supplier"],
            "description": "IEC 62443 role. AO = asset owner (independent); SP = service provider. Only AO and SP are evaluated by SC-1/NC-1/NC-2."
          },
          "description": { "type": "string" }
        }
      }
    },
    "sp_relations": {
      "type": "array",
      "description": "List of service-provider-to-asset-owner relationships per IEC 62443-2-4 (Clauses 3.1.12, 3.1.13 and SP.08.02 BR). An SP-AO relationship whose sub-type includes 'maintenance' reaches SP.08.02 BR security-monitoring scope and satisfies NC-1. An 'integration'-only relationship does NOT reach monitoring scope (per Clause 3.1.12) and leaves NC-1 satisfied.",
      "maxItems": 1000,
      "items": {
        "type": "object",
        "required": ["sp", "ao"],
        "additionalProperties": false,
        "properties": {
          "sp": { "type": "string", "description": "id of the SP party" },
          "ao": { "type": "string", "description": "id of the AO party" },
          "scope": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional list of conduit ids that this SP-AO relationship covers. If omitted, the relationship is treated as covering every conduit whose endpoints match this SP-AO pair."
          },
          "sp_subtype": {
            "type": "string",
            "enum": ["integration", "maintenance", "both"],
            "description": "IEC 62443-2-4 SP sub-type. 'maintenance' (Clause 3.1.13) bears the security-monitoring obligation via SP.08.02 BR and satisfies NC-1 for covered conduits. 'integration' (Clause 3.1.12) covers design / installation / commissioning only and does NOT reach monitoring scope, so an integration-only relationship leaves NC-1 satisfied (possible blind-spot). Default 'both' treats the relationship as covering monitoring (backward-compatible with pre-Batch-4 YAML where this field was absent)."
          }
        }
      }
    },
    "zone_authorities": {
      "type": "array",
      "description": "Per IEC 62443-3-2:2020 ZCR 3 Clause 4.4: zone/conduit methodology presupposes a single designating organisation per zone. NC-2 is satisfied when a conduit's two endpoints live in zones controlled by *distinct* organisations (no single org can unilaterally assign monitoring authority).",
      "maxItems": 1000,
      "items": {
        "type": "object",
        "required": ["zone", "org"],
        "additionalProperties": false,
        "properties": {
          "zone": { "type": "string" },
          "org": { "type": "string", "description": "id of the designating organisation (must match an asset_owner id)" }
        }
      }
    },
    "conduits": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10000,
      "items": {
        "type": "object",
        "required": ["id", "from", "to"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
          "description": { "type": "string" },
          "from": { "$ref": "#/$defs/endpoint" },
          "to":   { "$ref": "#/$defs/endpoint" },
          "transit_owner": {
            "type": "string",
            "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
            "description": "Optional asset owner id of the artefact transiting this conduit, per the four-context artefact-ownership rule of W. Kim (2026) paper §3: (i) IATA RP 1797 Application Provider for passenger session data; (ii) IEC 62443-2-4 commissioning AO for SP-supplied code; (iii) OIDC issuer per OpenID Connect Core 1.0 §2 / RFC 6749 for federated identity assertions; (iv) originating AO for intra-tenant operational traffic. When absent, evaluator defaults transit_owner to from.owner (backward-compatible with pre-BATCH-8 YAML). The transit_owner enables the first disjunct of SC-1: a cross-AO artefact traversing a conduit whose endpoints share an asset owner still fires SC-1 (e.g., ALN session traffic transiting APT-owned CUPPS infrastructure, paper CD-06 / CD-08a / CD-05)."
          },
          "transit_asset": {
            "type": "string",
            "maxLength": 200,
            "description": "Optional free-text label describing the transiting artefact (e.g. 'ALN DCS session heartbeat', 'VND-issued federated identity claim'). Documentation only; not evaluated."
          },
          "notes": { "type": "string" },
          "direction": {
            "type": "string",
            "enum": ["unidirectional", "bidirectional"],
            "description": "Optional direction annotation. Paper §4 biconditional classification is symmetric with respect to conduit direction, so this field does NOT affect the verdict - it is documentation for audit workpapers that need to reason about traffic flow (e.g. NERC CIP-005 unidirectional-gateway conduits, IEC 62443-3-3 SR 6.2 direction-aware monitoring). Default (absent) is bidirectional."
          },
          "traffic_direction": {
            "type": "string",
            "enum": ["from-to", "to-from", "bidirectional"],
            "description": "When direction is 'unidirectional', identifies which endpoint is the traffic source. 'from-to' = conduit.from -> conduit.to; 'to-from' = reverse. Ignored when direction is 'bidirectional' or absent."
          }
        }
      }
    }
  },
  "$defs": {
    "endpoint": {
      "type": "object",
      "required": ["owner"],
      "additionalProperties": false,
      "properties": {
        "owner": { "type": "string", "description": "id of the asset_owner that owns this endpoint asset" },
        "zone":  { "type": "string", "description": "Optional zone label (referenced by zone_authorities)" },
        "asset": { "type": "string", "description": "Optional free-text asset label (e.g. 'CUPPS middleware')" }
      }
    }
  }
};
