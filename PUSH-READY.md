# Push-ready checklist — BlindSpotCheck v0.1.0

**Status:** built, tested, security-scanned, SSI-swept. Ready for Danny's review and GitHub/Zenodo publication.

**Repo path:** `/Users/dannykim/Desktop/projects_macbook/unity_mcp/iec62443-multitenant-blindspot-check/`

This file is for Danny only — delete it before the first public push or keep it out of the tree via `.gitignore` (it is NOT currently ignored — remove manually).

---

## What you have locally

- Clean git repo on branch `main` with a single initial commit.
- Python package (`pip install -e ".[dev]"`), CLI (`blindspotcheck`), 3 example YAMLs, 25 passing tests.
- All metadata files (`LICENSE`, `README.md`, `CITATION.cff`, `.zenodo.json`, `CHANGELOG.md`, `pyproject.toml`, `.gitignore`).
- GitHub Actions CI workflow at `.github/workflows/test.yml` (SHA-pinned actions).

---

## Local verification you can re-run any time

```bash
cd /Users/dannykim/Desktop/projects_macbook/unity_mcp/iec62443-multitenant-blindspot-check
.venv/bin/pytest -v                                                    # 25 tests
.venv/bin/bandit -r blindspotcheck -ll                                 # no issues
.venv/bin/pip-audit                                                    # no CVEs
.venv/bin/blindspotcheck examples/airport-common-use-terminal.yaml     # reproduces Table 2
```

---

## Step 1 — Review the commit

```bash
cd /Users/dannykim/Desktop/projects_macbook/unity_mcp/iec62443-multitenant-blindspot-check
git log --stat -1
git show HEAD
```

Inspect `README.md`, `examples/*.yaml`, `blindspotcheck/evaluator.py` before you push anything public.

---

## Step 2 — Create the GitHub repo

1. Go to https://github.com/new
2. Owner: your GitHub user (the same one that holds `iec62443-multitenant-testbed`)
3. Repository name: **`iec62443-multitenant-blindspot-check`**
4. Description (copy-paste): *"IEC 62443 NC-1/NC-2/NC-3 multi-tenant monitoring blind-spot evaluator. Companion tool to Kim (2026) 'Compliant Yet Blind'."*
5. Public
6. **Do NOT** initialise with README, .gitignore, or license (we already have them).
7. Create.

GitHub will show you the remote URL, e.g. `https://github.com/<user>/iec62443-multitenant-blindspot-check.git`.

---

## Step 3 — Push

```bash
cd /Users/dannykim/Desktop/projects_macbook/unity_mcp/iec62443-multitenant-blindspot-check

# Replace <user> with your GitHub username
git remote add origin https://github.com/<user>/iec62443-multitenant-blindspot-check.git
git push -u origin main
```

CI will run on push. Verify the `test` and `security` workflows go green before tagging.

---

## Step 4 — Enable Zenodo GitHub integration (same flow as testbed repo)

1. Go to https://zenodo.org/account/settings/github/.
2. Log in with GitHub (if not already).
3. Find `<user>/iec62443-multitenant-blindspot-check` in the repository list.
4. Flip the toggle to **ON**.

Zenodo now watches this repo. The next GitHub release creates a DOI.

---

## Step 5 — Tag v0.1.0 and create the release

```bash
# Still inside the repo directory
git tag -a v0.1.0 -m "BlindSpotCheck v0.1.0 — initial release"
git push origin v0.1.0
```

Then on GitHub:
1. Releases → Draft a new release.
2. Choose tag `v0.1.0`.
3. Title: `BlindSpotCheck v0.1.0`
4. Release notes: copy the `[0.1.0]` block from `CHANGELOG.md`.
5. Publish release.

Zenodo will pick up the release within a few minutes and mint:
- A **concept DOI** (stable across versions): `10.5281/zenodo.XXXXX`
- A **version DOI** for v0.1.0: `10.5281/zenodo.YYYYY`

You want the **concept DOI** for the paper footnote (always points to the latest version).

---

## Step 6 — Update paper references

Once you have the concept DOI, three places need updating. Do them together in one main.tex edit once the DOI is known:

### 6a. `paper/ijcip/main.tex` §8.3 footnote (currently footnote 7, line ~934)

**Before:**
```
\footnote{The open-source repository URL will be added here upon public release
of the BlindSpotCheck prototype; a separate tool paper is planned.}
```

**After:**
```
\footnote{BlindSpotCheck is available as an open-source package at
\url{https://github.com/<user>/iec62443-multitenant-blindspot-check}
(archived at \url{https://doi.org/10.5281/zenodo.XXXXX}); a separate tool
paper is planned.}
```

### 6b. `paper/ijcip/korean/08-discussion.md`

Mirror the same change in the Korean §8.3 Deliverable 2 (BlindSpotCheck) footnote area.

### 6c. `paper/ijcip/korean/html/08-discussion.html`

Regenerate via `bash paper/ijcip/korean/convert-to-html.sh` after the MD update. (You'll be doing a bulk regen at the apply-all-rounds stage anyway.)

### 6d. README.md of this repo

Replace `10.5281/zenodo.XXXXX` placeholders with the actual concept DOI. Same in `CITATION.cff`.

---

## Step 7 — Add the HTML comment (Danny-approved workflow)

Per our agreement, I (Claude Code) will not touch `paper/ijcip/korean/html/08-discussion.html` until you say so. When the DOI is live and you're ready:

1. Tell me the concept DOI (and GitHub username if not `wwkim`).
2. I'll add a highlight + `Claude Code` comment on the §8.3 BlindSpotCheck passage in `korean/html/08-discussion.html` describing the change, in **open** state (not resolved) so you can review and approve.
3. I'll also append an R?-A? entry to `paper/ijcip/review-log.md` matching the exact wording change from Step 6a.
4. Once you resolve in annot tool, the loop closes.

---

## Step 8 — Optional: PyPI publish

`pyproject.toml` is already PyPI-ready. If you want `pip install blindspotcheck` to work:

```bash
.venv/bin/pip install build twine
.venv/bin/python -m build
.venv/bin/twine upload dist/*
```

Skip if you only want GitHub + Zenodo. PyPI adds one more trust-chain link.

---

## Things I deliberately did NOT do

- Did not touch `paper/ijcip/korean/html/08-discussion.html` (you asked me to wait).
- Did not push anything to any remote (GitHub credentials are yours).
- Did not create Zenodo DOI (you drive the integration).
- Did not update `paper/ijcip/main.tex` §8.3 footnote (awaits DOI).
- Did not modify `paper/ijcip/review-log.md` to log this work (awaits DOI so I can fill in the actual change).

All other artefacts are ready. Review `README.md` and the three example YAMLs; everything else is generated/supporting material.

---

## Handoff summary

**Path to repo:** `/Users/dannykim/Desktop/projects_macbook/unity_mcp/iec62443-multitenant-blindspot-check/`

**What's inside:**
- `blindspotcheck/` — Python package (5 modules + JSON schema).
- `tests/` — 25 pytest tests (core logic, schema, security, sample regression).
- `examples/` — 3 framework-derived YAMLs (airport/rail/maritime).
- `docs/` — design + yaml-schema reference.
- `.github/workflows/test.yml` — SHA-pinned CI (pytest + bandit + pip-audit).
- `README.md`, `LICENSE`, `CITATION.cff`, `.zenodo.json`, `CHANGELOG.md`, `pyproject.toml`, `.gitignore`.
- `PUSH-READY.md` — this file.

**What passed:**
- 25/25 pytest
- bandit — 0 issues
- pip-audit — 0 CVEs (after pinning pytest≥9.0.3)
- SSI sweep — 0 real IP / vendor / airline / airport code matches
- Airport sample reproduces paper Table 2 exactly (3 blind-spot + 2 borderline + 5 resolved-by-SP + 7 no-cross-AO)

**Your next move:** follow Steps 1-5 above. Ping me with the resulting concept DOI and I'll finish the paper-side integration (Step 6 + Step 7).
