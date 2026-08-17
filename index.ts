/**
 * Handoff — hand a pi session over to a fresh one.
 *
 * `/handoff [focus]` prompts the current agent to write a handoff document
 * capturing the state of the conversation — what was left outstanding,
 * what is not yet done, and what select information is worth taking
 * forward — then starts a brand-new pi session initialized with that
 * document. The agent generates the handoff in a follow-up turn (its own
 * context is the conversation state), writing the markdown with its
 * `write` tool.
 *
 * Handoff files live OUTSIDE the project, in `~/.pi/agent/handoffs/` by
 * default — never dumped into the working directory. Override with
 * `"dir"` in the handoff config (`.pi/handoff.json` project /
 * `~/.pi/agent/handoff.json` global) or the `PI_HANDOFF_DIR` env var.
 *
 * Subcommands:
 * - `/handoff [focus]`       — generate the handoff, then start a new
 *   session initialized with it (the full content is embedded in the new
 *   session's first user message; the old session is recorded as parent)
 * - `/handoff write [focus]` — generate the handoff file only, no new
 *   session (review it with `/handoff open` first, start later)
 * - `/handoff list [n]`      — list the n most recent handoff files
 * - `/handoff open [n|path]` — open a handoff in the full-screen editor
 * - `/handoff read [path|n]` — load a handoff into THIS session. Focused
 *   on handoffs created OUTSIDE this extension (other agents, other
 *   systems): pass any markdown path — relative to the project, absolute,
 *   or `~/...` — and the document is delivered as a follow-up user
 *   message with a kickoff instruction, so the current agent absorbs it
 *   and continues the work in place. Tab-complete the path (`/handoff
 *   read <tab>` suggests project *.md files and handoff-dir files); `read
 *   <n>` still reads the nth newest handoff this extension produced; a
 *   bare `read` shows a hint.
 * - `/handoff status`        — show the handoff directory and config
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildHandoffFileName,
  buildHandoffPrompt,
  buildKickoff,
  buildReadKickoff,
  completeReadTargets,
  expandHome,
  getHandoffDir,
  listMarkdownFiles,
  loadConfig,
  parseHandoffArgs,
  projectName,
} from "./utils.ts";

const GENERATE_CUSTOM_TYPE = "handoff-generate";
const READ_CUSTOM_TYPE = "handoff-read";
const SUBCOMMANDS = ["write", "list", "open", "read", "status"];

export default function (pi: ExtensionAPI): void {
  /** Last project cwd seen from a command invocation (for completions). */
  let lastCwd: string | undefined;

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function showList(ctx: ExtensionCommandContext, dir: string, count: number): void {
    const files = listMarkdownFiles(dir).slice(0, count);
    if (files.length === 0) {
      ctx.ui.notify(`No handoff files yet — run /handoff to create one.\nDir: ${dir}`, "info");
      return;
    }
    const lines = files.map((p, i) => {
      const mtime = new Date(statSync(p).mtimeMs);
      return `${i + 1}. ${basename(p)}  (${mtime.toISOString().slice(0, 19).replace("T", " ")})`;
    });
    ctx.ui.notify([...lines, `Dir: ${dir}`, "/handoff open <n> to view one."].join("\n"), "info");
  }

  /**
   * Resolve the file to open: `open` (newest), `open <n>` (nth newest,
   * 1-based), or `open <path>` (absolute or `~/` path).
   */
  function resolveOpenTarget(dir: string, target: string | undefined): string | undefined {
    if (!target) return listMarkdownFiles(dir)[0];
    const n = Number.parseInt(target, 10);
    if (Number.isFinite(n) && n > 0) {
      return listMarkdownFiles(dir)[n - 1];
    }
    if (target.startsWith("/") || target.startsWith("~")) return expandHome(target);
    return undefined; // not a number or a path — ambiguous
  }

  /**
   * Resolve the file to read: `read <path>` accepts ANY path — absolute,
   * `~/`, or relative to the project (handoffs created outside this
   * extension) — and `read <n>` picks the nth newest handoff this
   * extension produced. Returns undefined only for a missing target.
   */
  function resolveReadTarget(dir: string, cwd: string, target: string): string | undefined {
    const n = Number.parseInt(target, 10);
    if (Number.isFinite(n) && n > 0) return listMarkdownFiles(dir)[n - 1];
    if (target.startsWith("/") || target.startsWith("~")) return expandHome(target);
    return join(cwd, target);
  }

  async function openHandoff(ctx: ExtensionCommandContext, dir: string, target: string | undefined): Promise<void> {
    const path = resolveOpenTarget(dir, target);
    if (!path) {
      ctx.ui.notify(`No handoff file for "${target ?? ""}" — run /handoff list to see what exists.`, "warning");
      return;
    }
    if (!existsSync(path)) {
      ctx.ui.notify(`Not found: ${path}`, "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(`Handoff file: ${path}`, "info");
      return;
    }
    const content = readFileSync(path, "utf8");
    const updated = await ctx.ui.editor(`Handoff — ${basename(path)}`, content);
    if (updated !== undefined && updated !== content) {
      writeFileSync(path, updated, "utf8");
      ctx.ui.notify("Handoff updated.", "info");
    }
  }

  /**
   * Load a handoff into the CURRENT session: read the file and deliver
   * the document (plus a kickoff instruction) as a follow-up user message
   * with `triggerTurn`, so the current agent absorbs the handoff and
   * continues the work in place — no new session. Targets are handoffs
   * created outside this extension: any markdown path (relative, absolute,
   * or `~/`), or the nth newest handoff this extension produced.
   */
  async function readHandoff(ctx: ExtensionCommandContext, dir: string, target: string | undefined): Promise<void> {
    if (!target) {
      ctx.ui.notify(
        [
          "Give a path to the handoff file: /handoff read <path> — tab-complete suggests *.md files in the project (handoffs produced outside pi).",
          `Or a number n for the nth newest handoff this extension produced: ${dir}`,
        ].join("\n"),
        "info",
      );
      return;
    }
    const path = resolveReadTarget(dir, ctx.cwd, target);
    if (!path) {
      ctx.ui.notify(`No handoff file for "${target}" — run /handoff list to see what exists.`, "warning");
      return;
    }
    if (!existsSync(path)) {
      ctx.ui.notify(`Not found: ${path}`, "warning");
      return;
    }
    const content = readFileSync(path, "utf8").trim();
    if (!content) {
      ctx.ui.notify(`Handoff file is empty: ${path}`, "warning");
      return;
    }
    await ctx.waitForIdle(); // settle anything already in flight
    ctx.ui.notify(`Loading handoff into this session: ${path}`, "info");
    pi.sendMessage(
      {
        customType: READ_CUSTOM_TYPE,
        content: buildReadKickoff(path, content),
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  /**
   * Generate the handoff file: prompt the current agent (follow-up turn)
   * to reflect on the conversation and write the handoff markdown to
   * `file`. Returns true when the file exists afterwards.
   */
  async function generateHandoff(ctx: ExtensionCommandContext, file: string, focus: string | undefined): Promise<boolean> {
    const prompt = buildHandoffPrompt({
      cwd: ctx.cwd,
      project: projectName(ctx.cwd),
      focus,
      file,
    });
    pi.sendMessage(
      { customType: GENERATE_CUSTOM_TYPE, content: prompt, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    // sendMessage is fire-and-forget: stay in the command handler until the
    // generation turn settles, so we can verify the file before starting a
    // new session.
    await ctx.waitForIdle();
    return existsSync(file);
  }

  /* ---------------------------------------------------------------- */
  /* Command                                                           */
  /* ---------------------------------------------------------------- */

  pi.registerCommand("handoff", {
    description:
      "Generate a handoff document from the current conversation (focus derived from what's outstanding), then start a new pi session initialized with it. Subcommands: write (file only), list, open (editor), read (load a markdown handoff into this session; tab-complete the path), status.",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix.trimStart();
      const spaceIndex = text.search(/\s/);
      if (spaceIndex === -1) {
        // Still on the first token: complete subcommand names.
        return SUBCOMMANDS.filter((s) => s.startsWith(text)).map((s) => ({ value: s, label: s }));
      }
      const first = text.slice(0, spaceIndex);
      const rest = text.slice(spaceIndex + 1).trimStart();
      if (first.toLowerCase() === "read") {
        // `read` is for handoffs created outside the system — complete
        // markdown file paths (project first, then handoff dir).
        const cwd = lastCwd ?? process.cwd();
        return completeReadTargets(cwd, getHandoffDir(cwd, loadConfig(cwd)), rest);
      }
      return [];
    },
    handler: async (args, ctx) => {
      lastCwd = ctx.cwd;
      const { action, focus, count, target } = parseHandoffArgs(args ?? "");
      const config = loadConfig(ctx.cwd);
      const dir = getHandoffDir(ctx.cwd, config);

      if (action === "status") {
        const files = listMarkdownFiles(dir);
        ctx.ui.notify(
          [
            `Handoff dir: ${dir}`,
            `Files: ${files.length}`,
            files.length > 0 ? `Newest: ${basename(files[0])}` : "",
            'Change with "dir" in ~/.pi/agent/handoff.json / .pi/handoff.json, or PI_HANDOFF_DIR.',
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        return;
      }

      if (action === "list") {
        showList(ctx, dir, count);
        return;
      }

      if (action === "open") {
        await openHandoff(ctx, dir, target);
        return;
      }

      if (action === "read") {
        await readHandoff(ctx, dir, target);
        return;
      }

      // write | handoff — the generation flow
      await ctx.waitForIdle(); // settle anything already in flight
      mkdirSync(dir, { recursive: true });
      const file = join(dir, buildHandoffFileName(ctx.cwd, focus));
      ctx.ui.notify(
        [
          focus?.trim() ? `Focus: ${focus.trim()}` : "Focus: (auto — derived from the conversation)",
          `Handoff → ${file}`,
          action === "write" ? "Writing handoff only — no new session will be started." : "After the handoff is written, a new pi session will start with it loaded.",
        ].join("\n"),
        "info",
      );

      const wrote = await generateHandoff(ctx, file, focus);
      if (!wrote) {
        ctx.ui.notify(
          [
            `The handoff file was not created at ${file}.`,
            "The generation turn may have failed (e.g. restricted write tools in plan mode).",
            "No new session was started. Run /handoff again to retry.",
          ].join("\n"),
          "warning",
        );
        return;
      }

      if (action === "write") {
        ctx.ui.notify(`Handoff written: ${file}`, "info");
        return;
      }

      // action === "handoff": start the continuation session
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (e) {
        ctx.ui.notify(`Handoff written but could not be read back (${e instanceof Error ? e.message : e}) — no new session started.`, "warning");
        return;
      }
      const parentSession = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession,
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [{ type: "text", text: content }],
            timestamp: Date.now(),
          });
        },
        withSession: async (ctx) => {
          ctx.ui.notify(`New session started — handoff loaded from ${file}`, "info");
          await ctx.sendUserMessage(buildKickoff(file));
        },
      });
      if (result.cancelled) {
        // Cancelled before replacement — the old session is still active.
        ctx.ui.notify(`New session cancelled — handoff kept at ${file}. Run /handoff again to retry.`, "info");
      }
    },
  });
}
