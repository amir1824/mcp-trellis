"""Find dependencies a change adds or bumps, so a new library is checked once, by name, before it ships."""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

from fx.git import changed_files, file_at

NPM_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
REQUIREMENT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def added_dependencies(project: Path, base: str) -> dict[str, str]:
    """{'npm:left-pad': '^1.0.0'} for every package that is new or whose version spec changed since `base`."""
    found: dict[str, str] = {}
    for path in changed_files(project, base):
        parser = _parser_for(Path(path).name)
        if parser is None:
            continue
        before = parser(file_at(project, base, path))
        current = project / path
        after = parser(current.read_text(encoding="utf-8-sig", errors="replace")) if current.is_file() else {}
        found.update({key: spec for key, spec in after.items() if before.get(key) != spec})
    return found


def _parser_for(name: str):
    if name == "package.json":
        return _package_json
    if re.fullmatch(r"requirements.*\.txt", name):
        return _requirements
    if name == "pyproject.toml":
        return _pyproject
    return None


def _package_json(text: str) -> dict[str, str]:
    try:
        data = json.loads(text.lstrip("\ufeff")) if text.strip() else {}
    except json.JSONDecodeError:
        return {}  # ponytail: a manifest that does not parse adds nothing; the build would fail on it anyway
    sections = [data.get(name) for name in NPM_SECTIONS] if isinstance(data, dict) else []
    return {f"npm:{name}": str(spec) for section in sections if isinstance(section, dict) for name, spec in section.items()}


def _requirement(line: str) -> tuple[str, str] | None:
    line = line.split("#", 1)[0].strip()
    match = REQUIREMENT_NAME.match(line)
    if not line or line.startswith("-") or match is None:
        return None
    return "py:" + match.group(0).lower().replace("_", "-"), line


def _requirements(text: str) -> dict[str, str]:
    return dict(pair for pair in map(_requirement, text.splitlines()) if pair)


def _pyproject(text: str) -> dict[str, str]:
    try:
        data = tomllib.loads(text) if text.strip() else {}
    except tomllib.TOMLDecodeError:
        return {}
    project = _table(data.get("project"))
    groups = list(_table(project.get("optional-dependencies")).values()) + list(_table(data.get("dependency-groups")).values())
    lines = _strings(project.get("dependencies")) + [item for group in groups for item in _strings(group)]
    return dict(pair for pair in map(_requirement, lines) if pair)


def _table(value) -> dict:
    return value if isinstance(value, dict) else {}


def _strings(value) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []
