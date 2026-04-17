"""
Adversarial-input and referential-integrity tests.

These tests harden the tool against inputs an attacker (or a sloppy user)
might hand it: YAML bombs, deep nesting, cross-reference mistakes, duplicate
ids. The tool must refuse these cleanly (SchemaError or InputTooLarge) and
never crash, hang, or silently misclassify.
"""

from __future__ import annotations

import pytest

from blindspotcheck.schema import (
    InputTooLarge,
    SchemaError,
    load_architecture_from_text,
)

# ---------------------------------------------------------------------------
# YAML-bomb / recursion defence
# ---------------------------------------------------------------------------


def test_billion_laughs_anchor_bomb_refused() -> None:
    """
    Classic YAML anchor-expansion bomb. yaml.safe_load performs limited anchor
    resolution, but the resulting structure must *not* validate against our
    schema (arrays of ints don't match 'asset_owners' / 'conduits' shape) and
    the tool must refuse without consuming pathological memory.
    """
    bomb = (
        "a: &a [1,1,1,1,1,1,1,1,1]\n"
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n"
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
        "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n"
        "meta: { schema_version: \"1\", domain: bomb }\n"
    )
    # Must either be rejected by size cap or by schema validator — the key
    # property is that it terminates and does not crash the interpreter.
    with pytest.raises(SchemaError):
        load_architecture_from_text(bomb)


def test_deep_nesting_refused() -> None:
    """
    Deeply nested mappings. Our schema's additionalProperties: false and the
    flat top-level structure mean deep nesting cannot appear anywhere the
    schema accepts it. Anything pathological is rejected.
    """
    # 500-level-deep mapping; well within yaml.safe_load's recursion limits
    # but cannot match our schema at any level.
    deep = "x:\n" + "".join("  " * i + "x:\n" for i in range(1, 500)) + "  " * 500 + "null\n"
    with pytest.raises(SchemaError):
        load_architecture_from_text(deep)


def test_giant_string_near_cap_accepted() -> None:
    """A legitimately large (but below-cap) description string must not crash."""
    from blindspotcheck.schema import MAX_INPUT_BYTES

    # Build a valid doc with a large description field; target ~ 80% of cap.
    big = "x" * int(MAX_INPUT_BYTES * 0.8)
    yaml_text = f"""
meta:
  schema_version: "1"
  domain: big
  disclaimer: "{big}"
asset_owners:
  - {{ id: A, role: AO }}
  - {{ id: B, role: AO }}
conduits:
  - id: C1
    from: {{ owner: A }}
    to:   {{ owner: B }}
"""
    arch = load_architecture_from_text(yaml_text)
    assert arch["meta"]["domain"] == "big"


def test_cap_plus_one_refused() -> None:
    """Even one byte over the cap must be refused before parsing."""
    from blindspotcheck.schema import MAX_INPUT_BYTES

    payload = "x" * (MAX_INPUT_BYTES + 1)
    with pytest.raises(InputTooLarge):
        load_architecture_from_text(payload)


# ---------------------------------------------------------------------------
# Referential-integrity checks
# ---------------------------------------------------------------------------


def _valid_base() -> str:
    return """
meta: { schema_version: "1", domain: t }
asset_owners:
  - { id: A, role: AO }
  - { id: B, role: AO }
  - { id: C, role: AO }
conduits:
  - id: C1
    from: { owner: A }
    to:   { owner: B }
"""


def test_endpoint_references_nonexistent_owner_rejected() -> None:
    yaml_text = _valid_base().replace("owner: A", "owner: NOPE", 1)
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "NOPE" in str(exc.value)
    assert "asset_owners" in str(exc.value)


def test_sp_relations_references_nonexistent_owner_rejected() -> None:
    yaml_text = _valid_base() + """
sp_relations:
  - { sp: GHOST, ao: A }
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "GHOST" in str(exc.value)


def test_sp_relations_scope_references_nonexistent_conduit_rejected() -> None:
    yaml_text = _valid_base() + """
sp_relations:
  - { sp: A, ao: B, scope: [CD-UNKNOWN] }
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "CD-UNKNOWN" in str(exc.value)


def test_zone_authorities_references_nonexistent_org_rejected() -> None:
    yaml_text = _valid_base() + """
zone_authorities:
  - { zone: Z-A, org: MYSTERY }
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "MYSTERY" in str(exc.value)


def test_endpoint_zone_without_zone_authority_rejected() -> None:
    """
    If zone_authorities is declared, every endpoint.zone must be declared
    there too. Silent omission lets NC-3 evaluate to the NC-1 fallback,
    which is surprising — explicit rejection is safer.
    """
    yaml_text = """
meta: { schema_version: "1", domain: t }
asset_owners:
  - { id: A, role: AO }
  - { id: B, role: AO }
zone_authorities:
  - { zone: Z-A, org: A }
conduits:
  - id: C1
    from: { owner: A, zone: Z-A }
    to:   { owner: B, zone: Z-GHOST }
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "Z-GHOST" in str(exc.value)


def test_duplicate_conduit_id_rejected() -> None:
    yaml_text = """
meta: { schema_version: "1", domain: t }
asset_owners:
  - { id: A, role: AO }
  - { id: B, role: AO }
conduits:
  - id: DUP
    from: { owner: A }
    to:   { owner: B }
  - id: DUP
    from: { owner: B }
    to:   { owner: A }
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "duplicate" in str(exc.value).lower()
    assert "DUP" in str(exc.value)


def test_duplicate_asset_owner_id_rejected() -> None:
    yaml_text = """
meta: { schema_version: "1", domain: t }
asset_owners:
  - { id: X, role: AO }
  - { id: X, role: AO }
conduits:
  - id: C1
    from: { owner: X }
    to:   { owner: X }
"""
    with pytest.raises(SchemaError) as exc:
        load_architecture_from_text(yaml_text)
    assert "duplicate" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# Misc: unusual but legal inputs must not crash
# ---------------------------------------------------------------------------


def test_unicode_labels_accepted_when_pattern_matches() -> None:
    """
    Schema id pattern is ^[A-Za-z][A-Za-z0-9_-]{0,63}$ — ASCII only. Non-ASCII
    labels must be rejected by the pattern. (This is intentional: keeps IDs
    diff-safe and uniformly indexable.)
    """
    yaml_text = _valid_base().replace("id: A", 'id: "\uc790\uc0b0"', 1)  # Korean "자산"
    with pytest.raises(SchemaError):
        load_architecture_from_text(yaml_text)


def test_utf8_bom_accepted() -> None:
    """UTF-8 BOM at the start of the text must be tolerated."""
    yaml_text = "\ufeff" + _valid_base()
    arch = load_architecture_from_text(yaml_text)
    assert arch["meta"]["domain"] == "t"


def test_crlf_line_endings_accepted() -> None:
    yaml_text = _valid_base().replace("\n", "\r\n")
    arch = load_architecture_from_text(yaml_text)
    assert arch["meta"]["domain"] == "t"
