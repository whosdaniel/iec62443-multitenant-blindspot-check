# Design notes

## Why this tool exists

Kim (2026) *"Compliant Yet Blind"* derives a biconditional:

```
BlindSpot(c) <==> NC-1(c) AND NC-2(c) AND NC-3(c)
```

for any conduit `c` in an IEC 62443-governed architecture. The paper shows that airport OT environments with a common-use CUPPS deployment yield 3 blind-spot conduits out of 19 enumerated. But the biconditional itself is **architecture-invariant**: any multi-tenant OT fabric to which the IEC 62443 role model is applied will see the same pattern wherever NC-1, NC-2, and NC-3 simultaneously hold.

**BlindSpotCheck operationalises that biconditional.** Given any YAML description of conduits, owners, SP relationships, and zone authorities, it mechanically classifies each conduit — removing subjective judgement and letting deployments audit themselves against the structural criterion.

## The three necessary conditions

| | Source | Encoded as |
|---|---|---|
| **NC-1** | IEC 62443-2-1 Clause 3.1.2 (Asset Owner definition) | the two endpoints of the conduit belong to distinct asset owners |
| **NC-2** | IEC 62443-2-4 Clauses 3.1.12 (integration SP), 3.1.13 (maintenance SP), SP.08.02 BR (SP-AO log-sharing) | no SP-AO relationship exists between the endpoint owners covering this conduit, AND both endpoint owners have role `AO` |
| **NC-3** | IEC 62443-3-2 ZCR-1 (Clauses 4.3.1-4.3.3): zone/conduit partitioning presupposes a single designating authority | the two endpoint zones are designated by distinct organisations |

NC-1 and NC-2 are **clause-level** conditions (derived from specific IEC 62443 text). NC-3 is a **role-model-level** condition (derived from the partitioning-authority premise inherent to the 62443-3-2 methodology rather than a single clause).

## Verdict matrix

| NC-1 | NC-2 | NC-3 | Verdict | Meaning |
|------|------|------|---------|---------|
| Y | Y | Y | `blind-spot` | Structural monitoring blind spot. |
| Y | Y | – | `borderline` | Cross-AO, uncovered, but a single org bridges the zones. Easy to slide into a blind spot if governance splits. |
| Y | – | * | `resolved-by-sp` | An SP-AO relationship covers the conduit; IEC 62443-2-4 log-sharing obligations apply. |
| – | * | * | `no-cross-ao` | Same-owner endpoints. Not a multi-tenant conduit. |

## Evaluation algorithm (pseudocode)

```python
for conduit c in architecture.conduits:
    a, b = c.from.owner, c.to.owner
    nc1 = (a != b)

    if not nc1:
        nc2 = False
    else:
        covered = any(sp-ao relation covers (a, b, c.id))
        both_aos = roles[a] == "AO" and roles[b] == "AO"
        nc2 = (not covered) and both_aos

    if zones declared:
        nc3 = zone_org[c.from.zone] != zone_org[c.to.zone]
    else:
        nc3 = nc1  # fallback

    verdict = classify(nc1, nc2, nc3)
```

## Design choices

**Pure Python, no external service.** The tool is a local analyser. It never contacts the network. This keeps it auditable, reproducible, and acceptable for air-gapped review.

**Abstract labels only.** The schema does not accept IP addresses, real vendor names, real organisation names, or MAC addresses. Labels are role-level identifiers like `APT`, `ALN-A`, `VND`. This lets architectures from regulated deployments be shared without leaking Sensitive Security Information (SSI).

**Schema-first.** A JSON-Schema (Draft 2020-12) file lives next to the Python code and is the contract. `blindspotcheck --schema` emits it. Downstream tools can validate independently.

**Conservative NC-3 fallback.** When zones are not declared, the evaluator assumes distinct owners ⇒ distinct partitioning authorities (NC-3 = NC-1). This is conservative: it tends to classify ambiguous conduits as blind-spots rather than borderline, which is the safer direction for a monitoring-gap audit.

## Non-goals

- **Not a scanner.** BlindSpotCheck does not discover conduits by probing a network. You describe the architecture in YAML; it classifies.
- **Not an IDS.** It does not produce detection rules; it flags *where* monitoring authority is undefined, not *what* to look for.
- **Not a compliance tool.** IEC 62443 compliance has many axes (risk assessment, secure development, incident response). BlindSpotCheck covers exactly one axis: multi-tenant conduit monitoring authority.

## Limitations

- **Static model.** Architectures that evolve over time (e.g. dynamic microservice meshes) must be re-snapshot and re-evaluated.
- **Human-authored YAML.** Errors in the YAML (wrong ownership, missing SP-AO relationship) propagate into classification. The tool validates structure, not substance.
- **Zone authority metadata is optional.** Without it, NC-3 falls back to NC-1 parity, which loses the "borderline" distinction. Supply `zone_authorities` for a full classification.

## References

- Kim, W. (2026). *Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443*. Submitted to IJCIP. Testbed DOI: [10.5281/zenodo.19617578](https://doi.org/10.5281/zenodo.19617578).
- IEC 62443-2-1:2024, IEC 62443-2-4:2023, IEC 62443-3-2:2020, IEC 62443-3-3:2013.
- IATA Recommended Practice 1797 (Common Use Passenger Processing Systems).
- CENELEC CLC/TS 50701:2023 (Railway applications — Cybersecurity).
- IACS UR E26:2022 / UR E27:2022.
- IMO MSC-FAL.1/Circ.3 (Guidelines on maritime cyber risk management).
