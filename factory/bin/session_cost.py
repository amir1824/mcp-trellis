#!/usr/bin/env python3
"""Sum the tokens of a Claude Code session from its transcript. Reads only.

Usage: python3 -I factory/bin/session_cost.py <session.jsonl>

Prints one row for the session and one per subagent (`<session>/subagents/*.jsonl`, named by the file's
stem), then a total row, as plain aligned text:

    session  messages  input  cache_creation  cache_read  output  fresh

`fresh` is input + cache_creation + output, the tokens that were not read from the cache. A message the
transcript writes in several records (one per content block, with the same usage) counts once, with the usage of
the last record of its `message.id`: in the local transcripts the first record's output count differed from the
last in about 3% of messages. A record without usage and a record that is not an
assistant one are skipped; so is a blank line. A line that is not a JSON object is skipped too and
counted in the `unreadable lines:` line that ends the output. A file that cannot be read prints one
line to stderr and exits 2.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
COLUMNS = ("messages", "input", "cache_creation", "cache_read", "output", "fresh")
NAME_COLUMN = "session"
TOTAL_ROW = "total"
SUBAGENTS_FOLDER = "subagents"
EXIT_UNREADABLE = 2
GAP = "  "

Row = tuple[str, tuple[int, ...]]


def parse_line(line: str, position: int) -> tuple[str, dict] | None:
    """(message key, usage) of an assistant record that has usage; None for a record to skip.
    Raises ValueError when the line is not a JSON object, and RecursionError when it nests too deeply to parse."""
    record = json.loads(line)
    if not isinstance(record, dict):
        raise ValueError("not a JSON object")
    message = record.get("message")
    if record.get("type") != "assistant" or not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
        return None
    return str(message.get("id") or record.get("requestId") or f"line-{position}"), message["usage"]


def read_transcript(path: Path) -> tuple[list[dict], int]:
    """The last usage of each message in the file, and how many lines could not be read."""
    last: dict[str, dict] = {}
    unreadable = 0
    with path.open(encoding="utf-8", errors="replace") as lines:
        for position, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                parsed = parse_line(line, position)
            except (ValueError, RecursionError):
                unreadable += 1
                continue
            if parsed:
                last[parsed[0]] = parsed[1]
    return list(last.values()), unreadable


def token_count(usage: dict, key: str) -> int:
    value = usage.get(key)
    return value if type(value) is int else 0


def totals(usages: list[dict]) -> tuple[int, ...]:
    """messages, input, cache_creation, cache_read, output, fresh."""
    sums = [sum(token_count(usage, key) for usage in usages) for key in USAGE_KEYS]
    fresh = sums[0] + sums[1] + sums[3]
    return (len(usages), *sums, fresh)


def render(rows: list[Row]) -> str:
    table = [(NAME_COLUMN, *COLUMNS)] + [(name, *map(str, counts)) for name, counts in rows]
    widths = [max(len(line[index]) for line in table) for index in range(len(COLUMNS) + 1)]
    return "\n".join(GAP.join(cell.ljust(widths[0]) if index == 0 else cell.rjust(widths[index])
                              for index, cell in enumerate(line)) for line in table)


def summarize(session: Path) -> tuple[list[Row], int]:
    subagents = sorted((session.parent / session.stem / SUBAGENTS_FOLDER).glob("*.jsonl"))
    rows: list[Row] = []
    unreadable = 0
    for path in [session, *subagents]:
        usages, bad = read_transcript(path)
        rows.append((path.stem, totals(usages)))
        unreadable += bad
    rows.append((TOTAL_ROW, tuple(map(sum, zip(*(counts for _, counts in rows))))))
    return rows, unreadable


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: session_cost.py <session.jsonl>", file=sys.stderr)
        return EXIT_UNREADABLE
    try:
        rows, unreadable = summarize(Path(argv[1]))
    except OSError as error:
        print(f"session_cost: cannot read {error.filename or argv[1]}: {error.strerror}", file=sys.stderr)
        return EXIT_UNREADABLE
    print(render(rows))
    print(f"unreadable lines: {unreadable}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
