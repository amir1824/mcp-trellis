"""What a job needs from outside before it can finish, said at intake so the owner can decide once, early, instead of after the build."""
from __future__ import annotations

import re
from pathlib import Path

from fx import live

TEST_COMMAND = re.compile(r"\b(test|tests|pytest|unittest|jest|vitest|mocha|rspec|phpunit)\b")  # ponytail: a word list, so `make check` reads as no tests; the owner reads the line and decides


LINTER_FILES = ("biome.json", "biome.jsonc", "eslint.config.*", ".eslintrc*", ".prettierrc*")
IGNORE_FILES = (".eslintignore", ".prettierignore")


def linter_lines(project: Path) -> list[str]:
    """The gate's first round must not lint the factory's own files: say so when a linter config never mentions `factory`.
    ponytail: a plain substring search, so a mention anywhere counts as an exclusion, and a linter configured only in package.json is not read; the owner reads the line."""
    configs = sorted({path for pattern in LINTER_FILES for path in project.glob(pattern) if path.is_file()})
    if not configs:
        return []
    texts = [path.read_text(encoding="utf-8", errors="replace") for path in configs + [project / name for name in IGNORE_FILES if (project / name).is_file()]]
    return [] if any("factory" in text for text in texts) else [
        f"{configs[0].name} does not exclude factory/: the gate's first round would lint the factory's own files; exclude factory/ there"]


def source_lines(plans: bool, has_source: bool) -> list[str]:
    return ["no source: the owner's own words are not kept, so the reviewers judge the plan against the task file only (a summary is your reading, not the request); keep the original text before the build: `FX source <id> <file>`"] if plans and not has_source else []


def lines(route: dict, config: dict, project: Path, has_source: bool) -> list[str]:
    found = linter_lines(project) + source_lines(route["plan"], has_source)
    if live.enabled(config):
        _, missing = live.load_secrets(config["live_check"])
        found.append("live check needs secrets that are missing here: " + ", ".join(missing) + " (set them, or the owner waives it)" if missing
                     else "live check is ready: the factory injects its secrets")
    if config.get("checks") and not TEST_COMMAND.search(config["checks"]):
        found.append(f"checks (`{config['checks']}`) names no test command: a green gate then shows the code builds, not that it works; add the project's tests to checks")
    found += [f"no browser here (config browser=false): {name} is not asked, so the flow it covers is not checked in a browser" for name in route.get("skipped", [])]
    shown = [name for name in route["reviewers"] if name in config.get("evidence_required", [])]
    found += [f"{name} must attach evidence of what it ran; if it cannot run here, only the owner's quoted words waive it" for name in shown]
    return found


def skipped_lines(job: dict) -> list[str]:
    """What finish prints under DONE for a reviewer the config removed, so a check never run is not read as a check passed."""
    return [f"- SKIPPED {name}: no browser here (config browser=false); not checked in a browser" for name in job.get("skipped", [])]
