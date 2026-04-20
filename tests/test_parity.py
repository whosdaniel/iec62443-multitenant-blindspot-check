"""
Python <-> JS parity tests.

The Python implementation in `blindspotcheck/` is the authoritative
evaluator. The JS port in `web/` must produce byte-identical results on
every bundled architecture so both front-ends (CLI and canvas UI) agree
on every verdict.

Also verifies that `web/schema.js` holds a structurally-identical copy
of `blindspotcheck/schemas/architecture-v1.json`.

Subprocess contract: helper scripts under `tests/web/run_*.mjs` use
relative imports like `'../../web/evaluator.js'`. Every subprocess call
here runs with `cwd=REPO_ROOT` and spawns Node with absolute paths to
those helpers, so the relative imports resolve. Moving either this
module or the helper scripts requires updating both REPO_ROOT and the
paths together.

Node-availability policy:
  * `test_parity_environment_has_node` is a LOUD sentinel: when Node is
    missing it fails the test run (rather than silently skipping). This
    matters for artifact-evaluation reviewers who otherwise see a green
    "50 passed" while the load-bearing cross-language tests were quietly
    skipped.
  * Every other parity test still calls `_node()`, which skips when Node
    is absent. That combination means a Python-only environment gets one
    clear failure from the sentinel plus a series of skips for the rest,
    never a misleading "all pass."
  * Set BLINDSPOT_ALLOW_SKIP_PARITY=1 to convert the sentinel failure
    into a skip (for genuinely Python-only sandboxes).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from blindspotcheck import evaluate_architecture, load_architecture_from_path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = REPO_ROOT / "examples"
JS_RUNNER = REPO_ROOT / "tests" / "web" / "run_evaluator.mjs"
JS_SCHEMA_DUMPER = REPO_ROOT / "tests" / "web" / "dump_schema.mjs"
JS_YAML_EXPORT = REPO_ROOT / "tests" / "web" / "run_yaml_export.mjs"
PY_SCHEMA = REPO_ROOT / "blindspotcheck" / "schemas" / "architecture-v1.json"


def test_parity_environment_has_node() -> None:
    """
    Loud canary: the cross-language parity suite below depends on Node.
    A silent skip would mislead an artifact-evaluation reviewer who reads
    "X passed" and treats the parity guarantee as exercised. This test
    fails explicitly when Node is missing, converting the gap into a
    visible failure rather than a hidden skip.

    Opt out with BLINDSPOT_ALLOW_SKIP_PARITY=1 on truly Python-only
    sandboxes.
    """
    if shutil.which("node") is not None:
        return  # Environment is parity-capable; silent pass.
    if os.environ.get("BLINDSPOT_ALLOW_SKIP_PARITY") == "1":
        pytest.skip("node not available; parity tests explicitly skipped.")
    pytest.fail(
        "node is not available on PATH - the JS-side parity tests cannot "
        "run. Install Node.js 20 or newer, or export "
        "BLINDSPOT_ALLOW_SKIP_PARITY=1 to acknowledge the gap.",
    )


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not available on PATH - JS parity tests require Node.js")
    return node


def _run_js(script: Path, stdin: str | None = None, timeout: float = 60.0) -> str:
    """
    Run a Node script that lives under `tests/web/`. The subprocess runs
    with cwd=REPO_ROOT so the script's relative imports into `web/`
    resolve; the default 60 s timeout is roomy enough for slow CI
    runners (M-series emulation, busy GitHub-hosted workers) without
    hiding genuine hangs.
    """
    node = _node()
    result = subprocess.run(
        [node, str(script)],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        raise AssertionError(
            f"Node script {script.name} failed (rc={result.returncode}):\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )
    return result.stdout


@pytest.mark.parametrize(
    "filename",
    [
        "airport-common-use-terminal.yaml",
        "rail-passenger-station.yaml",
        "maritime-container-terminal.yaml",
    ],
)
def test_js_evaluator_parity_on_bundled_samples(filename: str) -> None:
    """
    For each bundled example, the JS evaluator must produce identical
    SC-1 / NC-1 / NC-2 flags, verdicts, mitigations, and rationales as
    the Python evaluator.
    """
    path = EXAMPLES / filename
    arch = load_architecture_from_path(path)

    # Python side.
    py_report = evaluate_architecture(arch)
    py_payload = {
        "domain": py_report.domain,
        "source_standards": list(py_report.source_standards),
        "distribution": py_report.distribution(),
        "conduits": [r.as_row() for r in py_report.results],
    }

    # JS side: pipe the parsed arch as JSON.
    js_stdout = _run_js(JS_RUNNER, stdin=json.dumps(arch))
    js_payload = json.loads(js_stdout)

    assert py_payload["domain"] == js_payload["domain"], filename
    assert py_payload["source_standards"] == js_payload["source_standards"], filename
    assert py_payload["distribution"] == js_payload["distribution"], filename

    # Per-conduit parity: ensure same order, same flags, same verdict,
    # same mitigations, same rationale strings (byte-identical).
    assert len(py_payload["conduits"]) == len(js_payload["conduits"]), filename
    for py_c, js_c in zip(py_payload["conduits"], js_payload["conduits"], strict=True):
        assert py_c == js_c, (
            f"{filename}: conduit parity mismatch\n"
            f"  python: {py_c}\n"
            f"  js    : {js_c}"
        )


def test_web_schema_matches_python_schema() -> None:
    """web/schema.js must embed the same schema as the Python JSON file."""
    py_schema = json.loads(PY_SCHEMA.read_text(encoding="utf-8"))
    js_stdout = _run_js(JS_SCHEMA_DUMPER)
    js_schema = json.loads(js_stdout)
    assert py_schema == js_schema, (
        "web/schema.js has drifted from blindspotcheck/schemas/architecture-v1.json. "
        "Regenerate the JS copy so the two stay in sync."
    )


def test_js_validator_rejects_bad_additional_properties() -> None:
    """
    Sanity check: the JS validator agrees with the Python validator on a
    canonical 'bad input' that both must reject.
    """
    bad_arch = {
        "meta": {"schema_version": "1", "domain": "t"},
        "asset_owners": [
            {"id": "A", "role": "AO"},
            {"id": "B", "role": "AO"},
        ],
        "conduits": [
            {
                "id": "C1",
                "from": {"owner": "A"},
                "to": {"owner": "B"},
                "typo_field": "should fail",
            }
        ],
    }

    # Python side: schema validation must reject.
    from blindspotcheck.schema import SchemaError, validate_architecture

    with pytest.raises(SchemaError):
        validate_architecture(bad_arch)

    # JS side: one-shot script that imports the validator and exits non-zero
    # on rejection (matching Python behaviour).
    node = _node()
    script = (
        "import { validateArchitecture, SchemaError } "
        "from './web/schema-validator.js';\n"
        "const txt = await new Promise((resolve) => {\n"
        "  let data = '';\n"
        "  process.stdin.setEncoding('utf8');\n"
        "  process.stdin.on('data', (c) => (data += c));\n"
        "  process.stdin.on('end', () => resolve(data));\n"
        "});\n"
        "try {\n"
        "  validateArchitecture(JSON.parse(txt));\n"
        "  console.log('ACCEPTED');\n"
        "  process.exit(0);\n"
        "} catch (e) {\n"
        "  if (e instanceof SchemaError) {\n"
        "    console.log('REJECTED');\n"
        "    process.exit(2);\n"
        "  }\n"
        "  throw e;\n"
        "}\n"
    )
    result = subprocess.run(
        [node, "--input-type=module", "-e", script],
        input=json.dumps(bad_arch),
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 2, (
        f"JS validator should have rejected bad input (rc={result.returncode}, "
        f"stdout={result.stdout!r}, stderr={result.stderr!r})"
    )
    assert "REJECTED" in result.stdout


# ---------------------------------------------------------------------------
# Stage F: YAML export round-trip (JS -> Python CLI ingestion)
# ---------------------------------------------------------------------------

# Exact-match expectation: the airport canvas template draws the 13
# conduits from paper Fig 2; CD-20..23, 25..26 are documented in the
# template meta and exercised separately via examples/airport-common-
# use-terminal.yaml (see tests/test_samples.py). The JS-export round-
# trip therefore pins the 13-row distribution. The authoritative 19-row
# headline stays verified against that YAML.
_YAML_ROUND_TRIP_EXACT = [
    (
        "airport-cupps-1.0",
        {
            "blind-spot": 3,
            "borderline": 2,
            "resolved-by-sp": 2,
            "no-cross-ao": 6,
        },
    ),
]

# At-least expectation: analytic-hypothesis templates (paper §8.1) are
# structural mappings, not measurements, so the paper does not pin
# specific counts. We pin minimum verdict counts for each template to
# catch regressions that would silently flip a conduit's classification
# (which is the entire point of the parity guarantee) without demanding
# an exact count the paper itself does not make.
_YAML_ROUND_TRIP_AT_LEAST = [
    ("rail-passenger-station",      {"blind-spot": 4, "resolved-by-sp": 1}),
    ("maritime-container-terminal", {"blind-spot": 3, "resolved-by-sp": 1}),
    ("power-grid-tso-dso",          {"blind-spot": 2}),
]


def _js_yaml_round_trip(template_id: str) -> dict:
    """
    Drive the JS YAML emitter, feed its output through the Python CLI's
    loader, and return the resulting verdict distribution. Shared by
    both the exact and at-least test variants below.
    """
    from blindspotcheck import (
        evaluate_architecture as py_eval,
        load_architecture_from_text,
    )

    node = _node()
    proc = subprocess.run(
        [node, str(JS_YAML_EXPORT), template_id],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(REPO_ROOT),
    )
    assert proc.returncode == 0, (
        f"JS YAML exporter failed for {template_id}: rc={proc.returncode} "
        f"stderr={proc.stderr!r}"
    )
    yaml_text = proc.stdout
    assert yaml_text.startswith("#"), "expected a leading header comment"
    arch = load_architecture_from_text(yaml_text)
    return py_eval(arch).distribution()


@pytest.mark.parametrize("template_id,expected_dist", _YAML_ROUND_TRIP_EXACT)
def test_js_yaml_export_round_trips_exact(template_id: str, expected_dist: dict) -> None:
    """
    Strongest parity assertion: JS YAML emitter -> Python CLI loader ->
    evaluator produces exactly the paper's Table 3 distribution.
    """
    dist = _js_yaml_round_trip(template_id)
    for key, value in expected_dist.items():
        assert dist[key] == value, (
            f"{template_id}: expected exact {key}={value}, got {dist[key]} "
            f"(full distribution={dist})"
        )


@pytest.mark.parametrize("template_id,min_expected", _YAML_ROUND_TRIP_AT_LEAST)
def test_js_yaml_export_round_trips_at_least(
    template_id: str, min_expected: dict
) -> None:
    """
    Analytic-hypothesis templates. Paper §8.1 frames these as structural
    claims, not measured counts. We still pin at-least thresholds so a
    silent template edit that flipped a rail / maritime / power verdict
    cannot slip past (Agent-5 feedback round 2).
    """
    dist = _js_yaml_round_trip(template_id)
    for key, min_value in min_expected.items():
        assert dist[key] >= min_value, (
            f"{template_id}: expected at least {key} >= {min_value}, "
            f"got {dist[key]} (full distribution={dist})"
        )


def test_js_yaml_escapes_c1_controls_for_python_round_trip() -> None:
    """
    Regression test: PyYAML 1.1 silently normalises raw U+0085 (NEL) inside
    a double-quoted scalar to an ASCII space. If the JS YAML emitter passed
    NEL through verbatim, notes pasted from legacy documents would silently
    mutate on the JS -> YAML -> Python CLI round trip. This pins the escape
    to ``\\x85`` so the byte-faithful round trip holds.
    """
    from blindspotcheck import load_architecture_from_text

    node = _node()
    script = (
        "import { archToYaml } from './web/yaml-export.js';\n"
        "const arch = {\n"
        "  meta: { schema_version: '1', domain: 'test' },\n"
        "  asset_owners: [\n"
        "    { id: 'A', role: 'AO' }, { id: 'B', role: 'AO' },\n"
        "  ],\n"
        "  conduits: [{\n"
        "    id: 'C1',\n"
        "    from: { owner: 'A' },\n"
        "    to:   { owner: 'B' },\n"
        "    notes: 'keep-\\u0080-\\u0085-\\u009f-end',\n"
        "  }],\n"
        "};\n"
        "process.stdout.write(archToYaml(arch));\n"
    )
    result = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, (
        f"node script failed: stderr={result.stderr!r}"
    )
    yaml_text = result.stdout

    for codepoint in ("\u0080", "\u0085", "\u009F"):
        assert codepoint not in yaml_text, (
            f"JS YAML emitter leaked raw {codepoint!r} (codepoint U+{ord(codepoint):04X})"
        )

    arch = load_architecture_from_text(yaml_text)
    notes = arch["conduits"][0]["notes"]
    assert notes == "keep-\u0080-\u0085-\u009f-end", (
        f"C1 round trip lost bytes: expected 'keep-\\u0080-\\u0085-\\u009f-end', "
        f"got {notes!r}"
    )
