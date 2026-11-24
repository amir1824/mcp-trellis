"""The final gate: every claim the job makes is checked against the code as it is now. DONE or NOT DONE, with reasons."""
from __future__ import annotations

import fnmatch
import hashlib
import re
from pathlib import Path

from fx import deps, live, state, waive
from fx.git import changed_files, fingerprint

ID_LINE = re.compile(r"^\s*[-*]\s*([RM]\d+):", re.MULTILINE)
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
    plan = state.job_dir(project, job["id"]) / "plan.md"
    ids = ID_LINE.findall(plan.read_text(encoding="utf-8")) if plan.is_file() else []
    requirements = [name for name in ids if name.startswith("R")]
    musts = [name for name in ids if name.startswith("M")]
    reasons = [] if requirements else ["plan.md lists no R<n> requirement"]
    if (job["risk"] == "high" or "security" in job["surfaces"]) and not musts:
        reasons.append("plan.md lists no M<n> must-not-happen line, and this job needs one")
    tests = [project / path for path in changed_files(project, job["base"]) if _is_test(path, config["test_paths"])]
    text = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in tests if path.is_file())
    # ponytail: an id counts when a changed test file mentions it anywhere, a comment included; the upgrade is to
    # require it in a test's name
    missing = [name for name in ids if not re.search(r"(?<![A-Za-z0-9])" + name + r"(?![A-Za-z0-9])", text, re.IGNORECASE)]
    return reasons + ([f"no changed test mentions: {', '.join(missing)}"] if missing else [])


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
