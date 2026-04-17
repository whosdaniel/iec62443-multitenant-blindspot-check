"""
Regression tests on bundled example YAMLs.

Airport sample MUST reproduce the distribution reported in Kim (2026) Table 2
(within the scope of the testbed architecture: 3 blind spots, 2 borderline).
Rail and maritime samples verify that the cross-domain NC structures
(§8.1) instantiate the same blind-spot pattern.
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


def test_airport_sample_reproduces_paper_table2() -> None:
    """Exact distribution checks for the airport YAML (Kim 2026 Table 2)."""
    arch = load_architecture_from_path(EXAMPLES / "airport-common-use-terminal.yaml")
    report = evaluate_architecture(arch)
    dist = report.distribution()
    # Paper §4 Table 2 (within testbed scope: 17 evaluated conduits).
    assert dist[Verdict.BLIND_SPOT.value] == 3,  dist
    assert dist[Verdict.BORDERLINE.value] == 2,  dist
    assert dist[Verdict.RESOLVED_BY_SP.value] >= 5, dist


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
