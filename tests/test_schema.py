"""Schema validation + security-focused tests for YAML loading."""

from __future__ import annotations

import pytest

from blindspotcheck.schema import (
    MAX_INPUT_BYTES,
    InputTooLarge,
    SchemaError,
    load_architecture_from_text,
    validate_architecture,
)

VALID_YAML = """
meta:
  schema_version: "1"
  domain: test
asset_owners:
  - { id: A, role: AO }
  - { id: B, role: AO }
conduits:
  - id: C1
    from: { owner: A }
    to:   { owner: B }
"""


def test_valid_yaml_parses() -> None:
    data = load_architecture_from_text(VALID_YAML)
    assert data["meta"]["domain"] == "test"
    assert len(data["conduits"]) == 1


def test_unknown_schema_version_rejected() -> None:
    bad = VALID_YAML.replace('schema_version: "1"', 'schema_version: "99"')
    with pytest.raises(SchemaError):
        load_architecture_from_text(bad)


def test_missing_required_conduit_fields_rejected() -> None:
    bad = """
meta: { schema_version: "1", domain: t }
asset_owners:
  - { id: A, role: AO }
  - { id: B, role: AO }
conduits:
  - id: C1
    from: { owner: A }
    # missing `to`
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(bad)
    assert "to" in str(exc.value)


def test_additional_properties_rejected() -> None:
    """Schema sets additionalProperties: false; typos must be caught."""
    bad = """
meta: { schema_version: "1", domain: t }
asset_owners:
  - { id: A, role: AO }
  - { id: B, role: AO }
conduits:
  - id: C1
    from: { owner: A }
    to:   { owner: B }
    typo_field: "should fail"
"""
    with pytest.raises(SchemaError):
        load_architecture_from_text(bad)


def test_role_enum_enforced() -> None:
    bad = VALID_YAML.replace("role: AO", "role: HACKER", 1)
    with pytest.raises(SchemaError):
        load_architecture_from_text(bad)


def test_conduit_id_pattern_enforced() -> None:
    """IDs must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$."""
    bad = VALID_YAML.replace("id: C1", 'id: "1Cstart-with-digit"')
    with pytest.raises(SchemaError):
        load_architecture_from_text(bad)


def test_input_size_cap() -> None:
    """Oversized inputs must be rejected before YAML parsing."""
    payload = "x" * (MAX_INPUT_BYTES + 1)
    with pytest.raises(InputTooLarge):
        load_architecture_from_text(payload)


# ---------------------------------------------------------------------------
# Security-focused: safe_load must refuse Python-object YAML tags.
# ---------------------------------------------------------------------------


def test_python_object_tag_refused() -> None:
    """
    yaml.safe_load must refuse `!!python/object/apply` (a classic RCE vector
    in yaml.load). This would deserialise to os.system if safe_load wasn't used.
    """
    dangerous = """
!!python/object/apply:os.system
- "echo pwned"
"""
    # safe_load raises ConstructorError; schema.py wraps that in SchemaError.
    with pytest.raises(SchemaError):
        load_architecture_from_text(dangerous)


def test_malformed_yaml_returns_schema_error() -> None:
    bad = "meta: {unterminated: "
    with pytest.raises(SchemaError):
        load_architecture_from_text(bad)


def test_top_level_must_be_mapping() -> None:
    with pytest.raises(SchemaError):
        load_architecture_from_text("[- not a mapping -]")


def test_non_ao_role_in_endpoint_is_accepted_but_not_blind_spot() -> None:
    """
    If an endpoint's owner has role != AO (e.g. integrator), NC-2 will not
    classify it as a blind spot even if the pair is distinct.
    """
    from blindspotcheck.evaluator import Verdict, evaluate_architecture

    arch = {
        "meta": {"schema_version": "1", "domain": "t"},
        "asset_owners": [
            {"id": "APT", "role": "AO"},
            {"id": "INT", "role": "integrator"},
        ],
        "conduits": [
            {
                "id": "CD-INT",
                "from": {"owner": "APT"},
                "to": {"owner": "INT"},
            }
        ],
    }
    validate_architecture(arch)  # must pass schema
    (r,) = evaluate_architecture(arch).results
    # integrator is not AO, so NC-2 (both-AO requirement) fails
    assert r.nc2 is False
    assert r.verdict is not Verdict.BLIND_SPOT
