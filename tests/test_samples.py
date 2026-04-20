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
