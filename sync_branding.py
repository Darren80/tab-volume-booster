#!/usr/bin/env python3
"""Sync all user-facing "max volume %" branding to the code's single source of truth.

The real ceiling lives in ONE place: SETTINGS.volume.maxPercent in content.js.
Everything else that quotes a number to the user (the store description, the
popup tagline, the slider's initial max, the README, the JS fallback) should
agree with it. This script reads that number and rewrites the others, so you
never again ship "up to 600%" while the slider actually goes to 1200.

Usage:
    python3 sync_branding.py          # apply changes
    python3 sync_branding.py --check  # report drift, change nothing (exit 1 if any)

To change the ceiling: edit maxPercent in content.js, then run this. Done.
This file is a dev tool and is excluded from the published add-on (.web-ext-ignore).
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read_max_percent() -> int:
    """The single source of truth: SETTINGS.volume.maxPercent in content.js."""
    text = (ROOT / "content.js").read_text(encoding="utf-8")
    m = re.search(r"maxPercent:\s*(\d+)", text)
    if not m:
        sys.exit("Could not find `maxPercent:` in content.js — aborting.")
    return int(m.group(1))


def fmt_x(percent: int) -> str:
    """Human 'loudness' multiplier, e.g. 1200 -> '12x', 650 -> '6.5x'."""
    x = percent / 100
    return f"{x:g}x"


def build_rules(mx: int):
    """(file, pattern, replacement) edits. Each pattern is anchored to a specific
    branding phrase so we only ever touch the number we mean to."""
    x = fmt_x(mx)
    return [
        # Store description (manifest is what AMO reads).
        ("manifest.json", r"up to \d+%", f"up to {mx}%"),
        # Popup tagline ("Boost any tab up to 600&thinsp;%").
        ("popup/popup.html", r"up to \d+&thinsp;%", f"up to {mx}&thinsp;%"),
        # Popup slider's initial max attribute (runtime overrides it, but keep it honest).
        ("popup/popup.html", r'(id="volume"[^>]*?\bmax=")\d+(")',
         lambda m: f"{m.group(1)}{mx}{m.group(2)}"),
        # Popup slider's initial max end-label.
        ("popup/popup.html", r'(<span id="sliderMax">)\d+( %</span>)',
         lambda m: f"{m.group(1)}{mx}{m.group(2)}"),
        # JS fallback ceiling (only used if get-state fails).
        ("popup/popup.js", r"let MAX = \d+;", f"let MAX = {mx};"),
        # README prose: "0–600 %" (en dash), both occurrences.
        ("README.md", r"0–\d+ %", f"0–{mx} %"),
        # README graph note: "0–600 % volume".
        # (covered by the rule above; the em-dash range is identical)
        # content.js self-comment so it stops contradicting its own value.
        ("content.js", r"\(\d+ = [\d.]+x loudness\)", f"({mx} = {x} loudness)"),
    ]


def apply(check_only: bool) -> int:
    mx = read_max_percent()
    print(f"Source of truth: maxPercent = {mx}%  ({fmt_x(mx)} loudness)\n")
    drift = 0
    for rel, pattern, repl in build_rules(mx):
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        new, n = re.subn(pattern, repl, original)
        if n and new != original:
            drift += 1
            status = "would update" if check_only else "updated"
            print(f"  {status:>13}: {rel}  ({n} match{'es' if n > 1 else ''})")
            if not check_only:
                path.write_text(new, encoding="utf-8")
    if drift == 0:
        print("  Everything already in sync.")
    return 1 if (check_only and drift) else 0


if __name__ == "__main__":
    sys.exit(apply(check_only="--check" in sys.argv))
