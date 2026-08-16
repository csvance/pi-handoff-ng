# Changelog

## v0.3.1 (2026-08-16)

- Read/kickoff prompts hardened against re-handoff loops: the document
  loaded by `/handoff read` is wrapped in BEGIN/END markers and framed as
  reference material about the work, NOT a set of instructions. Handoffs
  written by other systems sometimes contain their own meta-instructions
  ("write a new handoff"); the prompt now explicitly tells the agent to
  ignore text inside the document that instructs it to write a new
  handoff, hand the work off, or start another session, and not to do
  so. The same guard was added to the continuation-session kickoff.

## v0.3.0 (2026-08-16)

- `/handoff read` is focused on handoffs created outside this extension:
  pass any markdown path — relative to the project, absolute, or `~/` —
  and it is loaded into the current session as a follow-up message with a
  kickoff instruction.
- Tab completion for `read`: `/handoff read <tab>` suggests `*.md` files
  in the project (breadth-first, skipping hidden dirs and node_modules)
  then the extension's handoff-dir files, matching relative, `~/`, and
  absolute prefix forms.
- `read` with no target now shows a hint instead of silently loading the
  newest handoff-dir file; `read <n>` still reads the nth newest handoff
  this extension produced.

## v0.2.0 (2026-08-16)

- `/handoff read [n|path]` — load a handoff into the CURRENT session:
  the document is delivered as a follow-up user message with a kickoff
  instruction, so the current agent absorbs another agent's handoff and
  continues the work in place (no new session). Same target syntax as
  `open`: newest, nth newest, or an explicit path.

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
