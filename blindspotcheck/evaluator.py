"""
Core SC-1/NC-1/NC-2 evaluation logic.

Biconditional (W. Kim 2026, "Compliant Yet Blind" §4.1):

    SC-1(c)  ==>  [ BlindSpot(c)  <==>  NC-1(c) AND NC-2(c) ]

where for a conduit c:
    SC-1(c): scope condition. An asset belonging to a different asset owner
             is present at one endpoint (the conduit crosses an asset-owner
             boundary). Derived from IEC 62443-2-1 Clause 3.1.2 (AO definition).
    NC-1(c): role-typing condition. The "other" asset owner is independent,
             not a service provider under IEC 62443-2-4 (neither an integration
             SP per Clause 3.1.12 nor a maintenance SP per Clause 3.1.13). A
             covering SP-AO relationship means 62443-2-4 SP.08.02 BR log-sharing
             obligations already flow across the conduit.
    NC-2(c): governance condition. No single organisation designates the zones
             at *both* endpoints. Derived from IEC 62443-3-2:2020 ZCR 3
             Clause 4.4 (in particular ZCR 3.1, Clause 4.4.2): zone/conduit
             methodology presupposes a single partitioning authority per zone.

This module is intentionally pure: no I/O, no YAML, no CLI. It takes already-
validated dict input and returns classification records.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable


class Verdict(str, Enum):
    """Classification outcome for a conduit."""

    BLIND_SPOT = "blind-spot"
    BORDERLINE = "borderline"
    RESOLVED_BY_SP = "resolved-by-sp"
    NO_CROSS_AO = "no-cross-ao"


@dataclass(frozen=True)
class NCResult:
    """Per-conduit result: the three flags plus classification and mitigation."""

    conduit_id: str
    sc1: bool
    nc1: bool
    nc2: bool
    verdict: Verdict
    mitigation: tuple[str, ...] = field(default_factory=tuple)
    rationale: str = ""

    def as_row(self) -> dict[str, object]:
        """Flat dict form suitable for serialisation."""
        return {
            "conduit_id": self.conduit_id,
            "sc1": self.sc1,
            "nc1": self.nc1,
            "nc2": self.nc2,
            "verdict": self.verdict.value,
            "mitigation": list(self.mitigation),
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class ArchitectureReport:
    """Report covering every conduit in an architecture."""

    domain: str
    results: tuple[NCResult, ...]
    source_standards: tuple[str, ...] = field(default_factory=tuple)

    def distribution(self) -> dict[str, int]:
        """Count of each verdict."""
        counts = {v.value: 0 for v in Verdict}
        for r in self.results:
            counts[r.verdict.value] += 1
        return counts

    def blind_spots(self) -> tuple[NCResult, ...]:
        return tuple(r for r in self.results if r.verdict is Verdict.BLIND_SPOT)


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def evaluate_architecture(arch: dict) -> ArchitectureReport:
    """
    Run SC-1/NC-1/NC-2 evaluation across every conduit in `arch`.

    Args:
        arch: A pre-validated architecture dict matching schemas/architecture-v1.json.
              Callers must run schema validation first (see blindspotcheck.schema).

    Returns:
        ArchitectureReport with per-conduit NCResult records.
    """
    role_by_id = {ao["id"]: ao["role"] for ao in arch.get("asset_owners", [])}
    sp_relations = _index_sp_relations(arch.get("sp_relations", []) or [])
    zone_org = {z["zone"]: z["org"] for z in arch.get("zone_authorities", []) or []}

    results: list[NCResult] = []
    for c in arch["conduits"]:
        results.append(_evaluate_conduit(c, role_by_id, sp_relations, zone_org))

    meta = arch.get("meta", {})
    source = meta.get("source", {}) or {}
    standards = tuple(source.get("standards", []) or [])

    return ArchitectureReport(
        domain=meta.get("domain", "unknown"),
        results=tuple(results),
        source_standards=standards,
    )


def _index_sp_relations(
    relations: Iterable[dict],
) -> dict[tuple[str, str], list[dict]]:
    """
    Index SP-AO relations by (sp, ao) pair.

    Each key maps to a list of relation entries, where each entry is a
    dict ``{"scope": set[str] | None, "subtype": str}``. We keep them
    as a list rather than folding into a single aggregate because a
    single (sp, ao) pair can legitimately carry two distinct
    relationships (one integration, one maintenance) that need to be
    evaluated independently when checking whether a conduit is covered.

    The default `subtype` is ``"both"`` for entries omitting the
    ``sp_subtype`` field, preserving the pre-Batch-4 behaviour where
    every SP-AO relationship was assumed to cover monitoring.
    """
    idx: dict[tuple[str, str], list[dict]] = {}
    for r in relations:
        key = (r["sp"], r["ao"])
        scope = r.get("scope")
        subtype = r.get("sp_subtype", "both")
        entry: dict = {
            "scope": set(scope) if isinstance(scope, list) else None,
            "subtype": subtype,
        }
        idx.setdefault(key, []).append(entry)
    return idx


def _evaluate_conduit(
    c: dict,
    role_by_id: dict[str, str],
    sp_relations: dict[tuple[str, str], set[str] | None],
    zone_org: dict[str, str],
) -> NCResult:
    conduit_id = c["id"]
    from_owner = c["from"]["owner"]
    to_owner = c["to"]["owner"]
    from_zone = c["from"].get("zone")
    to_zone = c["to"].get("zone")
    # transit_owner: artefact ownership per paper §3 four-context rule.
    # Defaults to from_owner when absent (pre-BATCH-8 YAML compatibility).
    transit_owner = c.get("transit_owner") or from_owner

    # SC-1 (scope condition) per paper §4 BATCH 8 2-disjunct formulation:
    #   D1: a cross-AO artefact transits c (owner(a) ∉ {AO(e1), AO(e2)})
    #   D2: endpoint AOs differ (AO(e1) ≠ AO(e2))
    # SC-1 = D1 ∨ D2. When transit_owner is omitted it collapses to from_owner,
    # so D1 is guaranteed False and D2 drives the result (legacy behaviour).
    sc1_transit = transit_owner not in {from_owner, to_owner}
    sc1_endpoint = from_owner != to_owner
    sc1 = sc1_transit or sc1_endpoint

    # Helper: is `owner` an asset-owner role in this architecture?
    def is_ao(owner_id: str) -> bool:
        return role_by_id.get(owner_id) == "AO"

    # NC-1 (role-typing) per paper §4.1: no SP-AO relationship between the
    # two endpoint asset owners, AND both are independent asset owners.
    # Scope: paper §4.1 explicitly limits NC-1 to the endpoint AO pair, not
    # to the transit artefact owner, so a cross-AO artefact fires SC-1 via
    # D1 while NC-1 can still hold when endpoints share an AO (CD-05, CD-06).
    if from_owner == to_owner:
        # No bilateral SP possible between a single org and itself; NC-1
        # reduces to "that AO is an independent asset owner".
        nc1 = is_ao(from_owner)
    else:
        bilateral_covered = (
            _covers(sp_relations, sp=from_owner, ao=to_owner, cid=conduit_id)
            or _covers(sp_relations, sp=to_owner, ao=from_owner, cid=conduit_id)
        )
        both_aos = is_ao(from_owner) and is_ao(to_owner)
        nc1 = (not bilateral_covered) and both_aos

    # NC-2 (governance): no single organisation designates the zones at both
    # endpoints. When zones aren't declared we fall back to the endpoint-AO
    # difference (approximates the zone-designator split in the common case
    # where each AO designates its own zones).
    if from_zone and to_zone and zone_org:
        from_org = zone_org.get(from_zone)
        to_org = zone_org.get(to_zone)
        if from_org is None or to_org is None:
            # Missing zone designation => conservative fallback: assume no
            # single authority bridges.
            nc2 = True
        else:
            nc2 = from_org != to_org
    else:
        # No zone metadata: approximate via endpoint-AO difference.
        nc2 = from_owner != to_owner

    verdict, mitigation, rationale = _classify(sc1, nc1, nc2)
    return NCResult(
        conduit_id=conduit_id,
        sc1=sc1,
        nc1=nc1,
        nc2=nc2,
        verdict=verdict,
        mitigation=tuple(mitigation),
        rationale=rationale,
    )


def _covers(
    sp_relations: dict[tuple[str, str], list[dict]],
    *,
    sp: str,
    ao: str,
    cid: str,
) -> bool:
    """
    True if an SP-AO relation whose sub-type reaches monitoring scope
    (maintenance or both) covers this conduit.

    Per paper §2.3 and IEC 62443-2-4 Clause 3.1.12 vs 3.1.13: integration
    SPs perform design / installation / commissioning only, and SP.08.02
    BR logging obligation attaches to the maintenance SP role. An
    integration-only relationship therefore does NOT resolve NC-1 for
    monitoring purposes; the tool reflects that here.
    """
    entries = sp_relations.get((sp, ao))
    if not entries:
        return False
    for entry in entries:
        subtype = entry.get("subtype", "both")
        if subtype == "integration":
            # Integration SP does not reach monitoring scope; skip.
            continue
        scope = entry.get("scope")
        if scope is None:  # unscoped => covers every conduit with this pair
            return True
        if cid in scope:
            return True
    return False


def _classify(sc1: bool, nc1: bool, nc2: bool) -> tuple[Verdict, list[str], str]:
    """
    Apply the §4.1 biconditional classification rule.
    Returns (verdict, mitigation_options, human-readable rationale).
    """
    if sc1 and nc1 and nc2:
        return (
            Verdict.BLIND_SPOT,
            [
                "Break SC-1: consolidate endpoints under a single asset owner.",
                "Break NC-1: establish a contractual SP-AO relationship covering the conduit.",
                "Break NC-2: assign a single partitioning authority over both endpoints (out-of-band agreement).",
            ],
            "SC-1 AND NC-1 AND NC-2: structural monitoring blind spot (biconditional §4.1).",
        )
    if sc1 and nc1 and not nc2:
        return (
            Verdict.BORDERLINE,
            ["Clarify zone designation to confirm or exclude NC-2."],
            "SC-1 AND NC-1 hold but a single organisation bridges both endpoint zones (NC-2 fails): borderline.",
        )
    if sc1 and not nc1:
        return (
            Verdict.RESOLVED_BY_SP,
            [],
            "Cross-AO conduit but an SP-AO relationship covers it: obligations flow via IEC 62443-2-4.",
        )
    # not sc1: same-owner conduit (no cross-AO split)
    return (
        Verdict.NO_CROSS_AO,
        [],
        "Both endpoints owned by the same party: not a multi-tenant conduit.",
    )
