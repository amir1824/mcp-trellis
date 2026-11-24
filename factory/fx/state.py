"""Job state: one job.json per job, changed only through this module, with legal stage moves only."""
from __future__ import annotations

import fcntl
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


def load(project: Path, job_id: str) -> dict:
    path = job_dir(project, job_id) / "job.json"
    if not path.is_file():
        raise StateError(f"no job {job_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def create(project: Path, job_id: str, task_text: str, base: str, route: dict) -> dict:
    folder = job_dir(project, job_id)
    with locked(project, job_id, create=True):
        if (folder / "job.json").exists():
            raise StateError(f"job {job_id} already exists")
        (folder / "task.md").write_text(task_text, encoding="utf-8")
        job = {"id": job_id, "stage": "intake", "base": base, "created": now(), "history": [],
               "risk": route["risk"], "surfaces": route["surfaces"], "owner_class": route["owner"],
               "plan": route["plan"], "reviewers": route["reviewers"], "skipped": route["skipped"],
               "gates": [], "verdicts": {}, "deps": {}, "lives": [], "waivers": []}
        _write(folder / "job.json", job)
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


def move(project: Path, job_id: str, stage: str, note: str = "") -> dict:
    return update(project, job_id, lambda job: move_in_place(job, stage, note))


def list_jobs(project: Path) -> list[dict]:
    root = project / STATE_DIR / "jobs"
    paths = sorted(root.glob("*/job.json")) if root.is_dir() else []
    return [json.loads(path.read_text(encoding="utf-8")) for path in paths]


def _write(path: Path, job: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".job-")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(job, handle, indent=2, sort_keys=True)
    os.replace(tmp, path)
