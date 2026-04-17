# BlindSpotCheck

**IEC 62443 multi-tenant monitoring blind-spot evaluator.**

Given an abstract description of a multi-tenant architecture (YAML), BlindSpotCheck evaluates the **NC-1 AND NC-2 AND NC-3** biconditional from Kim (2026) *"Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443"* and reports which conduits are **structural monitoring blind spots**.

```
NC-1(c) : endpoints of conduit c belong to distinct asset owners.
NC-2(c) : no service-provider-to-asset-owner (SP-AO) relationship covers c.
NC-3(c) : no single organisation designates the zones at both endpoints.

BlindSpot(c) <==> NC-1(c) AND NC-2(c) AND NC-3(c)
```

Each NC condition is derived from a specific IEC 62443 clause (NC-1, NC-2) or from the role model itself (NC-3). The biconditional is architecture-invariant: any architecture to which the IEC 62443 role model is applied will see the same blind-spot pattern wherever the three conditions hold.

## Install

Requires Python ≥ 3.10.

```bash
pip install blindspotcheck
# or from source:
git clone https://github.com/wwkim/iec62443-multitenant-blindspot-check
cd iec62443-multitenant-blindspot-check
pip install -e ".[dev]"
```

## Use

```bash
# Evaluate an architecture
blindspotcheck examples/airport-common-use-terminal.yaml

# JSON or Markdown output
blindspotcheck examples/rail-passenger-station.yaml --format json
blindspotcheck examples/maritime-container-terminal.yaml --format markdown

# Fail a CI job if any blind spots exist
blindspotcheck my-arch.yaml --fail-on-blind-spot

# Validate YAML against the schema only
blindspotcheck my-arch.yaml --validate

# Emit the bundled JSON schema
blindspotcheck --schema > architecture-v1.json
```

## Minimal YAML

```yaml
meta:
  schema_version: "1"
  domain: my-fabric
asset_owners:
  - { id: APT, role: AO }
  - { id: ALN, role: AO }
  - { id: VND, role: AO }
sp_relations:
  - { sp: VND, ao: APT }     # covers every APT<->VND conduit
zone_authorities:
  - { zone: Z-APT, org: APT }
  - { zone: Z-ALN, org: ALN }
  - { zone: Z-VND, org: VND }
conduits:
  - id: CD-APT-ALN
    from: { owner: APT, zone: Z-APT }
    to:   { owner: ALN, zone: Z-ALN }
  - id: CD-APT-VND
    from: { owner: APT, zone: Z-APT }
    to:   { owner: VND, zone: Z-VND }
```

Output:

```
Conduit       NC-1  NC-2  NC-3  Verdict           Rationale
-----------------------------------------------------------
CD-APT-ALN    Y     Y     Y     blind-spot        ...
CD-APT-VND    Y     -     Y     resolved-by-sp    ...
```

## Bundled examples

Every bundled example cites the standards it derives from. No real operator, vendor, or deployment identification is included.

| File | Domain | Derivation source |
|------|--------|-------------------|
| [`examples/airport-common-use-terminal.yaml`](examples/airport-common-use-terminal.yaml) | airport | IATA RP 1797 + IEC 62443-2-4/3-2 + ACRP Report 30. **Reproduces Table 2 of Kim (2026).** |
| [`examples/rail-passenger-station.yaml`](examples/rail-passenger-station.yaml) | rail | CENELEC CLC/TS 50701:2023 + IEC 62443-3-2. |
| [`examples/maritime-container-terminal.yaml`](examples/maritime-container-terminal.yaml) | maritime | IACS UR E26/E27 + IMO MSC-FAL.1/Circ.3 + IEC 62443-3-2. |

## YAML schema

See [`blindspotcheck/schemas/architecture-v1.json`](blindspotcheck/schemas/architecture-v1.json) or run `blindspotcheck --schema`.

## Classification rules

| NC-1 | NC-2 | NC-3 | Verdict          | Meaning |
|------|------|------|------------------|---------|
| Y    | Y    | Y    | **blind-spot**   | Structural monitoring blind spot (biconditional §4.1). |
| Y    | Y    | –    | borderline       | Multi-AO, uncovered, but a single org designates both zones. |
| Y    | –    | *    | resolved-by-sp   | SP-AO relationship covers the conduit (IEC 62443-2-4 obligations flow). |
| –    | *    | *    | no-cross-ao      | Same-owner endpoints; not a multi-tenant conduit. |

## Security posture

- Input YAML is parsed with `yaml.safe_load` only. Python object tags are rejected.
- Input size is capped at 1 MiB before parsing.
- Strict schema validation (`additionalProperties: false`) catches typos and unknown fields.
- No network calls. No dynamic evaluation (`eval`, `exec`, `pickle`). No shell invocation.
- CI runs `bandit` and `pip-audit` on every push; GitHub Actions are SHA-pinned.

## Development

```bash
pip install -e ".[dev]"
pytest
bandit -r blindspotcheck
pip-audit
```

## Cite

If you use BlindSpotCheck in academic work, please cite both the tool and the paper it accompanies.

See [`CITATION.cff`](CITATION.cff). BibTeX:

```bibtex
@software{kim2026blindspotcheck,
  author  = {Kim, Woowi (Danny)},
  title   = {{BlindSpotCheck: IEC 62443 multi-tenant monitoring blind-spot evaluator}},
  year    = {2026},
  version = {0.1.0},
  doi     = {10.5281/zenodo.XXXXX},
  url     = {https://github.com/wwkim/iec62443-multitenant-blindspot-check}
}

@article{kim2026compliant,
  author  = {Kim, Woowi (Danny)},
  title   = {{Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443}},
  year    = {2026},
  note    = {Submitted to IJCIP}
}
```

The companion testbed (used to measure the verdict transition in §5) is archived at [10.5281/zenodo.19617578](https://doi.org/10.5281/zenodo.19617578).

## License

MIT. See [`LICENSE`](LICENSE).
