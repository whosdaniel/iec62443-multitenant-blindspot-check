"""
Command-line interface.

Usage:
    blindspotcheck PATH [--format {text,json,markdown}] [--output FILE]
    blindspotcheck --validate PATH
    blindspotcheck --schema > architecture-v1.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .evaluator import Verdict, evaluate_architecture
from .output import format_json, format_markdown, format_text
from .schema import (
    InputTooLarge,
    SchemaError,
    load_architecture_from_path,
    load_schema,
)

EXIT_OK = 0
EXIT_SCHEMA_ERR = 2
EXIT_IO_ERR = 3
EXIT_BLIND_SPOTS = 10  # used when --fail-on-blind-spot is set


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="blindspotcheck",
        description=(
            "Evaluate IEC 62443 SC-1 AND NC-1 AND NC-2 biconditional on a "
            "multi-tenant architecture YAML. Reports which conduits are "
            "structural monitoring blind spots."
        ),
    )
    p.add_argument("path", nargs="?", help="Architecture YAML file.")
    p.add_argument(
        "--format",
        choices=["text", "json", "markdown"],
        default="text",
        help="Output format (default: text).",
    )
    p.add_argument(
        "--output",
        "-o",
        default="-",
        help="Output file (- for stdout, default).",
    )
    p.add_argument(
        "--validate",
        action="store_true",
        help="Only validate the YAML against the schema; print OK or errors and exit.",
    )
    p.add_argument(
        "--schema",
        action="store_true",
        help="Print the bundled JSON schema to stdout and exit.",
    )
    p.add_argument(
        "--fail-on-blind-spot",
        action="store_true",
        help=(
            f"Exit with code {EXIT_BLIND_SPOTS} if any conduit is classified as "
            "a blind-spot (useful for CI / policy gates)."
        ),
    )
    p.add_argument(
        "--version",
        action="version",
        version=f"blindspotcheck {__version__}",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.schema:
        json.dump(load_schema(), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return EXIT_OK

    if not args.path:
        print("error: a YAML architecture path is required (or use --schema)", file=sys.stderr)
        return EXIT_IO_ERR

    try:
        arch = load_architecture_from_path(args.path)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_IO_ERR
    except InputTooLarge as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_IO_ERR
    except SchemaError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_SCHEMA_ERR

    if args.validate:
        print("OK")
        return EXIT_OK

    report = evaluate_architecture(arch)
    if args.format == "json":
        rendered = format_json(report)
    elif args.format == "markdown":
        rendered = format_markdown(report)
    else:
        rendered = format_text(report)

    if args.output == "-":
        sys.stdout.write(rendered)
    else:
        Path(args.output).expanduser().resolve().write_text(rendered, encoding="utf-8")

    if args.fail_on_blind_spot and any(
        r.verdict is Verdict.BLIND_SPOT for r in report.results
    ):
        return EXIT_BLIND_SPOTS
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
