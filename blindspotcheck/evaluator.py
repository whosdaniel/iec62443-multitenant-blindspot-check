"""
Core NC-1/NC-2/NC-3 evaluation logic.

Biconditional (Kim 2026, "Compliant Yet Blind" §4.1):

    BlindSpot(c) <==> NC-1(c) AND NC-2(c) AND NC-3(c)

where for a conduit c:
    NC-1(c): the two endpoints belong to distinct asset owners (multi-AO conduit).
             Derived from IEC 62443-2-1 Clause 3.1.2 (AO definition).
    NC-2(c): no service-provider-to-asset-owner relationship bridges the conduit.
             Derived from IEC 62443-2-4 Clauses 3.1.12-3.1.13 (SP sub-types)
             and SP.08.02 BR (SP-AO logging obligation).
    NC-3(c): no single organisation designates the zones at *both* endpoints
             (i.e. no unified partitioning authority can assign monitoring).
             Derived from IEC 62443-3-2 ZCR-1 (Clauses 4.3.1-4.3.3).

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
    nc1: bool
    nc2: bool
    nc3: bool
    verdict: Verdict
    mitigation: tuple[str, ...] = field(default_factory=tuple)
    rationale: str = ""

    def as_row(self) -> dict[str, object]:
        """Flat dict form suitable for serialisation."""
        return {
            "conduit_id": self.conduit_id,
            "nc1": self.nc1,
            "nc2": self.nc2,
            "nc3": self.nc3,
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
    Run NC-1/NC-2/NC-3 evaluation across every conduit in `arch`.

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


def _index_sp_relations(relations: Iterable[dict]) -> dict[tuple[str, str], set[str] | None]:
    """
    Index SP-AO relations by (sp, ao) pair.

    Value is either:
      - set of explicit conduit ids the relation covers, or
      - None if the relation covers every conduit matching this pair.
    """
    idx: dict[tuple[str, str], set[str] | None] = {}
    for r in relations:
        key = (r["sp"], r["ao"])
        scope = r.get("scope")
        if scope is None:
            idx[key] = None  # covers all matching conduits
        else:
            existing = idx.get(key)
            if existing is None and key in idx:
                # Already "covers all"; explicit scope is subsumed.
                continue
            s: set[str] = set(existing) if isinstance(existing, set) else set()
            s.update(scope)
            idx[key] = s
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

    # NC-1: endpoints belong to distinct asset owners.
    nc1 = from_owner != to_owner

    # Helper: is `owner` an asset-owner role in this architecture?
    def is_ao(owner_id: str) -> bool:
        return role_by_id.get(owner_id) == "AO"

    # NC-2: neither endpoint owner has a covering SP-AO relationship with the
    # other that resolves this conduit into a bilateral SP-AO dyad.
    # A covering relationship = one owner is SP, the other is AO, and either
    # (a) explicit scope includes this conduit id, or (b) no explicit scope.
    if not nc1:
        # Same-owner conduit: NC-2 is trivially not satisfied (single-AO).
        nc2 = False
    else:
        bilateral_covered = (
            _covers(sp_relations, sp=from_owner, ao=to_owner, cid=conduit_id)
            or _covers(sp_relations, sp=to_owner, ao=from_owner, cid=conduit_id)
        )
        # NC-2: no SP-AO relationship covers this conduit AND both endpoints
        # are independent asset owners (not vendor-in-SP-role).
        both_aos = is_ao(from_owner) and is_ao(to_owner)
        nc2 = (not bilateral_covered) and both_aos

    # NC-3: no single organisation controls zones at both endpoints.
    # If zones aren't declared, we conservatively compute: "no single org
    # bridges" is equivalent to "ownership of the endpoints is already split"
    # which is NC-1. So the default is to reuse NC-1 when zones are unspecified.
    if from_zone and to_zone and zone_org:
        from_org = zone_org.get(from_zone)
        to_org = zone_org.get(to_zone)
        if from_org is None or to_org is None:
            # Missing zone designation => conservative fallback: assume no
            # single authority bridges.
            nc3 = True
        else:
            nc3 = from_org != to_org
    else:
        # No zone metadata: treat as "same-owner => one org, distinct owners => distinct orgs".
        nc3 = nc1

    verdict, mitigation, rationale = _classify(nc1, nc2, nc3)
    return NCResult(
        conduit_id=conduit_id,
        nc1=nc1,
        nc2=nc2,
        nc3=nc3,
        verdict=verdict,
        mitigation=tuple(mitigation),
        rationale=rationale,
    )


def _covers(
    sp_relations: dict[tuple[str, str], set[str] | None],
    *,
    sp: str,
    ao: str,
    cid: str,
) -> bool:
    """True if an SP-AO relation covers this conduit."""
    key = (sp, ao)
    if key not in sp_relations:
        return False
    scope = sp_relations[key]
    if scope is None:  # unscoped => covers all conduits with this pair
        return True
    return cid in scope


def _classify(nc1: bool, nc2: bool, nc3: bool) -> tuple[Verdict, list[str], str]:
    """
    Apply the §4.1 biconditional classification rule.
    Returns (verdict, mitigation_options, human-readable rationale).
    """
    if nc1 and nc2 and nc3:
        return (
            Verdict.BLIND_SPOT,
            [
                "Break NC-1: consolidate endpoints under a single asset owner.",
                "Break NC-2: establish a contractual SP-AO relationship covering the conduit.",
                "Break NC-3: assign a single partitioning authority over both endpoints (out-of-band agreement).",
            ],
            "NC-1 AND NC-2 AND NC-3: structural monitoring blind spot (biconditional §4.1).",
        )
    if nc1 and nc2 and not nc3:
        return (
            Verdict.BORDERLINE,
            ["Clarify zone designation to confirm or exclude NC-3."],
            "NC-1 AND NC-2 hold but a single organisation bridges both endpoint zones (NC-3 fails): borderline.",
        )
    if nc1 and not nc2:
        return (
            Verdict.RESOLVED_BY_SP,
            [],
            "Multi-AO conduit but an SP-AO relationship covers it: obligations flow via IEC 62443-2-4.",
        )
    # not nc1: same-owner conduit (no cross-AO split)
    return (
        Verdict.NO_CROSS_AO,
        [],
        "Both endpoints owned by the same party: not a multi-tenant conduit.",
    )
