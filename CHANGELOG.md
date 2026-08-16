# Changelog

## v0.4.0 (2026-08-16)

- **Automatic handoff** — the agent can trigger `/handoff` itself instead
  of waiting for the user or for pi's built-in compaction. Primary use:
  hand off MID-TASK when context usage is high and auto-compaction would
  otherwise summarize the work — a handoff the agent writes preserves far
  more than compaction will (also works at natural task boundaries):
  - New agent-callable `handoff(focus?, reason?)` tool. The system prompt
    teaches both trigger cases and the one real anti-condition (you must
    be able to state the next steps concretely — the document must carry
    them). Calling it ends the run; when the run has fully settled
    (`agent_settled`), the extension dispatches the normal `/handoff`
    flow — the only code path with access to `newSession`.
  - **Context visibility for the decision:** once usage reaches 60% of
    the window, every run's system prompt carries a `[handoff] Context
    usage: …` line (numbers + the mid-task handoff option). Below 60%
    nothing is appended, so prompt-cache prefixes stay intact for the
    normal case.
  - **Opt-in token threshold:** `"autoHandoff": { "thresholdTokens": … }`
    hands off automatically once usage crosses the value — the
    fully-automatic version of the same idea. To preempt pi's
    auto-compaction, set it below `contextWindow - reserveTokens`
    (reserveTokens defaults to 16384).
  - **Guard rails:** 5-minute cooldown (the generation turn still runs in
    the old session with the same large context); queued user messages
    are never dropped (retries on the next settled run); agent-initiated
    handoffs below `minContextPercent` (default 25%, 0 disables) are
    declined in-band so the agent keeps working.
  - **Provenance for the receiver:** automatic triggers re-enter the
    command as `/handoff --auto agent|threshold [focus]`; the generation
    prompt records the trigger and the stated reason in the document (and
    asks for the in-flight task's state on mid-task handoffs), and the
    continuation session's kickoff explicitly tells the fresh agent the
    handoff was automated — not a user command — with the stated reason.
  - Guarded to interactive modes (TUI/RPC); in headless modes the tool
    reports that and the agent continues in place.
  - `/handoff status` shows the effective automatic-handoff settings.
- Requires pi ≥ 0.84.2 (`sendUserMessage` `expandPromptTemplates` option,
  used to dispatch the command programmatically); declared as a peer
  dependency.

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
