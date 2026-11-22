"""The command line. Exit 0 = PASS, DONE or ok; 1 = FAIL or NOT DONE; 2 = a request the factory refuses."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from fx import cases, deps, finish, handoff, live, needs, state, timeline, waive
from fx.gate import protected_violations, run_gate
from fx.git import fingerprint, head
from fx.route import classify, load_config, raise_to, routing_for

RISKS = ("low", "medium", "high")
DEP_STATUS = ("ok", "accepted", "blocked")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="factory")
    parser.add_argument("-C", dest="project", default=".", help="the project folder (default: here)")
    sub = parser.add_subparsers(dest="command", required=True)
    new = sub.add_parser("new", help="create a job from a task file")
    new.add_argument("job")
    new.add_argument("task_file")
    new.add_argument("--risk", choices=RISKS, help="the owner's class; it stands")
    route = sub.add_parser("route", help="classify words without creating a job")
    route.add_argument("words", nargs="+")
    move = sub.add_parser("move", help="move a job to a legal next stage")
    move.add_argument("job")
    move.add_argument("stage")
    move.add_argument("note", nargs="*")
    up = sub.add_parser("raise", help="raise a job's class (never lowers)")
    up.add_argument("job")
    up.add_argument("risk", choices=RISKS)
    for name in ("show", "gate", "finish", "deps", "timeline"):
        sub.add_parser(name).add_argument("job")
    sub.add_parser("status", help="list the jobs")
    verdict = sub.add_parser("verdict", help="a reviewer's verdict on the code as it is now. ponytail: it names no identity, any caller can record any reviewer")
    verdict.add_argument("job")
    verdict.add_argument("reviewer")
    verdict.add_argument("verdict", choices=("PASS", "CHANGES"))
    verdict.add_argument("--evidence", help="a file under .factory/ that shows what the reviewer ran (required for the reviewers in `evidence_required`)")
    sub.add_parser("livecheck", help="run the project's live script against the real provider (config `live_check`)").add_argument("job")
    author = sub.add_parser("cases", help="the case author step: print the author's brief, or --check the file it wrote")
    author.add_argument("job")
    author.add_argument("--check", action="store_true")
    init = sub.add_parser("live-init", help="write a live script skeleton with the output format the check reads")
    init.add_argument("path", nargs="?", default="scripts/live_check.py")
    relock = sub.add_parser("livecheck-relock", help="the frozen live script was wrong: accept its edit, with the reason finish will print")
    relock.add_argument("job")
    relock.add_argument("--reason", required=True)
    sub.add_parser("handoff", help="write the job's handoff file for a fresh session and print its path").add_argument("job")
    waiver = sub.add_parser("waive", help="record the owner's waiver of a check that cannot run here")
    waiver.add_argument("job")
    waiver.add_argument("kind", choices=waive.KINDS)
    waiver.add_argument("name", nargs="?", default="live", help="the reviewer for `verdict`; ignored for `livecheck`")
    waiver.add_argument("--owner-said", required=True)
    waiver.add_argument("--reason", required=True)
    record = sub.add_parser("deps-record", help="record the check of one new dependency")
    record.add_argument("job")
    record.add_argument("key")
    record.add_argument("status", choices=DEP_STATUS)
    record.add_argument("note", nargs="+")
    return parser


def _new(project: Path, args, config: dict) -> int:
    stray = protected_violations(project, head(project), config)
    if stray:
        raise state.StateError("commit the factory first, so the job's base holds it: " + ", ".join(stray))
    text = Path(args.task_file).read_text(encoding="utf-8")
    route = classify(f"{args.risk}: {text}" if args.risk else text, config)
    state.create(project, args.job, text, head(project), route)
    print(f"CREATED {args.job} risk={route['risk']} surfaces={','.join(route['surfaces']) or 'none'} "
          f"plan={route['plan']} reviewers={','.join(route['reviewers']) or 'none'} because={route['because']}")
    print("\n".join(f"NEEDS {line}" for line in needs.lines(route, config)))
    return 0


def _raise(project: Path, args, config: dict) -> int:
    def change(job: dict) -> None:
        wanted = raise_to(job["risk"], args.risk)
        route = routing_for(wanted, job["surfaces"], job["owner_class"], config)
        job.update(risk=route["risk"], plan=route["plan"], reviewers=route["reviewers"], skipped=route["skipped"])
    job = state.update(project, args.job, change)
    print(f"RISK {job['risk']} plan={job['plan']} reviewers={','.join(job['reviewers']) or 'none'}")
    return 0


def _evidence(project: Path, path: str) -> dict:
    """The evidence file must be a non-empty file under .factory/ (outside the code's fingerprint, so saving it keeps the gate fresh)."""
    target = (project / path).resolve()
    if (project / ".factory").resolve() not in target.parents or not target.is_file() or target.stat().st_size == 0:
        raise state.StateError("--evidence must be a non-empty file under .factory/")
    return {"path": str(target.relative_to(project)), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}


def _verdict(project: Path, args, config: dict) -> int:
    evidence = _evidence(project, args.evidence) if args.evidence else None

    def change(job: dict) -> None:
        if job["stage"] != "review":
            raise state.StateError(f"verdicts are given in review, the job is in {job['stage']}")
        now = fingerprint(project)
        if now != job["gates"][-1]["fingerprint"]:
            raise state.StateError("the code changed since the gate ran: run the gate again before a verdict")
        if args.reviewer not in job["reviewers"]:
            raise state.StateError(f"{args.reviewer} is not a reviewer of this job: {', '.join(job['reviewers'])}")
        pending = live.live_reasons(project, job, config, now)
        if pending:
            raise state.StateError("the live check comes before the reviewers: " + "; ".join(pending))
        entry = {"verdict": args.verdict, "fingerprint": now, "at": state.now()}
        if evidence:
            entry["evidence"] = evidence
        elif args.verdict == "PASS" and args.reviewer in config.get("evidence_required", []):
            raise state.StateError(f"{args.reviewer} must attach evidence of what it ran: --evidence .factory/jobs/{args.job}/evidence/<file>")
        job["verdicts"][args.reviewer] = entry
        if args.verdict == "CHANGES":
            job["review_rounds"] = job.get("review_rounds", 0) + 1
            spent = job["review_rounds"] >= config["max_rounds"]
            state.move_in_place(job, "needs-human" if spent else "build", f"{args.reviewer} {state.ASKED_FOR_CHANGES}")
    job = state.update(project, args.job, change)
    print(f"VERDICT {args.reviewer} {args.verdict}; job is in {job['stage']}")
    return 0


def _deps(project: Path, args, config: dict) -> int:
    job = state.load(project, args.job)
    added = deps.added_dependencies(project, job["base"])
    for key, spec in added.items():
        record = job["deps"].get(key)
        print(f"{key} {spec} -> {record['status'] if record else 'UNCHECKED'}")
    print(f"{len(added)} new or changed dependencies" if added else "no new dependencies")
    return 0


def _deps_record(project: Path, args, config: dict) -> int:
    job = state.load(project, args.job)
    added = deps.added_dependencies(project, job["base"])
    if args.key not in added:
        raise state.StateError(f"{args.key} is not a new or changed dependency of this job")
    note = " ".join(args.note)
    spec = added[args.key]
    state.update(project, args.job, lambda current: current["deps"].update(
        {args.key: {"status": args.status, "note": note, "spec": spec, "at": state.now()}}))
    print(f"RECORDED {args.key} {args.status}")
    return 0


def _finish(project: Path, args, config: dict) -> int:
    reasons = finish.finish(project, args.job, config)
    job = state.load(project, args.job)
    notes = [] if reasons else waive.lines(job) + live.relock_lines(job) + needs.skipped_lines(job)
    print("NOT DONE" if reasons else "DONE")
    print("\n".join([f"- {reason}" for reason in reasons] + notes))
    return 1 if reasons else 0


def _timeline(project: Path, args, config: dict) -> int:
    print(timeline.render(state.load(project, args.job)))
    return 0


def _livecheck(project: Path, args, config: dict) -> int:
    line, green = live.run_live(project, args.job, config)
    print(line)
    if not green:
        job = state.load(project, args.job)
        output = state.job_dir(project, args.job) / job["lives"][-1]["output"]
        print("\n".join(live.failing_lines(output.read_text(encoding="utf-8", errors="replace"))))
    return 0 if green else 1


def _cases(project: Path, args, config: dict) -> int:
    if not args.check:
        print(cases.brief(project, args.job, config))
        return 0
    problems = cases.check(project, config)
    print("\n".join(f"- {problem}" for problem in problems) if problems else "OK the case file is ready; FX move to build freezes it")
    return 1 if problems else 0


def _live_init(project: Path, args, config: dict) -> int:
    target = live.init_script(project, args.path)
    print(f"WROTE {target.relative_to(project)}: set live_check.command to `python3 {args.path}` and live_check.locked_files to [\"{args.path}\"]")
    return 0


def _relock(project: Path, args, config: dict) -> int:
    moved = live.relock(project, args.job, args.reason, config)
    print(f"RELOCKED {', '.join(moved)}")
    return 0


def _handoff(project: Path, args, config: dict) -> int:
    print(f"HANDOFF {handoff.write(project, args.job, config).relative_to(project)}")
    return 0


def _waive(project: Path, args, config: dict) -> int:
    entry = waive.add(project, args.job, args.kind, args.name, args.owner_said, args.reason, config)
    print(f"WAIVED {entry['kind']} {entry['name']}")
    return 0


def _gate(project: Path, args, config: dict) -> int:
    line, green = run_gate(project, args.job, config)
    print(line)
    if green and config.get("fresh_review"):
        print(f"HANDOFF {handoff.write(project, args.job, config).relative_to(project)}  (config fresh_review: carry on in a clean context)")
    elif green and live.enabled(config):
        print(f"NEXT FX livecheck {args.job}, then the reviewers")
    return 0 if green else 1


def _route(project: Path, args, config: dict) -> int:
    print(json.dumps(classify(" ".join(args.words), config)))
    return 0


def _move(project: Path, args, config: dict) -> int:
    if args.stage in state.RESERVED:
        raise state.StateError(f"`move` cannot enter {args.stage}: the gate enters gate and review, finish enters done")
    current = state.load(project, args.job)
    was = current["stage"]
    if was in ("intake", "plan") and args.stage == "build" and cases.enabled(config):  # every job, planned or not: the live check asks for the author's cases from any job
        problems = cases.check(project, config)  # the build starts with the author's file in place, so the freeze below covers it
        if problems:
            raise state.StateError("the case author step is not done (FX cases " + args.job + "): " + "; ".join(problems))
    job = state.move(project, args.job, args.stage, " ".join(args.note))
    if was in ("intake", "plan") and args.stage == "build" and live.enabled(config):
        live.lock_new(project, args.job, config["live_check"])  # a script that exists when work starts is frozen; a later one at its first run
    print(f"MOVED {args.job} -> {job['stage']}")
    return 0


def _show(project: Path, args, config: dict) -> int:
    print(json.dumps(state.load(project, args.job), indent=2, sort_keys=True))
    return 0


def _status(project: Path, args, config: dict) -> int:
    print("\n".join(f"{job['id']}\t{job['stage']}\t{job['risk']}" for job in state.list_jobs(project)) or "no jobs")
    return 0


HANDLERS = {"new": _new, "route": _route, "move": _move, "raise": _raise, "show": _show, "status": _status,
            "gate": _gate, "timeline": _timeline, "livecheck": _livecheck, "cases": _cases, "live-init": _live_init, "livecheck-relock": _relock, "handoff": _handoff, "waive": _waive, "verdict": _verdict, "deps": _deps, "deps-record": _deps_record, "finish": _finish}


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    project = Path(args.project).resolve()
    try:
        return HANDLERS[args.command](project, args, load_config(project))
    except (state.StateError, RuntimeError, OSError, ValueError, KeyError, TypeError, AttributeError,
            subprocess.SubprocessError) as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 2
