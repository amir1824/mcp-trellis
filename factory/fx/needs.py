"""What a job needs from outside before it can finish, said at intake so the owner can decide once, early, instead of after the build."""
from __future__ import annotations

import re

from fx import live

TEST_COMMAND = re.compile(r"\b(test|tests|pytest|unittest|jest|vitest|mocha|rspec|phpunit)\b")  # ponytail: a word list, so `make check` reads as no tests; the owner reads the line and decides


def lines(route: dict, config: dict) -> list[str]:
    found = []
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
