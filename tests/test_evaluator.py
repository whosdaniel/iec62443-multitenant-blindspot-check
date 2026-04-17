"""Unit tests for the core NC-1/NC-2/NC-3 evaluator."""

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
    """NC-1 AND NC-2 AND NC-3: classification must be BLIND_SPOT."""
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
    assert r.nc1 is True
    assert r.nc2 is True
    assert r.nc3 is True
    assert r.verdict is Verdict.BLIND_SPOT
    assert r.mitigation, "blind spots must expose mitigation options"


def test_resolved_by_sp_when_relation_covers() -> None:
    """Multi-AO conduit with SP-AO relation => RESOLVED_BY_SP."""
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
    assert r.nc1 is True
    assert r.nc2 is False  # covered by SP-AO relationship
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
    """Same-owner endpoints => NC-1 fails => NO_CROSS_AO."""
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
    assert r.nc1 is False
    assert r.verdict is Verdict.NO_CROSS_AO


def test_borderline_when_same_zone_org_bridges() -> None:
    """NC-1 AND NC-2 true, but a single org defines both zones => NC-3 fails => BORDERLINE."""
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
    assert r.nc1 is True
    assert r.nc2 is True
    assert r.nc3 is False
    assert r.verdict is Verdict.BORDERLINE


def test_nc3_fallback_when_no_zone_metadata() -> None:
    """When zones are unspecified, NC-3 falls back to NC-1 parity."""
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
    assert r.nc1 is True
    assert r.nc3 is True  # fallback: distinct owners => distinct partitioning


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
