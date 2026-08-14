# Changelog

## v0.1.0 (2026-08-14)

- `/handoff [focus]` — prompts the current agent to generate a handoff
  document from the conversation state (focus auto-derived when not
  given), stores it outside the project in `~/.pi/agent/handoffs/`, then
  starts a new pi session initialized with the document (content embedded
  in the first user message, old session recorded as parent).
- `/handoff write [focus]` — generate the handoff file only, no new
  session.
- `/handoff list [n]`, `/handoff open [n|path]`, `/handoff status` —
  manage and inspect handoff files.
- Config: `"dir"` in `~/.pi/agent/handoff.json` / `.pi/handoff.json`, or
  `PI_HANDOFF_DIR` env var.
- Handoff file naming: `<project>-<timestamp>[-<focus-slug>].md`.
