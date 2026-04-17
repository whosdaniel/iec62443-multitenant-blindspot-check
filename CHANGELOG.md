# Changelog

All notable changes to BlindSpotCheck are documented here.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-17

Initial public release, accompanying Kim (2026) "Compliant Yet Blind: Measuring
and Closing Multi-Tenant Monitoring Gaps in IEC 62443".

### Added
- `blindspotcheck.evaluator` — pure-Python NC-1/NC-2/NC-3 evaluator implementing
  the biconditional of §4.1.
- `blindspotcheck.schema` — YAML loader with JSON-Schema (Draft 2020-12)
  validation, 1 MiB input cap, `yaml.safe_load`-only, refusal of
  `!!python/object` tags.
- `blindspotcheck.output` — text, JSON, and Markdown formatters.
- `blindspotcheck.cli` — `blindspotcheck` console entrypoint with
  `--format`, `--output`, `--validate`, `--schema`, `--fail-on-blind-spot`.
- Three framework-derived example architectures, each with explicit source
  standards citation and abstraction disclaimer:
  - `examples/airport-common-use-terminal.yaml` — derived from IATA RP 1797 +
    IEC 62443-2-4 + IEC 62443-3-2; reproduces Table 2 of Kim (2026).
  - `examples/rail-passenger-station.yaml` — derived from CENELEC
    CLC/TS 50701:2023 + IEC 62443-3-2.
  - `examples/maritime-container-terminal.yaml` — derived from IACS UR E26/E27
    + IMO MSC-FAL.1/Circ.3 + IEC 62443-3-2.
- pytest test suite (25 tests): core logic, schema validation, input-size cap,
  refusal of dangerous YAML tags, sample regression.
- GitHub Actions CI: pytest, bandit, pip-audit (all SHA-pinned).

### Security notes
- No dynamic code evaluation (`eval`, `exec`, `pickle`).
- No network calls. The tool is pure local compute.
- SSI sweep: all shipped example YAMLs carry only abstract role labels (APT,
  ALN-\*, VND, IM, TOC-\*, SSV, PortAuth, TermOp, ShipLine-\*). No real
  operator, vendor, or deployment identification.
