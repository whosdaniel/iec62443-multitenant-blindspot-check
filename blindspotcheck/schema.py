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
    if not isinstance(data, dict):
        raise SchemaError("Top-level YAML value must be a mapping.")
    validate_architecture(data)
    return data


def validate_architecture(data: dict[str, Any]) -> None:
    """Raise SchemaError if `data` does not match the bundled schema."""
    schema = load_schema()
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    if not errors:
        return
    messages = []
    for err in errors:
        loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
        messages.append(f"  {loc}: {err.message}")
    raise SchemaError("Schema validation failed:\n" + "\n".join(messages))
