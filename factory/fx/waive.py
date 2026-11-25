"""Owner waivers: a check that cannot run here (no browser, no key) is waived in the owner's own words, and finish says so.
ponytail: no identity is checked, any caller can record a waiver; the quote is what an auditor reads. The upgrade is a signed owner token."""
from __future__ import annotations

from pathlib import Path

from fx import state

KINDS = ("verdict", "livecheck", "criterion")
MIN_QUOTE_CHARS = 12


def is_waived(job: dict, kind: str, name: str) -> bool:
    return any(item["kind"] == kind and item["name"] == name for item in job.get("waivers", []))


def criteria(job: dict) -> set[str]:
    """The plan ids the owner waived: criteria that cannot be verified here."""
    return {item["name"] for item in job.get("waivers", []) if item["kind"] == "criterion"}


def add(project: Path, job_id: str, kind: str, name: str, owner_said: str, reason: str, config: dict) -> dict:
    if len(owner_said.strip()) < MIN_QUOTE_CHARS:
        raise state.StateError("a waiver needs the owner's own words: --owner-said \"<what the owner wrote>\"")
    if not reason.strip():
        raise state.StateError("a waiver needs a reason: --reason \"<why the check cannot run>\"")
    name = "live" if kind == "livecheck" else name  # one live check per job: any name given means that one
    entry = {"kind": kind, "name": name, "owner_said": owner_said.strip(), "reason": reason.strip(), "at": state.now()}

    def change(job: dict) -> None:
        if kind == "verdict" and name not in job["reviewers"]:
            raise state.StateError(f"{name} is not a reviewer of this job: {', '.join(job['reviewers'])}")
        if kind == "criterion" and name not in [item for item in state.plan_ids(project, job_id) if item.startswith("R")]:
            raise state.StateError(f"{name} is not an R line of plan.md: name the requirement that cannot be verified here, e.g. R3 (a must-not-happen M line is never waived)")
        if kind == "livecheck" and not (config.get("live_check") or {}).get("command", "").strip():
            raise state.StateError("no live check is configured, so there is nothing to waive")
        job.setdefault("waivers", []).append(entry)

    state.update(project, job_id, change)
    return entry


def lines(job: dict) -> list[str]:
    """What finish prints under DONE, so a waived check is never mistaken for a passed one."""
    return [f"- WAIVED {item['kind']} {item['name']}: {item['reason']} (owner said: \"{item['owner_said']}\")" for item in job.get("waivers", [])]
