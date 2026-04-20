"""
Regression tests on bundled example YAMLs.

Airport sample MUST reproduce Table 3 of W. Kim (2026) exactly, per conduit
ID and verdict. Rail and maritime samples verify that the cross-domain NC
structures (paper §8.1 analytic hypothesis) instantiate the same blind-spot
pattern.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from blindspotcheck import (
    Verdict,
    evaluate_architecture,
    load_architecture_from_path,
)

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


@pytest.mark.parametrize(
    "filename,expected_domain,expected_blind_min",
    [
        ("airport-common-use-terminal.yaml", "airport", 3),
        ("rail-passenger-station.yaml",      "rail",    4),
        ("maritime-container-terminal.yaml", "maritime", 5),
    ],
)
def test_sample_yaml_loads_and_classifies(
    filename: str, expected_domain: str, expected_blind_min: int
) -> None:
    path = EXAMPLES / filename
    arch = load_architecture_from_path(path)
    report = evaluate_architecture(arch)
    assert report.domain == expected_domain
    dist = report.distribution()
    assert dist[Verdict.BLIND_SPOT.value] >= expected_blind_min, (
        f"{filename}: expected >= {expected_blind_min} blind spots, "
        f"got {dist[Verdict.BLIND_SPOT.value]} (distribution={dist})"
    )


def test_airport_sample_reproduces_paper_table3() -> None:
    """
    Exact per-conduit verdict reproduction of W. Kim (2026) Table 3.

    The airport YAML must classify every conduit identically to the paper:
      - 3 blind spots     (CD-06, CD-08a, CD-08b)
      - 2 borderline      (CD-04, CD-05)
      - 2 resolved-by-sp  (CD-01, CD-09)
      - 12 no-cross-ao    (CD-02, CD-03, CD-07, CD-10, CD-11,
                            CD-20..CD-26)
    CD-12 is out-of-scope per 49 CFR Part 1520 SSI and is deliberately
    omitted from the YAML. 3/19 = 15.8% is the paper's headline figure.
    """
    arch = load_architecture_from_path(EXAMPLES / "airport-common-use-terminal.yaml")
    report = evaluate_architecture(arch)
    actual = {r.conduit_id: r.verdict.value for r in report.results}

    expected = {
        "CD-01":  Verdict.RESOLVED_BY_SP.value,
        "CD-02":  Verdict.NO_CROSS_AO.value,
        "CD-03":  Verdict.NO_CROSS_AO.value,
        "CD-04":  Verdict.BORDERLINE.value,
        "CD-05":  Verdict.BORDERLINE.value,
        "CD-06":  Verdict.BLIND_SPOT.value,
        "CD-07":  Verdict.NO_CROSS_AO.value,
        "CD-08a": Verdict.BLIND_SPOT.value,
        "CD-08b": Verdict.BLIND_SPOT.value,
        "CD-09":  Verdict.RESOLVED_BY_SP.value,
        "CD-10":  Verdict.NO_CROSS_AO.value,
        "CD-11":  Verdict.NO_CROSS_AO.value,
        "CD-20":  Verdict.NO_CROSS_AO.value,
        "CD-21":  Verdict.NO_CROSS_AO.value,
        "CD-22":  Verdict.NO_CROSS_AO.value,
        "CD-23":  Verdict.NO_CROSS_AO.value,
        "CD-24":  Verdict.NO_CROSS_AO.value,
        "CD-25":  Verdict.NO_CROSS_AO.value,
        "CD-26":  Verdict.NO_CROSS_AO.value,
    }
    assert actual == expected, (
        "Airport YAML must reproduce Table 3 ID-for-ID. "
        f"Diff: expected {expected}, got {actual}"
    )

    dist = report.distribution()
    assert dist[Verdict.BLIND_SPOT.value] == 3
    assert dist[Verdict.BORDERLINE.value] == 2
    assert dist[Verdict.RESOLVED_BY_SP.value] == 2
    assert dist[Verdict.NO_CROSS_AO.value] == 12
    assert sum(dist.values()) == 19


def test_airport_sample_matches_paper_appendix_d() -> None:
    """
    Per-row SC-1 disjunct trace against W. Kim (2026) Paper Appendix D.1.

    For every in-scope conduit the airport YAML must declare the same
    (T(c) owner, AO(e1), AO(e2), D1-fires, D2-fires, SC-1) tuple that
    paper Appendix D.1 records. The airport YAML is the authoritative
    BATCH 8 Table 3 reproduction; the canvas template exercises the
    same verdicts under a simplified encoding per §8.3.
    """
    arch = load_architecture_from_path(EXAMPLES / "airport-common-use-terminal.yaml")
    conduits_by_id = {c["id"]: c for c in arch["conduits"]}

    # Expected tuples per paper Appendix D.1 (p.70).
    expected = {
        # cd_id    :  (T(c) owner, AO(e1), AO(e2), D1, D2, SC-1)
        "CD-01":     ("VND", "VND", "APT", False, True,  True),
        "CD-02":     ("APT", "APT", "APT", False, False, False),
        "CD-03":     ("APT", "APT", "APT", False, False, False),
        "CD-04":     ("VND", "VND", "APT", False, True,  True),
        "CD-05":     ("VND", "APT", "APT", True,  False, True),
        "CD-06":     ("ALN-B", "APT", "APT", True,  False, True),
        "CD-07":     ("APT", "APT", "APT", False, False, False),
        "CD-08a":    ("ALN-A", "APT", "APT", True,  False, True),
        "CD-08b":    ("ALN-A", "APT", "ALN-A", False, True,  True),
        "CD-09":     ("APT", "VND", "APT", False, True,  True),
        "CD-10":     ("APT", "APT", "APT", False, False, False),
        "CD-11":     ("APT", "APT", "APT", False, False, False),
        "CD-20":     ("APT", "APT", "APT", False, False, False),
        "CD-21":     ("APT", "APT", "APT", False, False, False),
        "CD-22":     ("APT", "APT", "APT", False, False, False),
        "CD-23":     ("APT", "APT", "APT", False, False, False),
        "CD-24":     ("ALN-A", "ALN-A", "ALN-A", False, False, False),
        "CD-25":     ("APT", "APT", "APT", False, False, False),
        "CD-26":     ("APT", "APT", "APT", False, False, False),
    }

    for cid, exp in expected.items():
        assert cid in conduits_by_id, f"{cid} missing from airport YAML"
        c = conduits_by_id[cid]
        transit_owner = c.get("transit_owner") or c["from"]["owner"]
        ao_from = c["from"]["owner"]
        ao_to = c["to"]["owner"]
        d1 = transit_owner not in {ao_from, ao_to}
        d2 = ao_from != ao_to
        sc1 = d1 or d2

        actual = (transit_owner, ao_from, ao_to, d1, d2, sc1)
        assert actual == exp, (
            f"{cid} SC-1 trace mismatch:\n"
            f"  expected: T={exp[0]}, AO=({exp[1]},{exp[2]}), "
            f"D1={exp[3]}, D2={exp[4]}, SC-1={exp[5]}\n"
            f"  actual:   T={actual[0]}, AO=({actual[1]},{actual[2]}), "
            f"D1={actual[3]}, D2={actual[4]}, SC-1={actual[5]}"
        )


def test_all_samples_declare_source_standards() -> None:
    """Every shipped example must cite its derivation source."""
    for yaml_file in EXAMPLES.glob("*.yaml"):
        arch = load_architecture_from_path(yaml_file)
        assert arch["meta"].get("source", {}).get("standards"), (
            f"{yaml_file.name}: missing meta.source.standards"
        )


def test_all_samples_carry_ssi_disclaimer() -> None:
    """Every shipped example must carry an SSI/abstraction disclaimer."""
    for yaml_file in EXAMPLES.glob("*.yaml"):
        arch = load_architecture_from_path(yaml_file)
        disclaimer = arch["meta"].get("disclaimer", "")
        assert disclaimer, f"{yaml_file.name}: missing meta.disclaimer"
        assert (
            "abstract" in disclaimer.lower()
            or "no real" in disclaimer.lower()
        ), f"{yaml_file.name}: disclaimer does not assert abstraction"
