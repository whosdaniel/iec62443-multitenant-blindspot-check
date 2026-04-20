"""Unit tests for the core SC-1/NC-1/NC-2 evaluator."""

from __future__ import annotations

from blindspotcheck.evaluator import (
    ArchitectureReport,
    Verdict,
    evaluate_architecture,
)

# Minimal two-owner architecture template used throughout tests.
BASE_ARCH = {
    "meta": {"schema_version": "1", "domain": "test"},
    "asset_owners": [
        {"id": "APT", "role": "AO"},
        {"id": "ALN", "role": "AO"},
        {"id": "VND", "role": "AO"},
    ],
}


def _arch(**overrides) -> dict:
    base = {**BASE_ARCH}
    base.update(overrides)
    base.setdefault("sp_relations", [])
    base.setdefault("zone_authorities", [])
    return base


def test_blind_spot_three_conditions_hold() -> None:
    """SC-1 AND NC-1 AND NC-2: classification must be BLIND_SPOT."""
    arch = _arch(
        conduits=[
            {
                "id": "CD-X",
                "from": {"owner": "APT", "zone": "Z-APT"},
                "to": {"owner": "ALN", "zone": "Z-ALN"},
            }
        ],
        zone_authorities=[
            {"zone": "Z-APT", "org": "APT"},
            {"zone": "Z-ALN", "org": "ALN"},
        ],
    )
    report = evaluate_architecture(arch)
    (r,) = report.results
    assert r.sc1 is True
    assert r.nc1 is True
    assert r.nc2 is True
    assert r.verdict is Verdict.BLIND_SPOT
    assert r.mitigation, "blind spots must expose mitigation options"


def test_resolved_by_sp_when_relation_covers() -> None:
    """Cross-AO conduit with SP-AO relation => RESOLVED_BY_SP."""
    arch = _arch(
        conduits=[
            {
                "id": "CD-01",
                "from": {"owner": "VND", "zone": "Z-VND"},
                "to": {"owner": "APT", "zone": "Z-APT"},
            }
        ],
        sp_relations=[{"sp": "VND", "ao": "APT", "scope": ["CD-01"]}],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            {"zone": "Z-APT", "org": "APT"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.sc1 is True
    assert r.nc1 is False  # covered by SP-AO relationship
    assert r.verdict is Verdict.RESOLVED_BY_SP


def test_sp_relation_unscoped_covers_all_matching_pairs() -> None:
    """sp_relations without `scope` must cover all conduits with that pair."""
    arch = _arch(
        conduits=[
            {
                "id": "CD-10",
                "from": {"owner": "VND", "zone": "Z-VND"},
                "to": {"owner": "APT", "zone": "Z-APT"},
            },
            {
                "id": "CD-11",
                "from": {"owner": "VND", "zone": "Z-VND"},
                "to": {"owner": "APT", "zone": "Z-APT"},
            },
        ],
        sp_relations=[{"sp": "VND", "ao": "APT"}],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            {"zone": "Z-APT", "org": "APT"},
        ],
    )
    results = {r.conduit_id: r for r in evaluate_architecture(arch).results}
    assert results["CD-10"].verdict is Verdict.RESOLVED_BY_SP
    assert results["CD-11"].verdict is Verdict.RESOLVED_BY_SP


def test_no_cross_ao_when_same_owner_endpoints() -> None:
    """Same-owner endpoints => SC-1 fails => NO_CROSS_AO."""
    arch = _arch(
        conduits=[
            {
                "id": "CD-INTRA",
                "from": {"owner": "APT", "zone": "Z-APT"},
                "to": {"owner": "APT", "zone": "Z-APT"},
            }
        ],
        zone_authorities=[{"zone": "Z-APT", "org": "APT"}],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.sc1 is False
    assert r.verdict is Verdict.NO_CROSS_AO


def test_borderline_when_same_zone_org_bridges() -> None:
    """SC-1 AND NC-1 true, but a single org defines both zones => NC-2 fails => BORDERLINE."""
    # Contrived: APT and ALN are distinct AOs, but ALN's endpoint sits in a
    # zone designated by APT (shared tenant VLAN).
    arch = _arch(
        conduits=[
            {
                "id": "CD-BORD",
                "from": {"owner": "APT", "zone": "Z-APT"},
                "to": {"owner": "ALN", "zone": "Z-APT-SHARED"},
            }
        ],
        zone_authorities=[
            {"zone": "Z-APT", "org": "APT"},
            {"zone": "Z-APT-SHARED", "org": "APT"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.sc1 is True
    assert r.nc1 is True
    assert r.nc2 is False
    assert r.verdict is Verdict.BORDERLINE


def test_nc2_fallback_when_no_zone_metadata() -> None:
    """When zones are unspecified, NC-2 falls back to SC-1 parity."""
    arch = _arch(
        conduits=[
            {
                "id": "CD-NOZONE",
                "from": {"owner": "APT"},
                "to": {"owner": "ALN"},
            }
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.sc1 is True
    assert r.nc2 is True  # fallback: distinct owners => distinct partitioning


def test_report_distribution_sums_to_total() -> None:
    """Distribution counts must equal total number of conduits."""
    arch = _arch(
        conduits=[
            {"id": "C1", "from": {"owner": "APT"}, "to": {"owner": "ALN"}},
            {"id": "C2", "from": {"owner": "APT"}, "to": {"owner": "APT"}},
            {"id": "C3", "from": {"owner": "VND"}, "to": {"owner": "APT"}},
        ],
        sp_relations=[{"sp": "VND", "ao": "APT", "scope": ["C3"]}],
    )
    report = evaluate_architecture(arch)
    dist = report.distribution()
    assert sum(dist.values()) == len(report.results) == 3


def test_empty_conduits_list_allowed() -> None:
    """Zero conduits should produce an empty report, not an error."""
    # Schema requires minItems:1, but evaluator itself must not crash on empty.
    arch = _arch(conduits=[])
    report = evaluate_architecture(arch)
    assert isinstance(report, ArchitectureReport)
    assert report.results == ()
    assert sum(report.distribution().values()) == 0


# ---------------------------------------------------------------------------
# sp_subtype (Batch 4): integration-only SP-AO does NOT satisfy NC-1
# ---------------------------------------------------------------------------


def test_sp_relation_defaults_to_both_subtype_backward_compat() -> None:
    """
    A relation without sp_subtype must behave as the pre-Batch-4 tool did:
    cover the conduit for NC-1 purposes (verdict = resolved-by-sp).
    """
    arch = _arch(
        conduits=[{
            "id": "CD-X",
            "from": {"owner": "VND", "zone": "Z-VND"},
            "to":   {"owner": "APT", "zone": "Z-APT"},
        }],
        sp_relations=[{"sp": "VND", "ao": "APT", "scope": ["CD-X"]}],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            {"zone": "Z-APT", "org": "APT"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.nc1 is False, "default subtype 'both' must cover (NC-1 false = covered)"
    assert r.verdict is Verdict.RESOLVED_BY_SP


def test_maintenance_sp_satisfies_nc1() -> None:
    """Maintenance SP (62443-2-4 Cl. 3.1.13 + SP.08.02 BR) covers monitoring."""
    arch = _arch(
        conduits=[{
            "id": "CD-X",
            "from": {"owner": "VND", "zone": "Z-VND"},
            "to":   {"owner": "APT", "zone": "Z-APT"},
        }],
        sp_relations=[{
            "sp": "VND", "ao": "APT", "scope": ["CD-X"],
            "sp_subtype": "maintenance",
        }],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            {"zone": "Z-APT", "org": "APT"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.verdict is Verdict.RESOLVED_BY_SP


def test_integration_only_sp_does_not_satisfy_nc1() -> None:
    """
    Integration-only SP (62443-2-4 Cl. 3.1.12) covers design/install/
    commissioning, NOT monitoring. Paper §2.3: "the Clause 3.1.13 definition
    explicitly includes 'security monitoring' as a maintenance SP activity."
    The conduit should therefore still be classified as a structural blind
    spot when SC-1 and NC-2 also hold.
    """
    arch = _arch(
        conduits=[{
            "id": "CD-X",
            "from": {"owner": "VND", "zone": "Z-VND"},
            "to":   {"owner": "APT", "zone": "Z-APT"},
        }],
        sp_relations=[{
            "sp": "VND", "ao": "APT", "scope": ["CD-X"],
            "sp_subtype": "integration",
        }],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            {"zone": "Z-APT", "org": "APT"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.sc1 is True
    assert r.nc1 is True, (
        "integration-only SP-AO must leave NC-1 satisfied "
        "(integration SPs do not reach monitoring per Cl. 3.1.12)"
    )
    assert r.nc2 is True
    assert r.verdict is Verdict.BLIND_SPOT


def test_nc2_zone_half_declared_falls_back_conservative() -> None:
    """
    When one endpoint carries a zone reference but the other doesn't,
    evaluator.py uses the "conservative" NC-2 = True branch: it treats
    the conduit as partitioned by distinct authorities because we have
    no basis to assert a single authority bridges both sides.
    """
    arch = _arch(
        conduits=[{
            "id": "CD-HALF",
            "from": {"owner": "VND", "zone": "Z-VND"},
            "to":   {"owner": "APT"},  # no zone on target
        }],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    # The branch fires because fromZone and toZone aren't both truthy,
    # so evaluator falls through to the "no zone metadata" fallback
    # (nc2 = sc1 = True).
    assert r.sc1 is True
    assert r.nc2 is True


def test_nc2_zone_declared_but_org_missing_is_conservative() -> None:
    """
    Both endpoints carry zones but one of those zones is NOT in
    zone_authorities. The evaluator then has no org for that side and
    conservatively declares NC-2 true.
    """
    arch = _arch(
        conduits=[{
            "id": "CD-ORPHAN-ZONE",
            "from": {"owner": "VND", "zone": "Z-VND"},
            "to":   {"owner": "APT", "zone": "Z-UNKNOWN"},
        }],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            # Z-UNKNOWN intentionally missing -> schema allows it because
            # the referential-integrity check only forbids zones in
            # conduits that aren't in zone_authorities when both sides
            # attempt to resolve - except in this tooling we'd normally
            # catch it; here we construct via direct evaluator call to
            # stress the fallback path.
        ],
    )
    # Architecture schema validation would normally reject this, but
    # the evaluator itself must still handle the edge. Feed directly.
    (r,) = evaluate_architecture(arch).results
    assert r.nc2 is True  # missing org -> conservative True


def test_self_loop_is_no_cross_ao() -> None:
    """Edge source == target is always single-AO. Evaluator must not crash."""
    arch = _arch(
        conduits=[{
            "id": "CD-SELF",
            "from": {"owner": "APT"},
            "to":   {"owner": "APT"},
        }],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.sc1 is False
    assert r.verdict is Verdict.NO_CROSS_AO


def test_coexisting_integration_and_maintenance_relations_resolve() -> None:
    """
    If the same (sp, ao) pair has both an integration relation AND a
    maintenance relation, the maintenance side alone is enough to cover
    the conduit for monitoring purposes.
    """
    arch = _arch(
        conduits=[{
            "id": "CD-X",
            "from": {"owner": "VND", "zone": "Z-VND"},
            "to":   {"owner": "APT", "zone": "Z-APT"},
        }],
        sp_relations=[
            {"sp": "VND", "ao": "APT", "scope": ["CD-X"], "sp_subtype": "integration"},
            {"sp": "VND", "ao": "APT", "scope": ["CD-X"], "sp_subtype": "maintenance"},
        ],
        zone_authorities=[
            {"zone": "Z-VND", "org": "VND"},
            {"zone": "Z-APT", "org": "APT"},
        ],
    )
    (r,) = evaluate_architecture(arch).results
    assert r.verdict is Verdict.RESOLVED_BY_SP
