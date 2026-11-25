"""Job state: one job.json per job, changed only through this module, with legal stage moves only."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fx.git import STATE_DIR

# Stages only the scripts enter: `gate` moves to gate/review and `finish` to done, so the chair's `move` cannot skip a check.
RESERVED = {"gate", "review", "done"}
ASKED_FOR_CHANGES = "asked for changes"  # the end of the history note a CHANGES verdict leaves; the dashboard counts it
JOB_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
TRANSITIONS = {
    "intake": {"plan", "build", "needs-info", "rejected"},
    "needs-info": {"intake", "rejected"},
    "plan": {"build", "needs-human", "rejected"},
    "build": {"gate", "needs-human"},
    "gate": {"build", "review", "needs-human"},
    "review": {"build", "done", "needs-human"},
    "needs-human": {"build", "rejected"},
    "done": set(),
    "rejected": set(),
}


class StateError(ValueError):
    """A request the state machine refuses: bad id, unknown job, illegal move."""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def job_dir(project: Path, job_id: str) -> Path:
    if not JOB_ID.fullmatch(job_id):
        raise StateError(f"job id must match {JOB_ID.pattern}: {job_id!r}")
    return project / STATE_DIR / "jobs" / job_id


PLAN_LINE = re.compile(r"^\s*[-*]\s*([RM]\d+):(.*)$", re.MULTILINE)  # the one definition of a plan line: its id, then its text


def plan_lines(project: Path, job_id: str) -> list[tuple[str, str]]:
    """(id, text) for each R<n> and M<n> line plan.md lists, in order."""
    plan = job_dir(project, job_id) / "plan.md"
    return PLAN_LINE.findall(plan.read_text(encoding="utf-8")) if plan.is_file() else []


def plan_ids(project: Path, job_id: str) -> list[str]:
    """The R<n> and M<n> ids plan.md lists, in order."""
    return [name for name, _ in plan_lines(project, job_id)]


def load(project: Path, job_id: str) -> dict:
    path = job_dir(project, job_id) / "job.json"
    if not path.is_file():
        raise StateError(f"no job {job_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def record_source(job: dict, source: bytes) -> None:
    """The owner's own words, byte for byte (a CRLF stays): R lines quote them and finish checks the quotes. The file is written after job.json, so a crash leaves a hash with no file (finish says so), never a file nobody knows.
    ponytail: the hash is taken here, so what the chair passes counts as the owner's words (the skill forbids a summary), and job.json can be edited with source.md like every other record."""
    job["source_sha256"] = hashlib.sha256(source).hexdigest()


def add_source(project: Path, job_id: str, source: bytes) -> dict:
    """For a job made without one, before the build starts."""
    def change(job: dict) -> None:
        if "source_sha256" in job:
            raise StateError(f"job {job_id} already has a source")
        if job["stage"] not in ("intake", "plan"):
            raise StateError(f"job {job_id} is in {job['stage']}: a source is kept before the build starts")
        record_source(job, source)
    job = update(project, job_id, change)
    (job_dir(project, job_id) / "source.md").write_bytes(source)
    return job


def create(project: Path, job_id: str, task_text: str, base: str, route: dict, source: bytes | None = None) -> dict:
    folder = job_dir(project, job_id)
    with locked(project, job_id, create=True):
        if (folder / "job.json").exists():
            raise StateError(f"job {job_id} already exists")
        (folder / "task.md").write_text(task_text, encoding="utf-8")
        job = {"id": job_id, "stage": "intake", "base": base, "created": now(), "history": [],
               "risk": route["risk"], "surfaces": route["surfaces"], "owner_class": route["owner"],
               "plan": route["plan"], "reviewers": route["reviewers"], "skipped": route["skipped"],
               "gates": [], "verdicts": {}, "deps": {}, "lives": [], "waivers": []}
        if source is not None:
            record_source(job, source)
        _write(folder / "job.json", job)
        if source is not None:
            (folder / "source.md").write_bytes(source)
        return job


@contextmanager
def locked(project: Path, job_id: str, create: bool = False):
    """One writer at a time: the lock is held from the read to the write. Only `create` may make the folder."""
    folder = job_dir(project, job_id)
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    elif not folder.is_dir():
        raise StateError(f"no job {job_id}")
    # ponytail: fcntl is POSIX only; the upgrade for Windows is msvcrt.locking
    with (folder / "job.lock").open("w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def update(project: Path, job_id: str, change) -> dict:
    """Read, apply `change(job)`, write atomically. `change` may call `move_in_place`."""
    with locked(project, job_id):
        job = load(project, job_id)
        change(job)
        _write(job_dir(project, job_id) / "job.json", job)
        return job


def move_in_place(job: dict, stage: str, note: str = "") -> None:
    if stage not in TRANSITIONS:
        raise StateError(f"unknown stage {stage!r}")
    if stage not in TRANSITIONS[job["stage"]]:
        raise StateError(f"illegal move {job['stage']} -> {stage}")
    job["history"].append({"from": job["stage"], "to": stage, "at": now(), "note": note})
    job["stage"] = stage


def move(project: Path, job_id: str, stage: str, note: str = "", record: dict | None = None) -> dict:
    """`record` is written in the same update as the stage change, so a crash cannot leave one without the other."""
    def change(job: dict) -> None:
        move_in_place(job, stage, note)
        job.update(record or {})
    return update(project, job_id, change)


def list_jobs(project: Path) -> list[dict]:
    root = project / STATE_DIR / "jobs"
    paths = sorted(root.glob("*/job.json")) if root.is_dir() else []
    return [json.loads(path.read_text(encoding="utf-8")) for path in paths]


def _write(path: Path, job: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".job-")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(job, handle, indent=2, sort_keys=True)
    os.replace(tmp, path)
