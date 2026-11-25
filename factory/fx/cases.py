"""The case author step. A build is judged by live cases its own builder wrote, and a builder tests what it thought of. Here an independent
agent, one that sees the ticket and not the code, writes the live cases first; the file is frozen with the live script (`locked_files`),
every case carries the tag `ticket`, and `min_ticket_cases` makes the factory refuse a run in which the file did not load.
Off unless `live_check.ticket_cases` names the file."""
from __future__ import annotations

import ast
import re
from pathlib import Path

from fx import live, state

BRIEF = """You write live checks for a ticket you did not build. Read ONLY the ticket: {task}. Do not read the project's source, tests or plan.
Write {path}. It defines `register(case, base, post, get)` and calls `case(name, tags, run)` once per scenario; `run()` returns (ok, detail);
`base` is the app's URL; `post(path, body)` and `get(path)` return (status, text), for a 4xx or 5xx too, never an exception (a 5xx fails the case it came in, unless the ticket asks for that error and the case passes `expect_5xx=True`); use urllib only for the app's own streaming answers.
Rules:
- One scenario per acceptance criterion and per behaviour the ticket names, with the ticket's own wording as the input.
- For each, at least one paraphrase: a synonym, colloquial wording, another word order.
- Constraints the ticket lists (for example a filter, an attribute, a limit): for each kind, a first message that uses only that constraint, and
  one that combines two. Name the same thing in its plural, a synonym and a colloquial form too. When the ticket says such a request must find
  something, assert at least one result, counted in the response format the ticket defines, unless the reply is a clarifying question.
  To pick values that exist, call the app's own read endpoints the ticket names, through `get`. Make no network call to any other host
  (a case that needs another host's certificates fails on a machine without them, and that is a bug in the case, not in the code).
- Follow-ups: what the ticket says must be kept, changed or dropped on a second message; a message that needs earlier context sent with
  none; the same message in a fresh conversation.
- Assert properties every correct implementation satisfies (every item returned meets the stated constraint; a question or a refusal is an
  acceptable answer to an ambiguous request). Assert a specific item only when the ticket names it. Assert on what the response itself says,
  never on data you cannot see (the response, or what the app's own read endpoints return).
- Tag each case with a short id of the ticket bullet it covers. Never print or read a secret.
- At least {minimum} cases.
Reply with the file path and one line: the bullets you covered and any you could not check live."""


def settings(config: dict) -> dict:
    return config.get("live_check") or {}


def enabled(config: dict) -> bool:
    return live.ticket_cases_on(settings(config))


def brief(project: Path, job_id: str, config: dict) -> str:
    if not enabled(config):
        raise state.StateError("config has no live_check.ticket_cases: name the file the author writes, e.g. scripts/ticket_cases.py")
    folder = state.job_dir(project, job_id)
    task = folder / "source.md" if (folder / "source.md").is_file() else folder / "task.md"  # the owner's words first
    if not task.is_file():
        raise state.StateError(f"no task.md for job {job_id}")
    return BRIEF.format(task=task.relative_to(project), path=live.ticket_cases_path(settings(config)), minimum=minimum(config))


def minimum(config: dict) -> int:
    return live.ticket_minimum(settings(config))


def _case_calls(tree: ast.AST) -> int:
    """ponytail: counts `case(...)` call sites, so a loop that registers many cases from one call counts as one; the runtime tag count in live.py is the real guard."""
    return sum(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "case" for node in ast.walk(tree))


def check(project: Path, config: dict) -> list[str]:
    """What is wrong with the author's file, before the build starts."""
    if not enabled(config):
        raise state.StateError("config has no live_check.ticket_cases")
    named = live.ticket_cases_path(settings(config))
    path = project / named
    if not path.is_file():
        return [f"{named} does not exist: the author has not written it"]
    text = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(text, str(path))
    except SyntaxError as error:
        return [f"{path.name} does not compile: {error.msg} (line {error.lineno})"]
    problems = [] if re.search(r"^def register\(", text, re.MULTILINE) else [f"{path.name} defines no `def register(case, base, post, get)`"]
    found = _case_calls(tree)
    if found < minimum(config):
        problems.append(f"{path.name} has {found} case(...) calls; at least {minimum(config)} are required")
    if named not in live._locked_paths(project, settings(config)):
        problems.append(f"{named} is not in live_check.locked_files, so the builder could edit it")
    return problems
