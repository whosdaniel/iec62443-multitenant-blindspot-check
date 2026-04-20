# Design notes

## Why this tool exists

W. Kim (2026) *"Compliant Yet Blind"* derives a biconditional:

```
SC-1(c)  ==>  [ BlindSpot(c)  <==>  NC-1(c) AND NC-2(c) ]
```

for any conduit `c` in an IEC 62443-governed architecture. The paper shows that an airport OT environment with a common-use CUPPS deployment yields 3 structural blind-spot conduits out of 19 in-scope (paper §5.4, Table 3). The biconditional itself is **architecture-invariant**: any multi-tenant OT fabric to which the IEC 62443 role model is applied will see the same pattern wherever SC-1, NC-1, and NC-2 simultaneously hold.

**BlindSpotCheck operationalises that biconditional.** Given any YAML description of conduits, owners, SP relationships, and zone authorities, it mechanically classifies each conduit - removing subjective judgement and letting deployments audit themselves against the structural criterion.

## The scope condition and two necessary conditions

| | Source | Encoded as |
|---|---|---|
| **SC-1** | IEC 62443-2-1:2024 Clause 3.1.2 (Asset Owner definition); IATA RP 1797 Application Provider; IEC 62443-2-4:2023 Cl. 3.1.12 / 3.1.13 commissioning AO; OpenID Connect Core 1.0 §2 / RFC 6749 issuer | Cross-AO exposure exists on the conduit, either because the endpoint asset owners differ, or because an artefact produced by a third asset owner transits the conduit. Either disjunct satisfies SC-1. |
| **NC-1** | IEC 62443-2-4:2023 Clauses 3.1.12 (integration SP), 3.1.13 (maintenance SP), SP.08.02 BR (SP-AO log-sharing) | No SP-AO relationship covers the conduit, AND both endpoint owners have role `AO` (neither is a service provider under 62443-2-4). Scoped to the endpoint AO pair per paper §4.1, not to the transit artefact owner. |
| **NC-2** | IEC 62443-3-2:2020 ZCR 3 Clause 4.4 (zone/conduit methodology; in particular ZCR 3.1 Clause 4.4.2) | The two endpoint zones are designated by distinct organisations (no single organisation partitions both endpoints). On multi-tenant endpoints the designating authority is read per tenant session context, not per physical VLAN. |

SC-1 is the scope condition - it decides whether the biconditional applies at all. NC-1 and NC-2 are the two necessary conditions whose conjunction, given SC-1, is equivalent to a blind spot.

### Transit artefact ownership (W. Kim 2026 paper §3 four-context rule)

When a conduit carries an artefact whose producer is a non-endpoint asset owner, the artefact's owner decides whether SC-1's first disjunct fires. The rule assigns one owner per transit artefact across four contexts present in the airport testbed:

1. **IATA RP 1797 passenger session data** - the airline Application Provider is the owner of PNR records, passport MRZ data, boarding-pass and session state.
2. **IEC 62443-2-4 commissioning AO for SP-supplied software** - vendor middleware, agents, or configuration pushed under a maintenance agreement become assets of the commissioning AO upon handover (per Clauses 3.1.12 / 3.1.13).
3. **OpenID Connect Core 1.0 §2 / RFC 6749 federated identity** - a federated identity assertion retains the issuer's ownership even while traversing an IDP operated by a different organisation.
4. **Intra-tenant operational traffic** - for telemetry, PLC control, building-management events, and firmware updates whose source and sink live inside a single AO's infrastructure, the originating AO is the transit-artefact owner by construction.

The evaluator reads the per-conduit `transit_owner` field (optional in `architecture-v1.json`); when absent, it defaults to `from.owner` so pre-BATCH-8 YAML keeps evaluating with the legacy endpoint-only SC-1.

## Verdict matrix

| SC-1 | NC-1 | NC-2 | Verdict | Meaning |
|------|------|------|---------|---------|
| Y | Y | Y | `blind-spot` | Structural monitoring blind spot. |
| Y | Y | - | `borderline` | Cross-AO, uncovered, but a single org bridges the zones. Easy to slide into a blind spot if governance splits. |
| Y | - | * | `resolved-by-sp` | An SP-AO relationship covers the conduit; IEC 62443-2-4 log-sharing obligations apply. |
| - | * | * | `no-cross-ao` | Same-owner endpoints with no cross-AO transit artefact. Not a multi-tenant conduit. |

## Evaluation algorithm (pseudocode)

```python
for conduit c in architecture.conduits:
    a, b = c.from.owner, c.to.owner
    t = c.transit_owner if "transit_owner" in c else a

    # SC-1 (2-disjunct form, paper §4 BATCH 8):
    #   D1 fires when a cross-AO artefact transits c
    #   D2 fires when the endpoint AOs differ
    sc1 = (t not in {a, b}) or (a != b)

    if a == b:
        # NC-1 reduces to "that AO is independent" when endpoints coincide;
        # no bilateral SP relationship is possible between a single org and itself.
        nc1 = (roles[a] == "AO")
    else:
        covered = any(sp-ao relation covers (a, b, c.id))
        both_aos = roles[a] == "AO" and roles[b] == "AO"
        nc1 = (not covered) and both_aos

    if zones declared:
        nc2 = zone_org[c.from.zone] != zone_org[c.to.zone]
    else:
        nc2 = (a != b)  # fallback: endpoint-AO difference approximation

    verdict = classify(sc1, nc1, nc2)
```

The per-row trace of SC-1's two disjuncts across the airport testbed's 19 in-scope conduits plus the excluded CD-12 is locked by `tests/test_samples.py::test_airport_sample_matches_paper_appendix_d` against the values tabulated in paper Appendix D.1.

## Design choices

**Pure Python, no external service.** The tool is a local analyser. It never contacts the network. This keeps it auditable, reproducible, and acceptable for air-gapped review.

**Abstract labels only.** The schema does not accept IP addresses, real vendor names, real organisation names, or MAC addresses. Labels are role-level identifiers like `APT`, `ALN-A`, `VND`. This lets architectures from regulated deployments be shared without leaking Sensitive Security Information (SSI).

**Schema-first.** A JSON-Schema (Draft 2020-12) file lives next to the Python code and is the contract. `blindspotcheck --schema` emits it. Downstream tools can validate independently.

**Endpoint-AO NC-2 fallback.** When zones are not declared, the evaluator uses `from.owner != to.owner` as an NC-2 approximation. The common case - each asset owner designating its own zones - preserves the right verdict. This fallback replaces an earlier `nc2 = sc1` rule that briefly diverged once SC-1 gained its transit-artefact disjunct.

## Serialisation surfaces

The tool writes three file-level representations of an architecture, and they have distinct roles. If you are sharing an architecture with a collaborator, a paper reviewer, or a downstream tool, pick the right one on purpose.

### CLI YAML (`architecture-v1` schema) --- authoritative wire format

The schema at `blindspotcheck/schemas/architecture-v1.json` is the **authoritative** representation of an architecture for evaluation and archival. The Python CLI (`blindspotcheck <file>`) reads it, the JS-side validator mirrors it byte-for-byte, and the parity tests (`tests/test_parity.py`) verify both sides produce identical verdicts.

Emit this format via the canvas **Export YAML** button, or hand-author it against the schema. Share it when:

- a paper reviewer or auditor needs a file that reproduces a measurement;
- a CI pipeline wants to run `blindspotcheck --fail-on-blind-spot`;
- you want a format independent of canvas geometry that round-trips through `yaml.safe_load`.

### `.blindspot.json` --- canvas-internal save format

`.blindspot.json` (version 2, 4 MiB cap) is what the canvas **Save** / **Load** buttons write and read. It carries everything the canvas needs to restore its exact state: node / edge / zone positions (x, y), custom chips added to the library, `notes` fields on every element, and the `spSubtype` / `directed` edge flags. It is **not** a direct input to the Python CLI. Share it when:

- a collaborator will continue editing the architecture on the canvas;
- you want to preserve layout, annotations, or custom chips across a session boundary.

### PDF print output --- audit workpaper

The **Export PDF** button renders an A4-portrait report via the browser's print dialog. The report carries a canvas PNG, the full verdict table, a clause glossary (IEC 62443 references per verdict), the architecture's canonical SHA-256 hash, and (if present) the signed reviewer block. The PDF is read-only and archival; it is not a round-trippable format. Share it when:

- an auditor needs an evidence-grade artefact they can file as a workpaper;
- you want a dated, signed snapshot that does not need any tool to read back.

### Authority and round-trip guarantees

Among the three, the CLI YAML is the only format with a defined schema, cross-language parity tests, and a "this file evaluates to these verdicts" contract. When you need to quote verdicts from a file in a paper or report, cite the YAML (and its SHA-256) rather than the `.blindspot.json`. The canonical hash stamped into the PDF is a SHA-256 of the same canonical-JSON representation the tool evaluates, so it binds the PDF to a specific YAML content without requiring the YAML to also travel.

## Non-goals

- **Not a scanner.** BlindSpotCheck does not discover conduits by probing a network. You describe the architecture in YAML; it classifies.
- **Not an IDS.** It does not produce detection rules; it flags *where* monitoring authority is undefined, not *what* to look for.
- **Not a compliance tool.** IEC 62443 compliance has many axes (risk assessment, secure development, incident response). BlindSpotCheck covers exactly one axis: multi-tenant conduit monitoring authority.

## Limitations

- **Static model.** Architectures that evolve over time (e.g. dynamic microservice meshes) must be re-snapshot and re-evaluated.
- **Human-authored YAML.** Errors in the YAML (wrong ownership, missing SP-AO relationship) propagate into classification. The tool validates structure, not substance.
- **Zone authority metadata is optional.** Without it, NC-2 falls back to SC-1 parity, which loses the "borderline" distinction. Supply `zone_authorities` for a full classification.

## References

- W. Kim (2026). *Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443*. Submitted to IJCIP. Testbed DOI: [10.5281/zenodo.19627489](https://doi.org/10.5281/zenodo.19627489) (v1.1.0 version DOI; concept DOI 10.5281/zenodo.19617578 resolves to the latest testbed version).
- IEC 62443-2-1:2024, IEC 62443-2-4:2023, IEC 62443-3-2:2020, IEC 62443-3-3:2013.
- IATA Recommended Practice 1797 (Common Use Passenger Processing Systems).
- CENELEC CLC/TS 50701:2023 (Railway applications - Cybersecurity).
- IACS UR E26:2022 / UR E27:2022.
- IMO MSC-FAL.1/Circ.3 (Guidelines on maritime cyber risk management).
