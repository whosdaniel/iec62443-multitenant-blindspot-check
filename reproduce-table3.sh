#!/usr/bin/env bash
# Reproduces Table 3 of W. Kim (2026) "Compliant Yet Blind" from a fresh
# clone of this repository. Intended as the one-command entry point for
# artifact-evaluation reviewers.
#
# Covers paper contributions C1 (biconditional) and C4 (active / latent
# taxonomy). Contributions that depend on the Docker testbed (C2
# measurement, C3 observability matrix Table 4, C5 Baseline Exchange
# Protocol Table 5) live in the separate testbed archive at Zenodo DOI
# 10.5281/zenodo.19627489 and are NOT reproduced by this script.
#
# Exits 0 if the verdict distribution matches paper Table 3 exactly:
#   3 blind-spot  (CD-06, CD-08a, CD-08b)
#   2 borderline  (CD-04, CD-05)
#   2 resolved-by-sp  (CD-01, CD-09)
#  12 no-cross-ao   (CD-02, CD-03, CD-07, CD-10, CD-11, CD-20..CD-26)
# yielding 3/19 = 15.8% structural blind-spot rate.
#
# Usage:
#   bash reproduce-table3.sh
# or:
#   chmod +x reproduce-table3.sh && ./reproduce-table3.sh

set -euo pipefail

PYTHON="${PYTHON:-python3}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

printf '== Installing blindspotcheck (editable) ==\n'
"$PYTHON" -m pip install --quiet --upgrade pip
"$PYTHON" -m pip install --quiet -e .

printf '\n== Regression test: airport YAML reproduces paper Table 3 ID-for-ID ==\n'
"$PYTHON" -m pytest -q tests/test_samples.py::test_airport_sample_reproduces_paper_table3

printf '\n== CLI: evaluating examples/airport-common-use-terminal.yaml ==\n'
OUT="$(mktemp -t bsc-airport.XXXXXX.json)"
trap 'rm -f "$OUT"' EXIT
blindspotcheck examples/airport-common-use-terminal.yaml --format json > "$OUT"

printf '\n== Asserting verdict distribution matches paper Table 3 ==\n'
"$PYTHON" - <<PY
import json, sys
with open("$OUT") as f:
    payload = json.load(f)
dist = payload["distribution"]
expected = {
    "blind-spot": 3,
    "borderline": 2,
    "resolved-by-sp": 2,
    "no-cross-ao": 12,
}
for key, want in expected.items():
    got = dist.get(key, 0)
    assert got == want, (
        f"verdict '{key}' mismatch: expected {want}, got {got} "
        f"(full distribution={dist})"
    )
total = sum(dist.values())
pct = dist["blind-spot"] / total * 100
print(f"  distribution  = {dist}")
print(f"  total conduits = {total}")
print(f"  blind-spot rate = {dist['blind-spot']}/{total} = {pct:.1f}%  (paper headline: 15.8%)")
PY

printf '\n== Reproduction confirmed ==\n'
printf 'Paper contributions C1 + C4 reproduced from this repository.\n'
printf 'Testbed-dependent contributions (C2, C3, C5) require the archive at\n'
printf '  https://doi.org/10.5281/zenodo.19627489\n'
