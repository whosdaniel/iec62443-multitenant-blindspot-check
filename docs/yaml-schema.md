# YAML schema reference

Schema file: [`blindspotcheck/schemas/architecture-v1.json`](../blindspotcheck/schemas/architecture-v1.json).
Run `blindspotcheck --schema` to emit it.

## Top-level structure

```yaml
meta: {...}          # required
asset_owners: [...]  # required, 2..100 items
sp_relations: [...]  # optional
zone_authorities: [...]  # optional
conduits: [...]      # required, 1..10000 items
```

## `meta`

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `schema_version` | string, enum `"1"` | yes | only `"1"` accepted at this release |
| `domain` | string | yes | free tag, e.g. `airport`, `rail`, `maritime`, `power-grid` |
| `source.standards` | array of string | no (but strongly recommended) | public standard citations |
| `source.paper` | string | no | optional paper citation |
| `disclaimer` | string | no | abstraction / SSI disclaimer |

## `asset_owners`

Each entry:

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `id` | string, pattern `^[A-Za-z][A-Za-z0-9_-]{0,63}$` | yes | |
| `role` | enum: `AO`, `SP`, `integrator`, `product_supplier` | yes | only `AO` and `SP` are evaluated by NC-1/NC-2/NC-3 |
| `description` | string | no | |

Only endpoints whose owner has `role: AO` are considered "co-equal asset owners" for NC-2. Other roles (`integrator`, `product_supplier`) are treated as not-AO; conduits touching them will not satisfy NC-2.

## `sp_relations`

Each entry declares a service-provider-to-asset-owner relationship per IEC 62443-2-4 (Clauses 3.1.12 / 3.1.13 / SP.08.02 BR):

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `sp` | string | yes | id of the SP party (must be in `asset_owners`) |
| `ao` | string | yes | id of the AO party |
| `scope` | array of conduit ids | no | if omitted, the relation covers **every** conduit whose endpoints match the `(sp, ao)` pair |

If a conduit is covered by any SP-AO relation, NC-2 is FALSE for that conduit.

## `zone_authorities`

Each entry declares which organisation designates a given zone (IEC 62443-3-2 ZCR-1, Clauses 4.3.1-4.3.3):

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `zone` | string | yes | referenced by conduit endpoints |
| `org` | string | yes | must match an `asset_owners` id |

If a conduit's two endpoints lie in zones designated by the **same** organisation, NC-3 is FALSE.

If the conduit's endpoints don't declare `zone`, NC-3 falls back to NC-1 parity (distinct owners → distinct partitioning assumed).

## `conduits`

Each entry:

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `id` | string, pattern `^[A-Za-z][A-Za-z0-9_-]{0,63}$` | yes | must be unique |
| `description` | string | no | |
| `from` | endpoint | yes | see below |
| `to` | endpoint | yes | see below |
| `notes` | string | no | free-form commentary |

### Endpoint

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `owner` | string | yes | must match an `asset_owners` id |
| `zone` | string | no | referenced by `zone_authorities` for NC-3 evaluation |
| `asset` | string | no | free-text asset label |

## Full-featured example

See [`examples/airport-common-use-terminal.yaml`](../examples/airport-common-use-terminal.yaml).

## Extending to your own domain

1. List the asset owners (AO) in your fabric.
2. List SP-AO relationships. A relation without `scope:` covers every conduit between that pair.
3. List zone authorities if zones matter for NC-3 (optional but recommended).
4. Enumerate conduits. An "conduit" is any cross-zone traffic flow you care about monitoring.
5. Run `blindspotcheck your-file.yaml` and inspect the distribution.

**SSI / abstraction rule (for shipped samples):** every YAML intended for public release must carry `meta.source.standards` (citing the public documents it derives from) and `meta.disclaimer` (asserting abstraction). Do NOT embed real operator names, IP ranges, VLAN IDs, or vendor product IDs. Use role labels (APT, ALN-A, VND, IM, TOC-*, PortAuth, etc.).
