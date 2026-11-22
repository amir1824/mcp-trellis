"""Thin git helpers. A project with no commit uses git's empty tree as its base."""
from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
STATE_DIR = ".factory"
CHUNK = 1 << 20


def run(project: Path, *args: str, check: bool = True) -> str:
    done = subprocess.run(["git", "-C", str(project), *args], capture_output=True, text=True, timeout=30)
    if check and done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout if done.returncode == 0 else ""


def head(project: Path) -> str:
    out = run(project, "rev-parse", "--verify", "-q", "HEAD", check=False).strip()
    return out or EMPTY_TREE


def tracked_and_untracked(project: Path) -> list[str]:
    """Every file git would keep: tracked plus untracked and not ignored, never the factory's own state."""
    out = run(project, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    names = sorted({name for name in out.split("\0") if name})
    return [name for name in names if not name.startswith(STATE_DIR + "/")]


def _names(output: str) -> set[str]:
    return {name for name in output.split("\0") if name and not name.startswith(STATE_DIR + "/")}


def changed_files(project: Path, base: str) -> list[str]:
    """Paths that differ from `base`: edited, deleted and renamed (both sides) tracked files, plus untracked ones.
    NUL-separated, so a non-ASCII path is never quoted; a git failure raises instead of reading as "no change"."""
    edited = run(project, "diff", "--name-only", "-z", "--no-renames", base)
    others = run(project, "ls-files", "-z", "--others", "--exclude-standard")
    return sorted(_names(edited) | _names(others))


def file_at(project: Path, base: str, path: str) -> str:
    """The content of `path` at `base`, or "" when it did not exist there."""
    return run(project, "show", f"{base}:{path}", check=False)


def fingerprint(project: Path) -> str:
    """The code's identity: a hash over every kept file's path, exec bit and content, so a green run belongs to one state.
    ponytail: it walks the whole tree on every call, ignores git-ignored files (build output) and does not see inside
    a submodule or a nested repo; the upgrade is `git submodule status` in the input."""
    digest = hashlib.sha256()
    for name in tracked_and_untracked(project):
        digest.update(name.encode() + b"\0")
        digest.update(_content_hash(project / name).encode() + b"\0")
    return digest.hexdigest()


def _content_hash(path: Path) -> str:
    if path.is_symlink():
        return "link:" + os.readlink(path)  # the link, never what it points at
    if not path.is_file():
        return "missing"  # a tracked file that was deleted
    digest = hashlib.sha256(b"x" if path.stat().st_mode & 0o111 else b"-")  # the exec bit is part of the code
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()
