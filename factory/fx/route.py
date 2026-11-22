"""Classify a request. The owner's words win; keywords are a hint that may be raised and never lowered."""
from __future__ import annotations

import json
import re
from pathlib import Path

OWNER_CLASS = re.compile(r"^\s*(low|medium|high)\b\s*(?:[:,;\-]|$)", re.IGNORECASE)
RAISING_WORD = re.compile(r"^\s*(medium|high)\b", re.IGNORECASE)  # a bare leading 'low' is an ordinary word
ORDER = ("low", "medium", "high")
DEFAULTS = Path(__file__).resolve().parent.parent / "config.json"


def load_config(project: Path) -> dict:
    config = json.loads(DEFAULTS.read_text(encoding="utf-8"))
    override = project / "factory.config.json"
    if override.is_file():
        for key, value in json.loads(override.read_text(encoding="utf-8")).items():
            config[key] = {**config[key], **value} if isinstance(value, dict) and isinstance(config.get(key), dict) else value
    return config


def _hits(text: str, words: list[str]) -> bool:
    lowered = text.lower()
    # ponytail: prefix match, so 'auth' also fires on 'author'; the upgrade is a stemmer or an owner class
    return any(re.search(r"\b" + re.escape(word) + (r"\b" if len(word) <= 3 else ""), lowered) for word in words)


def _matched(text: str, words: list[str]) -> list[str]:
    return [word for word in words if _hits(text, [word])]


def _without_ignored(text: str, config: dict) -> str:
    """Phrases that carry a risk word in another sense ('design tokens' are CSS, not credentials) are blanked before matching."""
    for phrase in config.get("ignore_phrases", []):
        text = re.sub(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", " ", text, flags=re.IGNORECASE)  # whole words only: 'design tokenization' keeps its risk
    return text


def classify(text: str, config: dict) -> dict:
    words = config["keywords"]
    scan = _without_ignored(text, config)
    surfaces = [name for name in ("security", "ui") if _hits(scan, words[name])]
    explicit = OWNER_CLASS.match(text) or RAISING_WORD.match(text)
    high, low = _matched(scan, words["high"]), _matched(scan, words["low"])
    if explicit:
        risk, because = explicit.group(1).lower(), "the owner's class"
    elif high:
        risk, because = "high", ", ".join(high)
    elif low:
        risk, because = "low", ", ".join(low)
    else:
        risk, because = "medium", "no keyword"
    if "security" in surfaces and risk == "low" and not explicit:
        risk = "medium"  # a security surface is never a LOW by keyword
    return {**routing_for(risk, surfaces, bool(explicit), config), "because": because}


def raise_to(job_risk: str, wanted: str) -> str:
    """The chair may raise the class and never lower it."""
    return max(job_risk, wanted, key=ORDER.index)


def routing_for(risk: str, surfaces: list[str], owner: bool, config: dict) -> dict:
    row = config["routing"][risk]
    extra = [config["surface_reviewers"][name] for name in surfaces if name in config["surface_reviewers"]]
    wanted = list(dict.fromkeys(row["reviewers"] + extra))
    absent = [] if config.get("browser", True) else config.get("browser_reviewers", [])  # no browser here: such a reviewer could only waive itself
    reviewers = [name for name in wanted if name not in absent]
    plan = row["plan"] or "security" in surfaces  # a security surface needs M lines, so it needs a plan
    return {"risk": risk, "surfaces": surfaces, "owner": owner, "plan": plan, "reviewers": reviewers,
            "skipped": [name for name in wanted if name in absent]}
