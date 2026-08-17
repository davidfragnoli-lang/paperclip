#!/usr/bin/env python3
"""Normalize and audit Git HEAD-reflog action spellings for the watchdog."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


CONVERGENCE_ALLOWLIST = (
    "reset",
    "cherry-pick",
    "merge",
    "checkout",
    "branch",
    "commit",
)

# These actions can move HEAD, but they are not automatic serving-tree promotion
# origins. Keeping the reason next to the grammar makes exclusions reviewable.
DELIBERATE_EXCLUSIONS = {
    "": "malformed or empty reflog subject; fail closed instead of restarting",
    "am": "mail-patch workflow is operator-controlled and not a promotion lane",
    "clone": "repository creation predates a serving process",
    "rebase": "rebase is operator-controlled and requires an explicit convergence decision",
}

_ACTION = re.compile(
    r"^(?P<verb>[^\s()]+)(?:\s+\((?P<qualifier>[^()]+)\)|\s+(?P<operand>.+))?$"
)


def action_spelling(subject: str) -> str:
    """Return Git's action production, excluding the colon-delimited message."""
    if ":" not in subject:
        return ""
    return subject.split(":", 1)[0].strip()


def normalize_action(action: str) -> str:
    """Map ``verb (qualifier)`` and ``verb operand`` productions to a verb.

    Git records completed cherry-picks and merges as commit-qualified actions.
    Attribute those to the operation that caused the move. Other qualifiers,
    including ``commit (amend)`` and ``rebase (finish)``, retain their outer verb.
    """
    match = _ACTION.fullmatch(action.strip())
    if not match:
        return ""
    verb = match.group("verb")
    qualifier = match.group("qualifier")
    if verb == "commit" and qualifier in {"cherry-pick", "merge"}:
        return qualifier
    return verb


def normalize_subject(subject: str) -> str:
    return normalize_action(action_spelling(subject))


def reflog_subjects(repo: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), "reflog", "--format=%gs"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git reflog failed")
    return result.stdout.splitlines()


def audit(repo: Path) -> int:
    actions = sorted({action_spelling(subject) for subject in reflog_subjects(repo)})
    normalized = {action: normalize_action(action) for action in actions}
    reachable = set(normalized.values()) & set(CONVERGENCE_ALLOWLIST)
    failures: list[str] = []

    for verb in CONVERGENCE_ALLOWLIST:
        if verb not in reachable:
            failures.append(f"unreachable allowlist verb: {verb}")

    for action, verb in normalized.items():
        if verb in CONVERGENCE_ALLOWLIST:
            status = "allow"
        elif verb in DELIBERATE_EXCLUSIONS:
            status = f"exclude: {DELIBERATE_EXCLUSIONS[verb]}"
        else:
            status = "UNCLASSIFIED"
            failures.append(
                f"unclassified reflog action: {action or '<empty>'} -> {verb or '<empty>'}"
            )
        print(f"{action or '<empty>'}\t{verb or '<empty>'}\t{status}")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print(
        "PASS reflog grammar reachability: "
        + ", ".join(CONVERGENCE_ALLOWLIST)
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    normalize_parser = subparsers.add_parser("normalize")
    normalize_parser.add_argument("subject")
    allows_parser = subparsers.add_parser("allows")
    allows_parser.add_argument("verb")
    audit_parser = subparsers.add_parser("audit")
    audit_parser.add_argument("repo", type=Path)
    args = parser.parse_args()

    if args.command == "normalize":
        print(normalize_subject(args.subject))
        return 0
    if args.command == "allows":
        return 0 if args.verb in CONVERGENCE_ALLOWLIST else 1
    return audit(args.repo)


if __name__ == "__main__":
    raise SystemExit(main())
