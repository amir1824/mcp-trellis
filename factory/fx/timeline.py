"""Time per stage from a job's history, so the breakdown never has to be rebuilt by hand."""
from __future__ import annotations

from datetime import datetime, timezone

FORMAT = "%Y-%m-%dT%H:%M:%SZ"
CLOSED = ("done", "rejected")


def _at(stamp: str) -> datetime:
    return datetime.strptime(stamp, FORMAT).replace(tzinfo=timezone.utc)


def stage_seconds(job: dict, now: datetime | None = None) -> dict[str, list[int]]:
    """{stage: [visits, seconds]} in first-seen order. A job still open counts its current stage up to `now`."""
    marks = [job["created"]] + [entry["at"] for entry in job["history"]]
    stages = [entry["from"] for entry in job["history"]]
    spans = [(stage, (_at(end) - _at(start)).total_seconds()) for stage, start, end in zip(stages, marks, marks[1:])]
    spans += [] if job["stage"] in CLOSED else [(job["stage"], ((now or datetime.now(timezone.utc)) - _at(marks[-1])).total_seconds())]
    total: dict[str, list[int]] = {}
    for stage, seconds in spans:
        visits, spent = total.get(stage, [0, 0])
        total[stage] = [visits + 1, spent + int(seconds)]
    return total


def render(job: dict, now: datetime | None = None) -> str:
    table = stage_seconds(job, now)
    rows = [f"{stage}\t{visits} visit(s)\t{seconds}s" for stage, (visits, seconds) in table.items()]
    return "\n".join(rows + [f"total\t\t{sum(seconds for _, seconds in table.values())}s"])
