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

Verified end-to-end: the generated document captured the conversation
state, the continuation session opened with the handoff loaded, and the
fresh agent continued the work described in it.

## Install

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

### Where the files go

Handoff files live in **`~/.pi/agent/handoffs/`** by default — next to
pi's sessions, never inside the project. Naming:
`<project>-<YYYY-MM-DD_HH-MM-SS>-<focus-slug>.md` (no slug when no focus
was given).

To change the location, set `"dir"` in `~/.pi/agent/handoff.json`
(global) or `.pi/handoff.json` (project; wins over global), or set the
`PI_HANDOFF_DIR` env var (wins over both). A leading `~` is expanded.
See [`handoff.config.example.json`](./handoff.config.example.json).

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
