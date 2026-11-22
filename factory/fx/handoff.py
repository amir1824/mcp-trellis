"""The handoff: what a fresh session needs to carry a job on from review, written by a script from the job's own record.
The expensive context of the build stays behind; the facts that matter are on disk and short."""
from __future__ import annotations

from pathlib import Path

from fx import live, state, waive
from fx.git import changed_files, fingerprint

PLAN_LINES = 150
FILE_LINES = 60


def render(project: Path, job: dict, config: dict) -> str:
    job_id, folder = job["id"], state.job_dir(project, job["id"])
    now = fingerprint(project)
    plan = folder / "plan.md"
    plan_lines = plan.read_text(encoding="utf-8").splitlines() if plan.is_file() else []
    plan_text = ("\n".join(plan_lines[:PLAN_LINES]) + (f"\n... {len(plan_lines) - PLAN_LINES} more lines in plan.md" if len(plan_lines) > PLAN_LINES else "")
                 if plan_lines else ("(plan.md is missing: this job needs one)" if job["plan"] else "(no plan: a LOW job)"))
    changed = changed_files(project, job["base"])
    parts = [f"# Handoff for job {job_id}", f"stage={job['stage']} risk={job['risk']} reviewers={','.join(job['reviewers']) or 'none'} base={job['base'][:12]}",
             f"task: .factory/jobs/{job_id}/task.md (read it for the ticket's own words)", "", "## Plan", plan_text, "",
             f"## Changed files ({len(changed)})", *changed[:FILE_LINES], *([f"... and {len(changed) - FILE_LINES} more"] if len(changed) > FILE_LINES else []), "",
             "## Where it stands", *_standing(project, job, config, now), "", "## Next, in order", *_next(project, job, config, now)]
    return "\n".join(parts) + "\n"


def write(project: Path, job_id: str, config: dict) -> Path:
    job = state.load(project, job_id)
    target = state.job_dir(project, job_id) / "handoff.md"
    target.write_text(render(project, job, config), encoding="utf-8")
    return target


def _standing(project: Path, job: dict, config: dict, now: str) -> list[str]:
    gate = job["gates"][-1] if job["gates"] else None
    lines = [f"gate: round {gate['round']} {'PASS' if gate['green'] else 'FAIL'}{'' if gate['fingerprint'] == now else ' (stale: the code changed after it)'}" if gate else "gate: not run"]
    if live.enabled(config):
        lines.append(_live_line(project, job, now))
    lines += [f"{name}: {_verdict_line(job, name, now)}" for name in job["reviewers"]]
    lines += [f"- WAIVED {item['kind']} {item['name']}: {item['reason']}" for item in job.get("waivers", [])]
    lines += [line.lstrip("- ") for line in live.relock_lines(job)]
    return lines


def _live_line(project: Path, job: dict, now: str) -> str:
    if waive.is_waived(job, "livecheck", "live"):
        return "live check: waived by the owner"
    lives = job.get("lives", [])
    if not lives:
        return "live check: not run"
    last = lives[-1]
    head = f"live check: run {last['number']}: {last['cases'][0]}/{last['cases'][1]} {'PASS' if last['green'] else 'FAIL'}{'' if last['fingerprint'] == now else ' (stale)'}"
    output = state.job_dir(project, job["id"]) / last["output"]
    shown = live.failing_lines(output.read_text(encoding="utf-8", errors="replace")) if not last["green"] and output.is_file() else []
    return "\n".join([head + (f": {last['note']}" if last["note"] else "")] + shown)


def _verdict_line(job: dict, name: str, now: str) -> str:
    verdict = job["verdicts"].get(name)
    if waive.is_waived(job, "verdict", name):
        return "waived by the owner"
    return "no verdict yet" if verdict is None else verdict["verdict"] + ("" if verdict["fingerprint"] == now else " (stale)")


def _next(project: Path, job: dict, config: dict, now: str) -> list[str]:
    if job["stage"] in ("done", "rejected", "needs-human", "intake", "needs-info", "plan"):
        return [f"the job is in {job['stage']}: nothing to carry on from review"]
    steps = []
    if job["stage"] == "build":
        steps.append(f"FX gate {job['id']}  (the gate has to be green before anything else)")
    if live.enabled(config) and live.live_reasons(project, job, config, now):
        steps.append(f"FX livecheck {job['id']}  (fix what a failing CASE line names, FX gate, run it again; reviewers only after it is green)")
    waiting = [name for name in job["reviewers"] if not waive.is_waived(job, "verdict", name)
               and (job["verdicts"].get(name) is None or job["verdicts"][name]["verdict"] != "PASS" or job["verdicts"][name]["fingerprint"] != now)]
    steps += [f"call {name} with the diff, the plan and the ids; record FX verdict {job['id']} {name} PASS|CHANGES" for name in waiting]
    return steps + [f"FX finish {job['id']}  (it must print DONE)"]
