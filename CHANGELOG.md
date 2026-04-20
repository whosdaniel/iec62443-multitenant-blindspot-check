# Changelog

All notable changes to BlindSpotCheck are documented here.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-20

First public release of the companion tool for W. Kim (2026),
*"Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring
Gaps in IEC 62443"*. The repository at this tag reproduces paper
Table 3 and Appendix D.1 exactly and implements the paper §4 BATCH 8
2-disjunct SC-1 formulation and the §3 four-context artefact-ownership
rule. Python CLI is authoritative; the browser evaluator is a
line-for-line port verified by cross-language parity tests.

### BATCH 8 alignment with paper §4 (2-disjunct SC-1)
- SC-1 is now a 2-disjunct predicate per W. Kim (2026) paper §4
  BATCH 8: either the endpoint asset owners differ, or an artefact
  produced by a third asset owner transits the conduit. Earlier
  releases evaluated only the endpoint-AO disjunct; the transit
  disjunct catches multi-tenant structural patterns (ALN session
  traffic on APT-owned CUPPS infrastructure, VND-issued federated
  identity claims through APT IDP/DMZ) without needing the author to
  fold the artefact owner into `from.owner`.
- NC-1's same-endpoint-AO branch no longer hard-fails. Paper §4.1
  scopes NC-1 to the endpoint AO pair only; when endpoints coincide
  NC-1 reduces to `is_ao(endpoint_owner)`, so a conduit that fires
  SC-1 via the transit disjunct can still hold NC-1.
- `architecture-v1` schema gains optional `transit_owner` and
  `transit_asset` conduit fields. Pre-BATCH-8 YAML loads unchanged;
  `transit_owner` defaults to `from.owner`.
- Airport sample (`examples/airport-common-use-terminal.yaml`):
  - CD-05 canonicalised to the paper-canonical federation outbound
    leg (IDP -> DMZ) with `transit_owner: VND`. The prior
    per-airline inbound encoding (ALN-C -> IDP) is dropped from the
    canvas.
  - CD-06 / CD-08a / CD-08b switched to strict IEC 62443-2-1 Cl. 3.1.2
    HW-governance endpoint AOs with `transit_owner` carrying the
    session owner; verdicts unchanged.
  - CD-01 / CD-04 / CD-09 gain explicit `transit_owner` per the
    four-context artefact-ownership rule of paper §3.
- Canvas template (`web/templates.js`): mirrors the YAML updates and
  records `transitOwner` / `transitAsset` on each edge for round-trip
  through save/load, evaluator, and YAML export. The orphan
  `aln-c-fed` node and `VLAN-IDP-Fed-ALN` zone (required only by the
  old CD-05 inbound encoding) are removed.
- New regression: `tests/test_samples.py::test_airport_sample_matches_paper_appendix_d`
  asserts every in-scope conduit's `(T(c), AO(e1), AO(e2), D1, D2, SC-1)`
  tuple against paper Appendix D.1 exactly.
- `docs/design.md` and `docs/yaml-schema.md` rewritten to cover the
  4-context transit-artefact rule and the 2-disjunct SC-1 form.

### Added
#### Browser canvas (`web/`)
- Interactive canvas (Cytoscape.js 3.33.2 vendored; MIT; SHA-256 pinned
  in `web/vendor/cytoscape.min.js.sha256`). Draw nodes, edges, and
  compound zones; drag owner chips from the left onto nodes to assign
  asset owners, or onto zones to designate zone authority.
- Live verdict overlay: every graph change re-runs the evaluator and
  classifies each edge as blind-spot / borderline / resolved-by-sp /
  no-cross-ao / incomplete. Classes combine colour + line-style for
  colour-blind accessibility. Summary pill shows distribution counts.
- Five bundled templates: Airport CUPPS 1.0 (measured, reproduces
  paper Table 3) + rail/maritime/power-grid analytic-hypothesis
  templates (paper §8.1) + empty. Evidence banner reminds users that
  non-airport templates are paper §8.1 structural mapping, not
  validated results. CUPPS 2.0 variants (paper §8.2 Limitation 6) are
  deliberately not bundled because paper §8.3 defers their full
  classification to future work.
- Per-node, per-edge, per-zone notes stored in an `notes` field and
  rendered as a double-border (nodes) / source-label badge (edges).
- Save/Load `.blindspot.json` files, Export YAML (Python CLI input
  format, round-trip tested), Export PDF via browser print dialog.
- Undo/Redo with a 50-step snapshot stack (`web/history.js`).
- Opt-in auto-save every 30 seconds to LocalStorage. Bootstrap offers
  to restore the last auto-saved draft.
- Keyboard shortcuts (N/C/F/Delete/Escape/? plus Ctrl/Cmd+Z/Y/S/O/N
  combinations).
- Strict Content-Security-Policy: `script-src 'self'`,
  `connect-src 'none'`, no inline scripts. Tool is fully air-gap-safe.

#### Tooling + tests
- JS evaluator (`web/evaluator.js`), schema validator
  (`web/schema-validator.js`), and architecture schema constant
  (`web/schema.js`) all line-for-line mirror the Python side.
- Cross-language parity tests in `tests/test_parity.py`:
  - JS evaluator produces identical verdicts/flags/rationales to
    Python on every bundled sample.
  - JS YAML emitter produces text that Python's `load_architecture_from_text`
    ingests and evaluates to the expected distribution.
  - JS-side schema constant is byte-structurally identical to the
    Python JSON schema file.
- Node test runner covers `test_evaluator.mjs` (16), `test_templates.mjs`
  (7 incl. airport-cupps-1.0 Table 3 ID-for-ID), `test_history.mjs` (11),
  `test_yaml_export.mjs` (8).
- `.github/dependabot.yml` (weekly pip + GitHub Actions), `dependency-review.yml`
  (PR-block on vulnerable deps), `codeql.yml` (static analysis).
- CI job runs JS test matrix + `node --check` on every browser-only module.

### Changed
- Renamed predicates to match W. Kim (2026) Table 3 and §4.1 notation:
  - tool `NC-1` (distinct owners) -> `SC-1` (scope condition)
  - tool `NC-2` (SP-AO coverage) -> `NC-1` (role-typing)
  - tool `NC-3` (distinct zone orgs) -> `NC-2` (governance)
  Output keys, column headers, docstrings, and the JSON schema
  description strings updated in lockstep. Rationale: the previous
  labels diverged from the paper and blocked direct cross-reference
  between tool output and paper Table 3.
- Airport sample (`examples/airport-common-use-terminal.yaml`) rewritten
  to reproduce paper Table 3 ID-for-ID: CD-01..CD-11 multi-tenant
  conduits plus CD-20..CD-26 single-tenant, yielding 3/19 = 15.8%
  structural blind spots. CD-12 (EDS) is omitted per US 49 CFR Part
  1520 SSI sensitivity.
- `tests/test_samples.py::test_airport_sample_reproduces_paper_table3`
  checks every conduit's verdict exactly rather than aggregate counts.
- Author form standardised to `W. Kim` across `pyproject.toml`,
  `LICENSE`, `CITATION.cff`, `.zenodo.json`, and `README.md` BibTeX.
- README restructured around the browser canvas as the primary
  interface, with the CLI documented as the second entry point. Adds
  PR-policy, reproduction-vs-development (v1.0.0 tag pinning), and
  security-of-your-own-architectures sections.

### Security notes
- `yaml.safe_load` only on the Python side; JS side never parses YAML,
  it only emits it.
- Input caps: 1 MiB (YAML), 4 MiB (canvas save files).
- No `eval`, `Function()`, `pickle`, or shell invocation anywhere.
- CSP strict on the canvas. `base-uri 'self'`, `frame-ancestors 'none'`.

## [0.1.0] - 2026-04-17

Initial public release, accompanying W. Kim (2026) "Compliant Yet Blind:
Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443".

### Added
- `blindspotcheck.evaluator` - pure-Python biconditional evaluator.
- `blindspotcheck.schema` - YAML loader with JSON-Schema (Draft 2020-12)
  validation, 1 MiB input cap, `yaml.safe_load`-only, refusal of
  `!!python/object` tags.
- `blindspotcheck.output` - text, JSON, and Markdown formatters.
- `blindspotcheck.cli` - `blindspotcheck` console entrypoint with
  `--format`, `--output`, `--validate`, `--schema`, `--fail-on-blind-spot`.
- Three framework-derived example architectures, each with explicit source
  standards citation and abstraction disclaimer:
  - `examples/airport-common-use-terminal.yaml` - IATA RP 1797 +
    IEC 62443-2-4 + IEC 62443-3-2.
  - `examples/rail-passenger-station.yaml` - CENELEC CLC/TS 50701:2023 +
    IEC 62443-3-2.
  - `examples/maritime-container-terminal.yaml` - IACS UR E26/E27 +
    IMO MSC-FAL.1/Circ.3 + IEC 62443-3-2.
- pytest test suite: core logic, schema validation, input-size cap,
  refusal of dangerous YAML tags, sample regression.
- GitHub Actions CI: pytest, bandit, pip-audit (all SHA-pinned).

### Security notes
- No dynamic code evaluation (`eval`, `exec`, `pickle`).
- No network calls. The tool is pure local compute.
- SSI sweep: all shipped example YAMLs carry only abstract role labels (APT,
  ALN-\*, VND, IM, TOC-\*, SSV, PortAuth, TermOp, ShipLine-\*). No real
  operator, vendor, or deployment identification.
