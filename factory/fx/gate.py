"""The gate: a script runs the project's checks on the code as it is, and records the result. No agent writes it."""
from __future__ import annotations

import fcntl
import fnmatch
import hashlib
import os
import signal
import subprocess
from pathlib import Path

from fx import state
from fx.git import changed_files, fingerprint

TAIL_LINES = 60
ALWAYS_PROTECTED = ("factory/**", "factory.config.json")  # in code: the config being judged cannot empty it


def protected_violations(project: Path, base: str, config: dict) -> list[str]:
    """Changed files that match a protected glob: the checks and the factory cannot be edited by the job they judge."""
    globs = ALWAYS_PROTECTED + tuple(config["protected_paths"])
    return [path for path in changed_files(project, base) if any(fnmatch.fnmatch(path, glob) for glob in globs)]


def run_gate(project: Path, job_id: str, config: dict) -> tuple[str, bool]:
    """Run the checks once. Returns (one line, whether the round is green). The job moves to review, back to build,
    or to needs-human when the rounds are spent."""
    if not config.get("checks", "").strip():
        raise state.StateError("config has no `checks` command: set it in factory.config.json")
    folder = state.job_dir(project, job_id)
    with (folder / "gate.lock").open("w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise state.StateError("another gate is running for this job") from None
        return _locked_gate(project, job_id, config)


def _locked_gate(project: Path, job_id: str, config: dict) -> tuple[str, bool]:
    job = state.load(project, job_id)
    if job["stage"] == "build":
        job = state.move(project, job_id, "gate")
    elif job["stage"] != "gate":
        raise state.StateError(f"the gate runs from build, the job is in {job['stage']}")
    number = len(job["gates"]) + 1
    folder = state.job_dir(project, job_id) / f"round-{number}"
    folder.mkdir(exist_ok=True)
    before = fingerprint(project)
    code = run_command(config["checks"], project, folder / "output.txt", config["check_timeout"])
    violations = protected_violations(project, job["base"], config)  # after the run: the checks may add one
    note = _why_not_green(code, fingerprint(project) != before, violations, config)
    green = note == ""
    output = (folder / "output.txt").read_bytes()
    entry = {"round": number, "exit": code, "fingerprint": before, "green": green, "note": note,
             "violations": violations, "output": f"round-{number}/output.txt",
             "output_sha256": hashlib.sha256(output).hexdigest(), "at": state.now()}
    _write_summary(folder / "checks.md", config["checks"], entry, output)
    state.update(project, job_id, lambda current: _record(current, entry, number, config["max_rounds"]))
    verdict = "PASS" if green else "FAIL"
    return f"{verdict} round {number} exit={code} fp={before[:12]}" + (f": {note}" if note else ""), green


def _why_not_green(code: int | None, moved: bool, violations: list[str], config: dict) -> str:
    if code is None:
        return f"the checks ran longer than {config['check_timeout']} seconds"
    if moved:
        return "NOT RECORDED: the code changed while the checks ran (a suite that writes untracked files not in .gitignore does this)"
    if violations:
        return "protected files changed: " + ", ".join(violations)
    return "" if code == 0 else f"the checks exited {code}"


def _record(job: dict, entry: dict, number: int, max_rounds: int) -> None:
    job["gates"].append(entry)
    reds = next((i for i, gate in enumerate(reversed(job["gates"])) if gate["green"]), len(job["gates"]))  # red runs in a row
    if entry["green"]:
        state.move_in_place(job, "review", f"gate round {number} green")
    elif reds >= max_rounds:
        state.move_in_place(job, "needs-human", f"gate red {reds} times in a row")
    else:
        state.move_in_place(job, "build", f"gate round {number} red")


def run_command(command: str, cwd: Path, output: Path, timeout: int, extra_env: dict[str, str] | None = None) -> int | None:
    """Run the command in its own process group; a timeout kills the group. None means it timed out."""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", **(extra_env or {}))
    with output.open("wb") as sink:
        proc = subprocess.Popen(command, shell=True, cwd=cwd, stdout=sink, stderr=subprocess.STDOUT,
                                start_new_session=True, env=env)
        try:
            return proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            return None


def _write_summary(path: Path, command: str, entry: dict, output: bytes) -> None:
    tail = "\n".join(output.decode("utf-8", errors="replace").splitlines()[-TAIL_LINES:])
    path.write_text(
        f"## Summary\n- command: `{command}`\n- exit: {entry['exit']}\n- green: {entry['green']}\n"
        f"- fingerprint: {entry['fingerprint']}\n- note: {entry['note'] or 'none'}\n\n## Output tail\n```\n{tail}\n```\n",
        encoding="utf-8")
