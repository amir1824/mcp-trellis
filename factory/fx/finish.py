"""The final gate: every claim the job makes is checked against the code as it is now. DONE or NOT DONE, with reasons."""
from __future__ import annotations

import fnmatch
import hashlib
import re
from pathlib import Path

from fx import deps, live, state, waive
from fx.git import changed_files, fingerprint

ACCEPTED = ("ok", "accepted")


def evaluate(project: Path, job_id: str, config: dict) -> list[str]:
    job = state.load(project, job_id)
    if job["stage"] != "review":
        return [f"the job is in {job['stage']}, not review"]
    now = fingerprint(project)
    return (_gate_reasons(project, job, now) + _verdict_reasons(project, job, now, config)
            + live.live_reasons(project, job, config, now)
            + _plan_reasons(project, job, config) + _dependency_reasons(project, job))


def finish(project: Path, job_id: str, config: dict) -> list[str]:
    reasons = evaluate(project, job_id, config)
    if not reasons:
        state.move(project, job_id, "done", "finish")
    return reasons


def _gate_reasons(project: Path, job: dict, now: str) -> list[str]:
    if not job["gates"]:
        return ["the gate has not run"]
    last = job["gates"][-1]
    output = state.job_dir(project, job["id"]) / last["output"]
    if not last["green"]:
        return [f"the last gate round was red: {last['note']}"]
    if last["fingerprint"] != now:
        return ["the last gate run is stale: the code changed after it"]
    if not output.is_file() or hashlib.sha256(output.read_bytes()).hexdigest() != last["output_sha256"]:
        return ["the last gate output no longer matches its record"]
    return []


def _verdict_reasons(project: Path, job: dict, now: str, config: dict) -> list[str]:
    reasons = []
    for name in job["reviewers"]:
        verdict = job["verdicts"].get(name)
        if waive.is_waived(job, "verdict", name):
            continue
        if verdict is None:
            reasons.append(f"{name} has not given a verdict")
        elif verdict["verdict"] != "PASS":
            reasons.append(f"{name} asked for changes")
        elif verdict["fingerprint"] != now:
            reasons.append(f"{name}'s verdict is stale: the code changed after it")
        else:
            reasons += _evidence_reasons(project, name, verdict, config)
    return reasons


def _evidence_reasons(project: Path, name: str, verdict: dict, config: dict) -> list[str]:
    """A reviewer that must show what it ran (a browser check) cannot pass on its word alone."""
    if name not in config.get("evidence_required", []):
        return []
    evidence = verdict.get("evidence")
    if not evidence:
        return [f"{name}'s PASS has no evidence file"]
    path = project / evidence["path"]
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != evidence["sha256"]:
        return [f"{name}'s evidence file is missing or changed"]
    return []


def _plan_reasons(project: Path, job: dict, config: dict) -> list[str]:
    if not job["plan"]:
        return []
    ids = state.plan_ids(project, job["id"])
    requirements = [name for name in ids if name.startswith("R")]
    musts = [name for name in ids if name.startswith("M")]
    reasons = [] if requirements else ["plan.md lists no R<n> requirement"]
    if (job["risk"] == "high" or "security" in job["surfaces"]) and not musts:
        reasons.append("plan.md lists no M<n> must-not-happen line, and this job needs one")
    tests = [project / path for path in changed_files(project, job["base"]) if _is_test(path, config["test_paths"])]
    text = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in tests if path.is_file())
    # ponytail: an id counts when a changed test file mentions it anywhere, a comment included; the upgrade is to
    # require it in a test's name
    waived = waive.criteria(job)
    missing = [name for name in ids if name not in waived and not re.search(r"(?<![A-Za-z0-9])" + name + r"(?![A-Za-z0-9])", text, re.IGNORECASE)]
    return reasons + _source_reasons(project, job) + ([f"no changed test mentions: {', '.join(missing)}"] if missing else [])


SOURCE_OPEN = re.compile(r"\[source:\s*[\"“]")
SOURCE_CLOSE = re.compile(r"[\"”]\s*\]")
MIN_QUOTE = 8


def _squash(text: str) -> str:
    return " ".join(text.split()).casefold()


def _quotes(rest: str) -> tuple[list[str], bool]:
    """The quotes of one R line, and whether a `[source:` on it could not be read. A quote ends at the first closing mark that is followed by `]`, so it may hold quotation marks
    (a sentence with `{"error": ...}` in it); the scan is linear and stops at the first unreadable one."""
    quotes, position = [], 0
    while (start := rest.find("[source:", position)) >= 0:
        opened = SOURCE_OPEN.match(rest, start)
        closed = SOURCE_CLOSE.search(rest, opened.end()) if opened else None
        if not closed:
            return quotes, True
        quotes.append(rest[opened.end():closed.start()])
        position = closed.end()
    return quotes, False


def _source_reasons(project: Path, job: dict) -> list[str]:
    """With a kept source, each R line quotes the owner's words on the same line, `[source: "..."]`, and the quote must be in source.md.
    ponytail: this shows a requirement has words behind it, not that the words say what the R line says, and not that a requirement of the source has an R line; the plan review reads both."""
    recorded = job.get("source_sha256")
    if not recorded:
        return []
    folder = state.job_dir(project, job["id"])
    source = folder / "source.md"
    if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != recorded:
        return ["source.md is missing or changed after intake"]
    text = _squash(source.read_text(encoding="utf-8"))
    waived, reasons = waive.criteria(job), []
    for name, rest in state.plan_lines(project, job["id"]):
        if not name.startswith("R") or name in waived:
            continue
        quotes, broken = _quotes(rest)
        bad = [quote for quote in quotes if len(_squash(quote)) < MIN_QUOTE or _squash(quote) not in text]
        if broken:
            reasons.append(f'{name} has a [source: ...] that could not be read: write [source: "the owner\'s words"] on the R line, the closing quote right before the ]')
        elif not quotes:
            reasons.append(f'{name} has no [source: "..."] quote on the R line itself (a quote on the next line is not read)')
        elif bad:
            reasons.append(f'{name}\'s quote is not in source.md, or shorter than {MIN_QUOTE} characters: "{bad[0][:60]}"')
    return reasons


def plan_digest(project: Path, job_id: str) -> str:
    """The hash of plan.md, or "" when it does not exist."""
    plan = state.job_dir(project, job_id) / "plan.md"
    return hashlib.sha256(plan.read_bytes()).hexdigest() if plan.is_file() else ""


def plan_changed_lines(project: Path, job: dict) -> list[str]:
    """What finish prints under DONE when plan.md was written or edited after the move to build, so a plan fitted to the code is seen."""
    recorded = job.get("plan_sha256")
    return ["- PLAN CHANGED after the move to build (the owner approved the earlier text)"] if recorded is not None and plan_digest(project, job["id"]) != recorded else []


def verdict_notes(job: dict) -> list[str]:
    """What finish prints under DONE about who a PASS came from, so a review that only the chair ran, or that nothing shows read this code, is not read as an independent one.
    ponytail: `--saw` is what the chair passes; it shows the reviewer was briefed on this code, not that it read it."""
    notes = []
    for name in job["reviewers"]:
        entry = job["verdicts"].get(name) or {}
        if waive.is_waived(job, "verdict", name):
            continue
        if entry.get("self"):
            notes.append(f"- SELF {name}: run by the chair on its own work, not an independent review")
        elif not entry.get("saw"):
            notes.append(f"- UNSEEN {name}: recorded without --saw, so nothing shows the reviewer was briefed on this code")
    return notes


def _is_test(path: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, glob) or fnmatch.fnmatch(Path(path).name, glob) for glob in globs)


def _dependency_reasons(project: Path, job: dict) -> list[str]:
    reasons = []
    for key, spec in deps.added_dependencies(project, job["base"]).items():
        record = job["deps"].get(key)
        if record is None:
            reasons.append(f"new dependency {key} ({spec}) has no recorded check")
        elif record["status"] not in ACCEPTED:
            reasons.append(f"dependency {key} is {record['status']}: {record['note']}")
        elif record["spec"] != spec:
            reasons.append(f"dependency {key} changed from {record['spec']} to {spec} after its check")
    return reasons
