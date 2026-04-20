"""
BlindSpotCheck - IEC 62443 multi-tenant monitoring blind-spot evaluator.

Evaluates the SC-1 AND NC-1 AND NC-2 biconditional from
  W. Kim, "Compliant Yet Blind: Measuring and Closing Multi-Tenant
  Monitoring Gaps in IEC 62443." 2026.

Public API:
    evaluate_architecture(arch_dict) -> ArchitectureReport
    load_architecture_from_path(path) -> dict
    load_architecture_from_text(text) -> dict
    format_text / format_json / format_markdown
"""

from .evaluator import (
    ArchitectureReport,
    NCResult,
    Verdict,
    evaluate_architecture,
)
from .output import format_json, format_markdown, format_text
from .schema import (
    InputTooLarge,
    SchemaError,
    load_architecture_from_path,
    load_architecture_from_text,
    validate_architecture,
)

__version__ = "0.1.0"

__all__ = [
    "ArchitectureReport",
    "InputTooLarge",
    "NCResult",
    "SchemaError",
    "Verdict",
    "evaluate_architecture",
    "format_json",
    "format_markdown",
    "format_text",
    "load_architecture_from_path",
    "load_architecture_from_text",
    "validate_architecture",
    "__version__",
]
