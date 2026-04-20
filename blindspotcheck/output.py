"""Output formatters: text table, JSON, Markdown."""

from __future__ import annotations

import json

from .evaluator import ArchitectureReport, NCResult, Verdict


# Unicode-free ASCII tick/cross so this renders everywhere.
_TICK = "Y"
_CROSS = "-"


def _nc(flag: bool) -> str:
    return _TICK if flag else _CROSS


def format_text(report: ArchitectureReport, *, width: int = 100) -> str:
    """Render a fixed-width text table summary."""
    lines: list[str] = []
    header = f"Domain: {report.domain}"
    if report.source_standards:
        header += f"  |  Source: {'; '.join(report.source_standards)}"
    lines.append(header)
    lines.append("")
    lines.append(f"{'Conduit':<16}{'SC-1':<6}{'NC-1':<6}{'NC-2':<6}{'Verdict':<18}Rationale")
    lines.append("-" * min(width, 96))
    for r in report.results:
        lines.append(
            f"{r.conduit_id:<16}"
            f"{_nc(r.sc1):<6}{_nc(r.nc1):<6}{_nc(r.nc2):<6}"
            f"{r.verdict.value:<18}{r.rationale}"
        )
    lines.append("-" * min(width, 96))

    dist = report.distribution()
    total = len(report.results)
    bs = dist[Verdict.BLIND_SPOT.value]
    pct = (bs / total * 100) if total else 0.0
    lines.append(
        f"Total: {total}  |  "
        f"blind-spot {bs} ({pct:.1f}%)  "
        f"borderline {dist[Verdict.BORDERLINE.value]}  "
        f"resolved-by-sp {dist[Verdict.RESOLVED_BY_SP.value]}  "
        f"no-cross-ao {dist[Verdict.NO_CROSS_AO.value]}"
    )
    if report.blind_spots():
        lines.append("")
        lines.append("Blind spots:")
        for r in report.blind_spots():
            lines.append(f"  - {r.conduit_id}: {r.rationale}")
            for m in r.mitigation:
                lines.append(f"      mitigation: {m}")
    return "\n".join(lines) + "\n"


def format_json(report: ArchitectureReport, *, indent: int = 2) -> str:
    payload = {
        "domain": report.domain,
        "source_standards": list(report.source_standards),
        "distribution": report.distribution(),
        "conduits": [r.as_row() for r in report.results],
    }
    return json.dumps(payload, indent=indent, ensure_ascii=False, sort_keys=False) + "\n"


def format_markdown(report: ArchitectureReport) -> str:
    """Markdown table suitable for inclusion in a paper/report."""
    lines: list[str] = []
    lines.append(f"# BlindSpotCheck report --- `{report.domain}`")
    lines.append("")
    if report.source_standards:
        lines.append(
            "**Source standards:** " + ", ".join(f"`{s}`" for s in report.source_standards)
        )
        lines.append("")
    lines.append("| Conduit | SC-1 | NC-1 | NC-2 | Verdict | Rationale |")
    lines.append("|---------|------|------|------|---------|-----------|")
    for r in report.results:
        lines.append(
            f"| `{r.conduit_id}` | {_nc(r.sc1)} | {_nc(r.nc1)} | {_nc(r.nc2)} "
            f"| **{r.verdict.value}** | {_md_escape(r.rationale)} |"
        )
    lines.append("")

    dist = report.distribution()
    total = len(report.results)
    bs = dist[Verdict.BLIND_SPOT.value]
    pct = (bs / total * 100) if total else 0.0
    lines.append("## Distribution")
    lines.append("")
    lines.append(f"- Total conduits: **{total}**")
    lines.append(f"- Blind spots: **{bs}** ({pct:.1f}%)")
    lines.append(f"- Borderline: {dist[Verdict.BORDERLINE.value]}")
    lines.append(f"- Resolved by SP relationship: {dist[Verdict.RESOLVED_BY_SP.value]}")
    lines.append(f"- No cross-AO split: {dist[Verdict.NO_CROSS_AO.value]}")
    lines.append("")

    if report.blind_spots():
        lines.append("## Blind spots --- mitigation options")
        lines.append("")
        for r in report.blind_spots():
            lines.append(f"### `{r.conduit_id}`")
            lines.append("")
            lines.append(r.rationale)
            lines.append("")
            for m in r.mitigation:
                lines.append(f"- {m}")
            lines.append("")
    return "\n".join(lines) + "\n"


def _md_escape(text: str) -> str:
    """Escape pipe and newline so Markdown table cells don't break."""
    return text.replace("|", "\\|").replace("\n", " ")
