#!/usr/bin/env python3
"""note - Create structured notes with YAML frontmatter.

Usage:
    uv run ///script/note.py create [args...]

Dependencies:
    uv add microcli

Commands:
    create    Create a new note
"""
# ///script dependencies: uv add microcli
from typing import Annotated
import sys
import re
import microcli as m
from datetime import datetime
from pathlib import Path

NOTES_DIR = Path(".knowledge/notes")


def slugify(title: str) -> str:
    """Convert title to URL-safe slug."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def format_note(title: str, slug: str, tags: list, content: str) -> str:
    """Format note with YAML frontmatter."""
    date = datetime.now().strftime("%Y-%m-%d")

    lines = [
        "---",
        f"title: {title}",
        f"slug: {slug}",
        f"date: {date}",
        f"tags: [{', '.join(tags)}]" if tags else "tags: []",
        "---",
        "",
        content,
    ]

    return "\n".join(lines)


@m.command
def create(
    title: Annotated[str, "Note title"],
    slug: Annotated[str, "URL slug (auto-generated if not provided)"] = "",
    tags: Annotated[str, "Comma-separated tags"] = "",
    save: Annotated[bool, "Save to file (default: draft mode)"] = False,
):
    """Create a structured note from stdin content."""
    content = sys.stdin.read().strip()

    if not content:
        m.fail("No content provided via stdin")

    # Generate slug if not provided
    if not slug:
        slug = slugify(title)

    # Parse tags
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    # Format the note
    formatted = format_note(title, slug, tag_list, content)

    if not save:
        # Draft mode - show how to save
        m.info("Note is in draft mode. To save, create the exact same note with --save:")
        m.info(f"  {create.explain(title=title, slug=slug, tags=tags, save=True)}")
    else:
        NOTES_DIR.mkdir(parents=True, exist_ok=True)
        filepath = NOTES_DIR / f"{slug}.md"

        if filepath.exists():
            m.fail(f"File already exists: {filepath}")

        filepath.write_text(formatted)
        m.ok(f"Saved to: {filepath}")


if __name__ == "__main__":
    m.main()
