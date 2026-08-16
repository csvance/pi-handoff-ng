# Handoff — pass a pi session to a fresh one

`/handoff [focus]` hands the current pi session over to a brand-new one:

1. The **current agent is prompted** to write a handoff document based on
   the current state of the conversation — what was left outstanding, what
   is not yet done, and what select information is worth taking forward.
   A user-supplied **focus** narrows or steers that prompt; without one,
   the agent derives the focus itself.
2. The agent writes the handoff to a markdown file **outside the project**
   (default: `~/.pi/agent/handoffs/` — never dumped into the working
   directory).
3. A **new pi session starts**, initialized with the handoff: the full
   document is embedded in the new session's first user message, the old
   session is recorded as its parent, and the new agent is kicked off with
   instructions to read the handoff and continue the work.

**Automatic handoff:** the agent itself can trigger the same flow — its
primary use is to hand off **mid-task** when context usage is high and
pi's auto-compaction would otherwise summarize the work (a handoff the
agent writes preserves far more than compaction will); it also works at
natural task boundaries. An optional token threshold hands off
automatically before compaction gets there. Automatic handoffs are
labeled as such: the handoff document records its trigger and stated
reason, and the continuation session's kickoff tells the fresh agent the
handoff was triggered by the agent (or the threshold), **not** by a user
command.

Verified end-to-end: the generated document captured the conversation
state, the continuation session opened with the handoff loaded, and the
fresh agent continued the work described in it. The automatic path was
verified against a live pi (RPC mode): tool call → settled run →
`/handoff --auto agent <focus>` dispatched through pi's command path →
document written → new session with parent tracking and the provenance
kickoff.

## Install

Requires **pi ≥ 0.84.2** (the automatic-handoff dispatch uses
`sendUserMessage`'s `expandPromptTemplates` option, added in 0.84.2).

### From GitHub (recommended for everyone else)

```bash
pi install https://github.com/<your-username>/pi-handoff-ng
# pin a version with a tag:
pi install https://github.com/<your-username>/pi-handoff-ng@v0.1.0
```

Installs to `~/.pi/agent/git/` (a real clone; `@ref` pins are respected and
reconciled by `pi update --extensions`). Restart pi or run `/reload`.

### From the local git repo (the author's dev machine)

```bash
# global (all projects)
pi install /home/csvance/Git/pi-handoff-ng
# project-local (settings go in this project's .pi/)
pi install /home/csvance/Git/pi-handoff-ng -l
```

A local path is a **live reference, not a copy** — update with
`git pull` + `/reload`, no re-install needed. See the install caveats in
[pi-plan-ng's README](https://github.com/csvance/pi-plan-ng) (same
mechanics).

### Manual copy (offline fallback)

Copy this directory into your project's `.pi/extensions/` — it is
auto-discovered on the next start (or `/reload`).

## Usage

| Action | Command |
| ------ | ------- |
| Hand off: generate + start a new session | `/handoff` |
| Hand off with an explicit focus | `/handoff fix the parser error handling` |
| Write the handoff file only (no new session) | `/handoff write [focus]` |
| List recent handoff files | `/handoff list [n]` |
| Open a handoff in the full-screen editor | `/handoff open [n\|path]` |
| Load a handoff into THIS session | `/handoff read <path|n>` |
| Show the handoff directory and config | `/handoff status` |

### The flow

`/handoff` runs this sequence:

1. **Settle** — any in-flight turn finishes first.
2. **Prompt** — the current agent receives a follow-up turn:
   *"You are handing this session over to a brand-new pi session with NO
   memory of this conversation…"* with the focus (or an instruction to
   derive one), the target file path, and a document structure:
   `# Handoff — <title>` with **Focus / Current state / Outstanding / Key
   context / Next steps** sections.
3. **Generate** — the agent reflects on the conversation and writes the
   markdown with its `write` tool to exactly the given path. The extension
   waits for the turn and verifies the file exists.
4. **Hand off** — the extension starts a new session
   (`ctx.newSession`), recording the old session as `parentSession`. The
   new session's first user message is the full handoff document, followed
   by a kickoff message telling the fresh agent to read it and work
   through the outstanding items. The new session inherits the same
   working directory.

If the generation turn does not produce the file (e.g. the write tool was
restricted), no session is started and a warning shows the expected path.

### Automatic handoff

The primary motivation: **it is better to hand off mid-task than to let
pi's built-in auto-compaction run.** Compaction produces a generic
transcript summary and loses the task-specific detail only the current
agent holds; a handoff the agent writes *while it is mid-task* captures
the in-flight task, its decisions, and the exact next step. So the
extension is built to hand off **before** compaction becomes the only
option.

Two ways for a handoff to be triggered without the user typing
`/handoff` (both converge on the exact same flow as above — the automatic
trigger re-dispatches the `/handoff` command internally, so there is one
code path, one file format, one kickoff):

- **Agent tool.** The agent gets a `handoff(focus?, reason?)` tool with
two first-class uses taught in its system prompt:
  1. *Natural boundary* — a logical task is complete and the next piece
     of work is a separate effort that does not depend on details that
     exist only in this conversation's context.
  2. *Mid-task compaction preemption* — context usage is high enough that
     auto-compaction is likely to fire before the current task finishes;
     handing off now is the better choice. **Mid-task is explicitly
     encouraged, not forbidden** — the only real anti-condition is that
     the agent must be able to state the next steps concretely (the
     document has to carry them).

  To make call #2 a real decision, the agent is given the signal it
  needs: once context usage reaches **60% of the window**, every run's
  system prompt carries a short `[handoff] Context usage: 72% of the
  window (144k/200k tokens)…` line telling it how close compaction is and
  that a mid-task handoff it writes preserves more than compaction will.
  Below 60% nothing is appended, so the system prompt (and prompt-cache
  prefixes) stays byte-identical for the normal case.

  Calling the tool stops the current run (`terminate`); when the run has
  fully settled (no retry, compaction, or queued continuation pending —
  pi's `agent_settled` event), the extension dispatches the handoff. The
  optional `reason` (e.g. "context at 80%, mid-refactor — preempting
  compaction") is recorded in the document and told to the continuation
  session.
- **Token threshold** (opt-in). With
  `"autoHandoff": { "thresholdTokens": 120000 }` in the handoff config,
  the session is handed off automatically once its estimated context
  usage crosses that many tokens (checked after each settled run; right
  after compaction the usage is unknown, so a just-compacted session is
  skipped). This is the fully-automatic version of the same idea. To make
  it preempt pi's built-in auto-compaction rather than race it, set the
  threshold **below** `contextWindow - reserveTokens` (reserveTokens
  defaults to 16384) — e.g. for a 200k window, compaction fires around
  183k, so a threshold of ~150–170k hands off first with the agent still
  fully aware of the task.

**Provenance.** Automatic handoffs are labeled for the receiver:

- the generation prompt records the trigger (and the stated reason, when
  given), so the handoff document's Focus section says it was triggered
  automatically — and, for a mid-task handoff, describes the in-flight
  task and exactly where it stands;
- the continuation session's kickoff says so explicitly — e.g. *"Provenance:
  this handoff was triggered automatically by the previous agent … it was
  NOT a user command. Stated reason: …"* — and invites the fresh agent to
  flag it if the next steps look premature once checked against the
  actual project state.

**Guard rails.** A 5-minute cooldown suppresses threshold re-triggering
right after a dispatch (the generation turn still runs in the old session
with the same large context); a handoff is never dropped while user
messages are queued (it retries on the next settled run); agent-initiated
handoffs below a context floor (default 25%, `minContextPercent`, 0
disables) are declined in-band so the agent simply keeps working — below
the floor compaction isn't imminent, so a handoff is churn, not
preemption; and the whole mechanism only runs in interactive modes (TUI
or RPC) — in headless modes the tool reports that and the agent continues
in place. Disable the agent tool with `"autoHandoff": { "tool": false }`.

`/handoff status` shows the effective automatic-handoff settings.

### Where the files go

Handoff files live in **`~/.pi/agent/handoffs/`** by default — next to
pi's sessions, never inside the project. Naming:
`<project>-<YYYY-MM-DD_HH-MM-SS>-<focus-slug>.md` (no slug when no focus
was given).

To change the location, set `"dir"` in `~/.pi/agent/handoff.json`
(global) or `.pi/handoff.json` (project; wins over global), or set the
`PI_HANDOFF_DIR` env var (wins over both). A leading `~` is expanded.
See [`handoff.config.example.json`](./handoff.config.example.json).
Automatic-handoff settings go in the same config under `"autoHandoff"`
(see [Automatic handoff](#automatic-handoff)); project and global
`autoHandoff` keys merge one level deep.

### Subcommands

- **`/handoff write [focus]`** — generate the document only; no session
  is started. Use it when you want to review first (`/handoff open`) or
  hand off later.
- **`/handoff list [n]`** — the `n` most recent handoff files
  (default 10), newest first.
- **`/handoff open [n|path]`** — open a handoff in the full-screen editor
  (1-based index from `list`, or an explicit path). Saving writes back.
- **`/handoff read [path|n]`** — load a handoff into the **current**
  session. Focused on handoffs created **outside this extension** (other
  agents, other systems — a plan markdown, a notes file, a handoff from
  another tool): pass any markdown path, relative to the project
  (`/handoff read PLAN.md`), absolute, or `~/...`, and the document is
  delivered as a follow-up user message with a kickoff instruction, so
  the current agent absorbs it and picks the work up in place — no new
  session.

  The injected message wraps the document in `BEGIN/END HANDOFF DOCUMENT
  (reference only)` markers and frames it as reference material about the
  work, **not** a set of instructions: handoffs written by other systems
  sometimes contain their own meta-instructions (e.g. "write a new
  handoff"), and the kickoff explicitly tells the agent to ignore those
  and not to write a new handoff or start another session.

  Tab-complete the path: `/handoff read <tab>` suggests `*.md` files in
  the project first, then the files this extension produced in its
  handoff dir. `read <n>` still reads the nth newest handoff this
  extension produced; a bare `read` shows a hint instead of loading
  anything.
- **`/handoff status`** — the handoff directory and how many files it
  holds.

### Notes

- The handoff-generation turn stays in the old session's history, so the
  old session remains a complete record. Nothing is deleted anywhere.
- The old session is not modified except by the generation turn; the new
  session is a fresh file linked via `parentSession`.
- **Plan mode:** if you're in plan mode (pi-plan-ng), the agent's `write`
  tool is restricted to the plan file, so generation will fail gracefully
  with a warning — run `/plan go` (or exit plan mode) first.
- `/handoff` is an interactive command (typed in the TUI); it is not
  available in headless `pi -p` mode.

## Development

```bash
npm install        # dev dependencies (typescript, types, pi types)
npm run typecheck  # tsc --noEmit (strict)
npm test           # node:test — utils: slugify, args, config, prompts
```

Note: the extension imports `./utils.ts` with the `.ts` extension (pi
loads TypeScript directly via jiti), so `tsconfig.json` uses
`allowImportingTsExtensions` + `noEmit`.

The end-to-end flow can be exercised against the real TUI with a pty
driver (see the smoke-test harness used during development:
`/tmp/handoff-smoke/drive.py` — it launches pi, types `/handoff`, and
verifies the file and the continuation session).

## Publishing to GitHub

```bash
gh repo create pi-handoff-ng --public --source=. --remote=origin --push
gh repo edit --description "Handoff for pi: agent-generated handoff document stored outside the project, then a fresh pi session initialized with it" --add-topic pi-package
```

## Credits

Built in the style of [pi-plan-ng](https://github.com/csvance/pi-plan-ng),
using pi's extension APIs: follow-up turns (`sendMessage` +
`triggerTurn`), idle tracking (`waitForIdle`), and session replacement
(`ctx.newSession` with `setup` + `withSession`). MIT licensed.
