"""The live check: the project's own script runs against the real provider. The factory, not the agent, injects the secrets and
redacts them from the record, so a job can prove behaviour against the real thing without its agent ever holding the key.
Off unless `live_check.command` is set. The script must print a summary line `LIVE <passed>/<total> PASS|FAIL`, and may print one
`CASE PASS|FAIL [tag,tag] name: detail` line per case: `required_cases` names the tags that must each have a passing case.
`locked_files` (the script and its scenarios) are frozen at plan approval, else at the first run that prints a summary: a change after it is refused until `relock` says why."""
from __future__ import annotations

import fcntl
import hashlib
import os
import re
import time
from pathlib import Path

from fx import state, waive
from fx.gate import run_command
from fx.git import fingerprint

SUMMARY = re.compile(r"^LIVE (\d+)/(\d+) (PASS|FAIL)\s*$", re.MULTILINE)
CASE = re.compile(r"^CASE (PASS|FAIL) \[([^\]\n]*)\] ?(.*)$", re.MULTILINE)  # a tag may hold a dot or a colon (AC-1.2): only ']' ends the list
APP_LINE = re.compile(r"^APP \| .*$", re.MULTILINE)  # the app's own last log lines, printed by the script when a case failed
SHOWN_APP_LINES = 15
SKIPPED_DIRS = (".factory/", ".git/", "node_modules/")  # a broad glob never freezes the factory's own records or dependencies
SHOWN_FAILURES = 12  # what the chair sees of a red run: the failing cases, not the whole output
SHOWN_WIDTH = 220
MIN_SECRET_CHARS = 8  # shorter values are not redacted: they would blank out ordinary words
REDACTED = "[redacted]"
AUTHOR_RELOCK = "AUTHOR CASES (the builder edited the independent author file; other files in this relock are listed too)"


def enabled(config: dict) -> bool:
    return bool((config.get("live_check") or {}).get("command", "").strip())


def load_secrets(settings: dict) -> tuple[dict[str, str], list[str]]:
    """(values, missing names): every name in `env` from the process environment, else from `env_file`."""
    from_file = _read_env_file(settings.get("env_file", ""))
    values = {name: os.environ.get(name) or from_file.get(name, "") for name in settings["env"]}
    return {name: value for name, value in values.items() if value}, [name for name, value in values.items() if not value]


def _read_env_file(path: str) -> dict[str, str]:
    target = Path(path).expanduser() if path else None
    if target is None or not target.is_file():
        return {}
    pairs = (line.split("=", 1) for line in target.read_text(encoding="utf-8").splitlines() if "=" in line and not line.lstrip().startswith("#"))
    return {name.strip(): value.strip().strip("\"'") for name, value in pairs}


def redact(text: str, secrets: dict[str, str]) -> str:
    """ponytail: exact substrings only; a secret the script re-encodes (base64, URL) or splits across lines survives. The upgrade is
    to redact the encoded forms too. Longest first, so a secret that contains another is not left half-redacted."""
    for value in sorted(secrets.values(), key=len, reverse=True):
        text = text.replace(value, REDACTED) if len(value) >= MIN_SECRET_CHARS else text
    return text


def run_live(project: Path, job_id: str, config: dict) -> tuple[str, bool]:
    """Run the live script once and record it. The job stays in review: the check is evidence, not a stage."""
    settings = config["live_check"]
    if not enabled(config):
        raise state.StateError("config has no live_check.command: set it in factory.config.json")
    job = state.load(project, job_id)
    if job["stage"] != "review":
        raise state.StateError(f"the live check runs in review, after a green gate; the job is in {job['stage']}")
    with (state.job_dir(project, job_id) / "live.lock").open("w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise state.StateError("another live check is running for this job") from None
        return _locked_live(project, job_id, config, settings)


def _locked_live(project: Path, job_id: str, config: dict, settings: dict) -> tuple[str, bool]:
    job = state.load(project, job_id)
    changed = changed_locked(project, job, settings)
    if changed:
        raise state.StateError(_changed_message(changed))
    number = len(job.get("lives", [])) + 1
    folder = state.job_dir(project, job_id) / f"live-{number}"
    folder.mkdir(exist_ok=True)
    before = fingerprint(project)
    seen = digests(project, settings)
    secrets, missing = load_secrets(settings)
    output = folder / "output.txt"
    started = time.monotonic()
    code, text = _run(settings, project, output, secrets, missing)
    seconds = round(time.monotonic() - started, 1)
    passed, total, said_pass = _summary(text)
    if total:
        lock_new(project, job_id, settings, seen)  # frozen once it has printed a summary: a script that cannot yet be read is still being written
    note = _why_not_green(code, missing, fingerprint(project) != before, passed, total, said_pass, settings, text)
    entry = {"number": number, "exit": code, "fingerprint": before, "green": note == "", "note": note, "cases": [passed, total],
             "ran": not missing, "seconds": seconds, "output": f"live-{number}/output.txt",
             "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "at": state.now()}
    state.update(project, job_id, lambda current: current.setdefault("lives", []).append(entry))
    head = "PASS" if entry["green"] else ("NOT RUN" if missing else "FAIL")
    return f"{head} live {passed}/{total} exit={code} fp={before[:12]}" + (f": {note}" if note else ""), entry["green"]


def _run(settings: dict, project: Path, output: Path, secrets: dict[str, str], missing: list[str]) -> tuple[int | None, str]:
    if missing:
        text = f"live check not run: missing {', '.join(missing)}\n"
        output.write_text(text, encoding="utf-8")
        return None, text
    code = None
    try:
        code = run_command(settings["command"], project, output, settings["timeout"], extra_env=secrets)
    finally:  # an interrupted run is redacted too: the record never holds a secret, even if the script printed one
        text = redact(output.read_bytes().decode("utf-8", errors="replace"), secrets)
        output.write_text(text, encoding="utf-8")
    return code, text


def _summary(text: str) -> tuple[int, int, bool]:
    found = SUMMARY.findall(text)
    if not found:
        return 0, 0, False
    passed, total, verdict = found[-1]
    return int(passed), int(total), verdict == "PASS"


def _why_not_green(code: int | None, missing: list[str], moved: bool, passed: int, total: int, said_pass: bool, settings: dict, text: str = "") -> str:
    if missing:
        return "missing secrets: " + ", ".join(missing)
    if code is None:
        return f"the live check ran longer than {settings['timeout']} seconds"
    if moved:
        return "NOT RECORDED: the code changed while the live check ran"
    if total == 0:
        return "the script printed no `LIVE <passed>/<total> PASS|FAIL` line"
    if total < settings["min_cases"]:
        return f"only {total} live cases ran; at least {settings['min_cases']} are required"
    if code != 0 or not said_pass or passed != total:
        return f"{passed} of {total} live cases passed (exit {code})"
    failed = sum(verdict == "FAIL" for verdict, _, _ in CASE.findall(text))
    if failed:
        return f"{failed} CASE FAIL line(s) in a run whose summary said PASS"
    absent = untagged(text, settings.get("required_cases", []))
    if absent:
        return f"no passing live case is tagged: {', '.join(absent)}"
    # ponytail: a live script that prints `CASE PASS [x,ticket]` itself, without loading the author's file, passes this count; the upgrade is the
    # scaffold printing the sha256 of the file it loaded and this check comparing it with the frozen digest.
    need = ticket_minimum(settings) if ticket_cases_on(settings) else 0
    ran = sum("ticket" in [tag.strip() for tag in tags.split(",")] for _, tags, _ in CASE.findall(text))
    return f"only {ran} live cases tagged `ticket` ran; the author's file must give at least {need} (the live script has to load it)" if ran < need else ""


def ticket_cases_path(settings: dict) -> str:
    """The author's file as the config names it, stripped; null or blank means the step is off. Anything but a string is refused, not guessed at."""
    value = settings.get("ticket_cases")
    if value is not None and not isinstance(value, str):
        raise state.StateError("live_check.ticket_cases must be the path of the author's file")
    return (value or "").strip()


def ticket_cases_on(settings: dict) -> bool:
    return bool(ticket_cases_path(settings))


def ticket_minimum(settings: dict) -> int:
    """How many cases tagged `ticket` a run needs. A value that is not a whole number is refused with a message, not crashed on."""
    try:
        return int(settings.get("min_ticket_cases", 8))
    except (TypeError, ValueError):
        raise state.StateError("live_check.min_ticket_cases must be a whole number") from None


def untagged(text: str, required: list[str]) -> list[str]:
    """The required tags that no PASS case line carries. A tag only counts on a case that passed."""
    passing = {tag.strip() for verdict, tags, _ in CASE.findall(text) if verdict == "PASS" for tag in tags.split(",")}
    return [tag for tag in required if tag not in passing]


def failing_lines(text: str) -> list[str]:
    """The failing `CASE FAIL` lines, cut to a short list: what the chair reads of a red run."""
    failed = [f"CASE FAIL [{tags}] {rest}"[:SHOWN_WIDTH] for verdict, tags, rest in CASE.findall(text) if verdict == "FAIL"]
    more = len(failed) - SHOWN_FAILURES
    app = [line[:SHOWN_WIDTH] for line in APP_LINE.findall(text)][-SHOWN_APP_LINES:] if failed else []
    return failed[:SHOWN_FAILURES] + ([f"... and {more} more failing cases: see the output file"] if more > 0 else []) + app


def live_reasons(project: Path, job: dict, config: dict, now: str) -> list[str]:
    """Why finish cannot accept the live evidence; empty when the check is off, waived, or green on the code as it is."""
    if not enabled(config) or waive.is_waived(job, "livecheck", "live"):
        return []
    lives = job.get("lives", [])
    if not lives:
        return ["the live check has not run"]
    if reasons := lock_reasons(project, job, config):
        return reasons
    last = lives[-1]
    output = state.job_dir(project, job["id"]) / last["output"]
    if not last["green"]:
        return [f"the last live check was red: {last['note']}"]
    if last["fingerprint"] != now:
        return ["the last live check is stale: the code changed after it"]
    if not output.is_file() or hashlib.sha256(output.read_bytes()).hexdigest() != last["output_sha256"]:
        return ["the last live check output no longer matches its record"]
    return []


def _locked_paths(project: Path, settings: dict) -> list[str]:
    names = {str(path.relative_to(project)) for pattern in settings.get("locked_files", []) for path in project.glob(pattern) if path.is_file()}
    return sorted(name for name in names if not name.startswith(SKIPPED_DIRS))


def _digest(project: Path, name: str) -> str:
    target = project / name
    return hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else "missing"


def digests(project: Path, settings: dict) -> dict[str, str]:
    return {name: _digest(project, name) for name in _locked_paths(project, settings)}


def lock_new(project: Path, job_id: str, settings: dict, seen: dict[str, str] | None = None) -> None:
    """Freeze the script and scenarios that exist and are not frozen yet, as `seen` (taken before a run) or as they are now."""
    def change(job: dict) -> None:
        frozen = job.setdefault("live_lock", {"files": {}, "relocks": []})["files"]
        frozen.update({name: digest for name, digest in (seen if seen is not None else digests(project, settings)).items() if name not in frozen})
    state.update(project, job_id, change)


def changed_locked(project: Path, job: dict, settings: dict) -> list[str]:
    frozen = (job.get("live_lock") or {}).get("files", {})
    return [name for name, digest in frozen.items() if _digest(project, name) != digest]


def _changed_message(changed: list[str]) -> str:
    return ("the live script changed after it was frozen: " + ", ".join(changed) + ". Fix the code, not the check. If the check itself is "
            "wrong, say why: FX livecheck-relock <job> --reason \"...\" (finish reports it)")


def relock(project: Path, job_id: str, reason: str, config: dict) -> list[str]:
    """The check itself was wrong: take the changed files as the new frozen state, and keep the reason where finish prints it."""
    settings = config["live_check"]
    if not reason.strip():
        raise state.StateError("a relock needs a reason: --reason \"<what was wrong with the check>\"")
    reason = " ".join(reason.split())  # one line: finish prints it
    moved: list[str] = []

    def change(job: dict) -> None:
        if job["stage"] not in ("build", "gate", "review"):
            raise state.StateError(f"a relock is for a job in progress, the job is in {job['stage']}")
        lock = job.setdefault("live_lock", {"files": {}, "relocks": []})
        moved.extend(changed_locked(project, job, settings))
        if not moved:
            raise state.StateError("the frozen live files have not changed: nothing to relock")
        lock["files"].update({name: _digest(project, name) for name in moved})
        # ponytail: a plain string compare with the paths `_locked_paths` returns, so "./scripts/x.py" in the config reads as not the author's file; the upgrade is Path.resolve on both sides
        lock["relocks"].append({"files": list(moved), "reason": reason, "at": state.now(), "author": ticket_cases_path(settings) in moved})
        for entry in job.get("lives", [])[-1:]:  # the green run was made by the old script: it must run again
            entry.update(green=False, note="the live script was relocked after this run: run it again")
    state.update(project, job_id, change)
    return moved


def relock_lines(job: dict) -> list[str]:
    """What finish prints under DONE: the live script was edited after it first ran, and why."""
    return [f"- RELOCKED {AUTHOR_RELOCK if item.get('author') else 'live script'} {', '.join(item['files'])}: {item['reason']}"
            for item in (job.get("live_lock") or {}).get("relocks", [])]


def lock_reasons(project: Path, job: dict, config: dict) -> list[str]:
    changed = changed_locked(project, job, config["live_check"])
    return [_changed_message(changed)] if changed else []


SCAFFOLD = Path(__file__).with_name("live_scaffold.txt")  # a Python program, kept as a file so it can be read and run on its own


def init_script(project: Path, path: str) -> Path:
    target = (project / path).resolve()
    if project.resolve() not in target.parents:
        raise state.StateError("the live script must be inside the project")
    if target.exists():
        raise state.StateError(f"{path} already exists: not overwritten")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(SCAFFOLD.read_text(encoding="utf-8"), encoding="utf-8")
    return target
