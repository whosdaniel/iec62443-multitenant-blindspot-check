# BlindSpotCheck

A tool for checking IEC 62443 multi-tenant architectures for monitoring blind spots.

You describe an architecture (either by drawing it in the browser canvas or writing a YAML file), and BlindSpotCheck tells you which conduits don't have a clear monitoring owner. It's the companion tool to W. Kim (2026), *"Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443"*, and reproduces the paper's Table 3 result exactly.

## What's a "blind spot" here?

It's a conduit (a crossing between two network zones) where nobody actually owns the job of watching it. Not because someone forgot, but because the structure of the tenancy and the service-provider contracts doesn't assign that job to anyone. The paper calls this a *structural* blind spot and defines it with three predicates:

```
SC-1(c) : the conduit's endpoints belong to different asset owners.
NC-1(c) : no service-provider contract covers it, and both owners
          are independent asset owners (not SPs for each other).
NC-2(c) : no single organisation designates the zones on both sides.

If SC-1 holds, then the conduit is a blind spot if and only if both
NC-1 and NC-2 also hold.
```

If you want the clause-by-clause derivation (which IEC 62443 paragraph each predicate traces back to), open [`docs/design.md`](docs/design.md).

## Two ways to use it

You can draw an architecture on a canvas, or pass a YAML file to the CLI. They share the same evaluator and round-trip through each other cleanly.

### Canvas in the browser

```bash
git clone https://github.com/whosdaniel/iec62443-multitenant-blindspot-check
cd iec62443-multitenant-blindspot-check/web
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser. The local HTTP server is needed because modern browsers block ES modules loaded via `file://`.

Once it's up:

- Drag owner chips from the left panel onto nodes to assign asset owners. Drop one on a zone to set that zone's designating authority.
- Click "Connect", then a source node, then a target node. The new edge's verdict appears instantly.
- Use "Load template..." if you want a starting point. The Airport template reproduces Paper Table 3 line for line.

Everything runs inside the browser tab. No network calls, no telemetry, nothing leaves your machine.

### Command line

```bash
pip install -e .
blindspotcheck examples/airport-common-use-terminal.yaml
```

Sample output:

```
Conduit         SC-1  NC-1  NC-2  Verdict         Rationale
-----------------------------------------------------------
CD-08a          Y     Y     Y     blind-spot      SC-1 AND NC-1 AND NC-2...
CD-08b          Y     Y     Y     blind-spot      SC-1 AND NC-1 AND NC-2...
CD-06           Y     Y     Y     blind-spot      SC-1 AND NC-1 AND NC-2...
CD-04           Y     Y     -     borderline      SC-1 AND NC-1 hold but...
...
Total: 19  |  blind-spot 3 (15.8%)  borderline 2  resolved-by-sp 2  no-cross-ao 12
```

The CLI also supports `--fail-on-blind-spot` (handy if you want a CI gate) and `--schema` (dumps the JSON schema).

The canvas can export its current state to this same YAML format, so you can draw something in the browser and then evaluate it from the CLI. There's also an "Export PDF" button that uses your browser's print dialog.

## What the verdicts mean

| SC-1 | NC-1 | NC-2 | Verdict          | Meaning |
|------|------|------|------------------|---------|
| Y    | Y    | Y    | **blind-spot**   | All three predicates hold. This is the structural case the paper is about. |
| Y    | Y    | -    | borderline       | It's cross-AO and uncovered, but one organisation still designates both zones today. If governance later splits, it drifts into blind-spot. |
| Y    | -    | *    | resolved-by-sp   | An SP-AO relationship covers the conduit. IEC 62443-2-4 obligations flow through it. |
| -    | *    | *    | no-cross-ao      | Both endpoints have the same owner, so it isn't a multi-tenant conduit. |

## Templates bundled with the canvas

Pick one from "Load template...":

| Template | Evidence | Notes |
|----------|----------|-------|
| Airport CUPPS 1.0 | **measured** | Reproduces paper Table 3 line for line. 3 of 19 conduits (15.8%) come out as structural blind spots. |
| Rail passenger station (multi-TOC) | analytic | Paper §8.1 cross-domain hypothesis. |
| Maritime container terminal | analytic | Paper §8.1 cross-domain hypothesis. |
| Power grid TSO/DSO interface | analytic | Paper §8.1 cross-domain hypothesis. |
| Empty canvas | custom | Start from scratch. |

The banner at the top of the canvas is green only for the measured template. The others show an amber banner reminding you that their verdicts are structural claims from paper §8.1, not empirically validated results.

**Why no CUPPS 2.0 variants?** Paper §8.2 (Limitation 6) lists CUPPS 2.0 shared-host and per-agent-VM deployments as variants with different blind-spot counts, and §8.3 defers a full classification to future work. Shipping templates for them would be a tool-level claim the paper hasn't made yet, so they're deliberately left out.

## Keyboard shortcuts

| Key | What it does |
|-----|--------|
| `N` | Enter Add-node mode (click the canvas to place) |
| `C` | Enter Connect mode (click source, then target) |
| `F` | Fit the graph to the view |
| `Escape` | Exit the current mode, or deselect |
| `Delete` / `Backspace` | Delete the selected element |
| `?` | Open help |
| `Ctrl`/`Cmd` `+ Z` | Undo (50 steps of history) |
| `Ctrl`/`Cmd` `+ Shift + Z` | Redo |
| `Ctrl`/`Cmd` `+ Y` | Redo (alternate binding) |
| `Ctrl`/`Cmd` `+ S` | Save to file |
| `Ctrl`/`Cmd` `+ Shift + S` | Save as |
| `Ctrl`/`Cmd` `+ O` | Load from file |
| `Ctrl`/`Cmd` `+ N` | New empty canvas |

## Reproducing the paper

If you're doing artifact evaluation on a two-hour timebox, the fastest path is:

```bash
bash reproduce-table3.sh
```

That script installs the package, runs the exact-match regression test, evaluates the airport template through the CLI, and verifies the verdict distribution matches Paper Table 3 at 3 / 19 = 15.8%. It exits 0 on success, non-zero on any mismatch.

### What lives here vs elsewhere

| Paper contribution | Where to reproduce | How |
|---|---|---|
| **C1** biconditional (§4.1) | this repo | `bash reproduce-table3.sh` or `pytest tests/test_samples.py::test_airport_sample_reproduces_paper_table3` |
| **C4** active / latent taxonomy | this repo | Airport template conduit notes + Properties panel; `docs/design.md` clause derivation |
| C2 40-service Docker testbed (§3) | [zenodo.19627489](https://doi.org/10.5281/zenodo.19627489) | `docker compose up` inside the testbed archive |
| C3 observability matrix, Tables 1 / 4 (§5) | [zenodo.19627489](https://doi.org/10.5281/zenodo.19627489) | Testbed pcap replays plus per-tenant SOC containers |
| C5 Baseline Exchange Protocol, Table 5 (§5.5) | [zenodo.19627489](https://doi.org/10.5281/zenodo.19627489) | `baseline-L{1,2,3}.rules` under `testbed/soc/suricata/rules/` |
| C6 three governance barriers and options (§7) | paper only | §7 is expository; no companion code |
| C7 cross-framework convergence Table 8 (§7.3) | paper only | §7.3 is expository; no companion code |

So this repo is the C1 and C4 substrate. C2, C3, and C5 live in the separate Zenodo archive linked above. C6 and C7 are analytical, and you reproduce them by reading the paper.

## Pinning your reproduction

The paper's measured results are pinned to the `v1.0.0` tag. If you're reproducing Paper Table 3 or building downstream work that needs stable semantics, clone at that tag:

```bash
git clone --branch v1.0.0 https://github.com/whosdaniel/iec62443-multitenant-blindspot-check
```

The `main` branch carries post-release bug fixes and minor additions. Those don't re-trigger the Zenodo archival workflow on their own. They only get archived if a later `v1.x.y` tag is cut.

## Forks and contributions

This repo is the companion to the paper, so I keep the scope tied to the research and don't merge external pull requests here. If you want to build on this, please fork it. That's the right home for your own improvements, and it's how most research-companion code works. Everything's MIT, so go for it.

Bug reports and questions through issues are very welcome. I'll read them when I have time, though I can't promise fast replies. Thanks for understanding.

## How safe is this to run

**Python side**

- YAML is parsed with `yaml.safe_load` only. Object tags like `!!python/object/apply` are rejected.
- Input is capped at 1 MiB.
- JSON Schema validation (Draft 2020-12) runs on every architecture, with `additionalProperties: false`.
- No network calls. Everything is local compute.

**Browser side**

- Browser save files are capped at 4 MiB.
- Same JSON Schema, validated in the browser. A schema-sync test fails CI if the two copies drift.
- Strict Content-Security-Policy with `connect-src 'none'`. No outbound fetch, no WebSocket, no `eval`, no `new Function`.
- Cytoscape.js 3.33.2 is vendored under `web/vendor/` with an SHA-256 pin and its MIT licence file alongside. The tool never fetches external code at runtime.

**CI**

- `bandit`, `pip-audit`, GitHub dependency-review, Dependabot, and CodeQL run on every push.
- GitHub Actions are pinned by commit SHA.

## Handling your own architectures

Canvas save files include everything on the canvas, including any notes you've added. Before sharing one:

- Read through the notes. There's no auto-sanitisation step for sensitive content.
- Please don't paste Sensitive Security Information (SSI) as defined by 49 CFR Part 1520 (US aviation) or an equivalent national classification. The tool is built around abstract role labels (APT, ALN, VND, IM, TOC, and so on), and it should stay that way in anything you share publicly.
- Auto-save writes to your browser's LocalStorage, not to disk. It survives closing the tab, but not clearing your browser profile.

## Develop

```bash
pip install -e ".[dev]"

# Python test suite
pytest

# JS test suite (Node built-in test runner)
node --test \
  tests/web/test_evaluator.mjs \
  tests/web/test_templates.mjs \
  tests/web/test_history.mjs \
  tests/web/test_yaml_export.mjs

bandit -r blindspotcheck
pip-audit
```

The JS suite covers the evaluator, schema validator, template Table 3 reproduction, undo/redo history, and YAML export unit tests. The Python parity test in `tests/test_parity.py` ties the two sides together: it runs every bundled template through the JS YAML emitter, then feeds the output back through the Python CLI's loader and verifies the verdicts line up.

## YAML schema reference

`blindspotcheck/schemas/architecture-v1.json` is the authoritative schema. See [`docs/yaml-schema.md`](docs/yaml-schema.md) for the field-by-field reference and [`docs/design.md`](docs/design.md) for the evaluator's derivation.

## Cite

See [`CITATION.cff`](CITATION.cff). BibTeX (the tool's Zenodo DOI gets added on the first release tag):

```bibtex
@software{kim2026blindspotcheck,
  author  = {Kim, W.},
  title   = {{BlindSpotCheck: IEC 62443 multi-tenant monitoring blind-spot evaluator}},
  year    = {2026},
  url     = {https://github.com/whosdaniel/iec62443-multitenant-blindspot-check}
}

@article{kim2026compliant,
  author  = {Kim, W.},
  title   = {{Compliant Yet Blind: Measuring and Closing Multi-Tenant Monitoring Gaps in IEC 62443}},
  year    = {2026},
  note    = {Submitted to IJCIP}
}
```

The companion testbed for paper §5 is archived at [10.5281/zenodo.19627489](https://doi.org/10.5281/zenodo.19627489). That's the v1.1.0 version DOI the paper cites. The concept DOI `10.5281/zenodo.19617578` resolves to the latest testbed version if you need a version-agnostic pointer.

## Licence

MIT. See [`LICENSE`](LICENSE).
