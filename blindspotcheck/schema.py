"""
YAML loading + JSON Schema validation.

Security hardening:
  - yaml.safe_load only (no python object deserialisation).
  - Explicit input-size cap (defends against resource exhaustion).
  - jsonschema Draft 2020-12 validation with additionalProperties: false.
  - No user-controlled file open with arbitrary paths (caller's job).
"""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

MAX_INPUT_BYTES = 1 * 1024 * 1024  # 1 MiB hard cap on YAML input
SCHEMA_FILE = "architecture-v1.json"


class SchemaError(Exception):
    """Raised when the YAML architecture violates the schema."""


class InputTooLarge(Exception):
    """Raised when the YAML file exceeds MAX_INPUT_BYTES."""


def load_schema() -> dict[str, Any]:
    """Load the bundled architecture schema."""
    pkg_root = resources.files("blindspotcheck.schemas")
    with pkg_root.joinpath(SCHEMA_FILE).open("r", encoding="utf-8") as f:
        return json.load(f)


def load_architecture_from_path(path: str | Path) -> dict[str, Any]:
    """
    Load + validate a YAML architecture file.

    Size is enforced at read time, *before* yaml parsing, to bound any resource
    usage from malicious inputs.
    """
    p = Path(path).expanduser().resolve()
    size = p.stat().st_size
    if size > MAX_INPUT_BYTES:
        raise InputTooLarge(
            f"Input file {p} is {size} bytes, exceeds the {MAX_INPUT_BYTES}-byte cap."
        )
    with p.open("r", encoding="utf-8") as f:
        text = f.read()
    return load_architecture_from_text(text)


def load_architecture_from_text(text: str) -> dict[str, Any]:
    """Parse + validate YAML from a string."""
    if len(text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise InputTooLarge(
            f"Input is {len(text)} bytes, exceeds the {MAX_INPUT_BYTES}-byte cap."
        )
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise SchemaError(f"YAML parse error: {exc}") from exc
    except RecursionError as exc:
        # PyYAML can hit the CPython recursion limit on pathologically deep
        # inputs before our size cap alone can stop them. Re-raise as
        # SchemaError so callers see a well-typed error instead of a crash.
        raise SchemaError(
            "YAML parse error: input is too deeply nested "
            "(RecursionError in yaml.safe_load)."
        ) from exc
    if not isinstance(data, dict):
        raise SchemaError("Top-level YAML value must be a mapping.")
    validate_architecture(data)
    return data


def validate_architecture(data: dict[str, Any]) -> None:
    """
    Validate `data` against the bundled JSON schema *and* the
    referential-integrity rules that jsonschema alone cannot express.
    Raises SchemaError on any failure.
    """
    schema = load_schema()
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    if errors:
        messages = []
        for err in errors:
            loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
            messages.append(f"  {loc}: {err.message}")
        raise SchemaError("Schema validation failed:\n" + "\n".join(messages))

    _validate_referential_integrity(data)


def _validate_referential_integrity(data: dict[str, Any]) -> None:
    """
    Cross-field checks that JSON Schema Draft 2020-12 cannot express:
      - every endpoint.owner references an existing asset_owners.id;
      - every sp_relations.sp / .ao references an existing asset_owners.id;
      - every zone_authorities.org references an existing asset_owners.id;
      - every endpoint.zone (when declared) has a zone_authorities entry
        IF zone_authorities is non-empty;
      - conduit ids are unique;
      - asset_owner ids are unique.
    """
    problems: list[str] = []

    owner_ids = [ao["id"] for ao in data.get("asset_owners", [])]
    owner_set = set(owner_ids)
    if len(owner_ids) != len(owner_set):
        seen: set[str] = set()
        dupes = {i for i in owner_ids if i in seen or seen.add(i)}  # type: ignore[func-returns-value]
        problems.append(f"asset_owners: duplicate id(s): {sorted(dupes)}")

    zone_authorities = data.get("zone_authorities") or []
    zone_set = {z["zone"] for z in zone_authorities}
    for z in zone_authorities:
        if z["org"] not in owner_set:
            problems.append(
                f"zone_authorities: zone '{z['zone']}' references unknown org '{z['org']}'"
            )

    for rel in data.get("sp_relations") or []:
        if rel["sp"] not in owner_set:
            problems.append(f"sp_relations: sp '{rel['sp']}' is not in asset_owners")
        if rel["ao"] not in owner_set:
            problems.append(f"sp_relations: ao '{rel['ao']}' is not in asset_owners")

    conduit_ids: list[str] = []
    for c in data.get("conduits", []):
        cid = c.get("id")
        if cid is not None:
            conduit_ids.append(cid)
        for side in ("from", "to"):
            ep = c.get(side, {}) or {}
            owner = ep.get("owner")
            if owner is not None and owner not in owner_set:
                problems.append(
                    f"conduits[{cid}].{side}.owner '{owner}' is not in asset_owners"
                )
            z = ep.get("zone")
            if z is not None and zone_authorities and z not in zone_set:
                problems.append(
                    f"conduits[{cid}].{side}.zone '{z}' is not declared in zone_authorities"
                )

    # Reject duplicate conduit ids after collecting them all so the message
    # enumerates every duplicate rather than stopping at the first.
    if len(conduit_ids) != len(set(conduit_ids)):
        dup_set: set[str] = set()
        seen_c: set[str] = set()
        for i in conduit_ids:
            if i in seen_c:
                dup_set.add(i)
            seen_c.add(i)
        problems.append(f"conduits: duplicate id(s): {sorted(dup_set)}")

    # Finally, sp_relations.scope entries must refer to existing conduit ids.
    for rel in data.get("sp_relations") or []:
        scope = rel.get("scope")
        if not scope:
            continue
        for cid in scope:
            if cid not in conduit_ids:
                problems.append(
                    f"sp_relations({rel['sp']}->{rel['ao']}).scope references unknown conduit '{cid}'"
                )

    if problems:
        raise SchemaError("Referential integrity failed:\n" + "\n".join(f"  {p}" for p in problems))
