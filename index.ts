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
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildAutoHandoffCommand,
  buildContextUsageLine,
  buildHandoffFileName,
  buildHandoffPrompt,
  buildKickoff,
  buildReadKickoff,
  completeReadTargets,
  describeAutoSource,
  expandHome,
  formatK,
  getAutoHandoffSettings,
  getHandoffDir,
  listMarkdownFiles,
  loadConfig,
  parseHandoffArgs,
  projectName,
  type AutoHandoffSource,
} from "./utils.ts";

/**
 * Dispatch a registered extension command by name (e.g. "/handoff").
 *
 * `sendUserMessage` with `expandPromptTemplates: true` makes pi route text
 * starting with `/` to the matching registered command (running it with a
 * full command context — the only place `newSession` is available). pi
 * 0.84.2 added the `expandPromptTemplates` option to `sendUserMessage`;
 * 0.84.1's runtime hardcodes it to `false`, so this path requires
 * pi >= 0.84.2 (declared as a peer dependency). The 0.84.1 type
 * declarations predate the option, hence the assertion.
 */
function dispatchCommand(pi: ExtensionAPI, command: string): void {
  const options = { expandPromptTemplates: true } as Parameters<typeof pi.sendUserMessage>[1];
  pi.sendUserMessage(command, options);
}

/** Modes where a session replacement (new session) is meaningful. */
const HANDOFF_MODES = new Set(["tui", "rpc"]);

const GENERATE_CUSTOM_TYPE = "handoff-generate";
const READ_CUSTOM_TYPE = "handoff-read";
const SUBCOMMANDS = ["write", "list", "open", "read", "status"];

/**
 * Suppress automatic-handoff re-triggering for this long after each dispatch.
 * The handoff's generation turn still runs in the OLD session with the same
 * (still-large) context, so without a cooldown the token threshold would
 * immediately re-trigger a second handoff.
 */
const AUTO_HANDOFF_COOLDOWN_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI): void {
  /** Last project cwd seen from a command invocation (for completions). */
  let lastCwd: string | undefined;
  /** Automatic handoff awaiting dispatch (set by the tool or the threshold; consumed by agent_settled). */
  let pendingAuto: { source: AutoHandoffSource; focus?: string; reason?: string } | undefined;
  /** Epoch-ms until which the threshold trigger is suppressed (after each auto dispatch). */
  let autoHandoffCooldownUntil = 0;
  /** Reason for the most recent auto dispatch (set by agent_settled, consumed by the command handler). */
  let lastAutoReason: string | undefined;
  function consumeAutoReason(): string | undefined {
    const r = lastAutoReason;
    lastAutoReason = undefined;
    return r;
  }

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
   * `file`. Returns true when the file exists afterwards. When
   * `autoSource` is set, the generation prompt records that this handoff
   * was triggered automatically.
   */
  async function generateHandoff(
    ctx: ExtensionCommandContext,
    file: string,
    focus: string | undefined,
    autoSource?: AutoHandoffSource,
    autoReason?: string,
  ): Promise<boolean> {
    const prompt = buildHandoffPrompt({
      cwd: ctx.cwd,
      project: projectName(ctx.cwd),
      focus,
      file,
      autoSource,
      reason: autoReason,
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
  /* Automatic handoff: agent tool + threshold trigger + dispatch      */
  /* ---------------------------------------------------------------- */

  const autoSettings = getAutoHandoffSettings(loadConfig(process.cwd()));

  /**
   * Give the agent the context-usage signal it needs to decide whether to
   * hand off MID-TASK rather than risk auto-compaction: once usage is in
   * the danger zone, every run's system prompt carries a short line with
   * the numbers and the handoff option. Below the warn threshold nothing
   * is appended, so the system prompt (and prompt-cache prefixes) stay
   * byte-identical for the normal case.
   */
  pi.on("before_agent_start", (event, ctx) => {
    if (!autoSettings.tool) return;
    const usage = ctx.getContextUsage();
    const line = buildContextUsageLine(usage?.percent ?? null, usage?.tokens ?? null, usage?.contextWindow);
    if (!line) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${line}` };
  });

  /**
   * The agent-callable `handoff` tool. Two first-class uses:
   * 1. Natural boundary — a logical task is complete, next work is separate.
   * 2. MID-TASK compaction preemption — context is high enough that pi's
   *    auto-compaction is likely to fire before the current task finishes;
   *    a handoff the agent writes now preserves task-specific detail that
   *    compaction would summarize away. This is the feature's primary
   *    motivation, so mid-task is explicitly encouraged, not forbidden.
   * The tool only RECORDS the intent and stops the run (terminate: true);
   * the actual handoff happens in the agent_settled handler — the one point
   * documented as "fully settled, no retry/compaction/queued continuation
   * pending" — because the /handoff flow (waitForIdle → generation turn →
   * newSession) must not run while a turn is in flight.
   */
  if (autoSettings.tool) {
    pi.registerTool({
      name: "handoff",
      label: "Handoff",
      description:
        "Hand this session to a NEW pi session: a handoff document is written from this conversation (state, decisions, outstanding work, exact next steps) and a fresh session starts initialized with it. The old session is kept as a complete record. " +
        "Use it (1) when a logical task is complete and the next work is a separate effort, or (2) MID-TASK when context usage is high and auto-compaction would otherwise summarize this work — a handoff you write preserves far more than compaction will.",
      promptSnippet:
        "handoff(focus?, reason?) - start a new pi session from a written handoff doc (at a task boundary, or mid-task to preempt auto-compaction)",
      promptGuidelines: [
        "Use handoff at a natural boundary: a logical task is complete and the next piece of work is a separate effort that does not depend on details that exist only in this conversation's context.",
        "Also use handoff MID-TASK when context usage is high (see the [handoff] context line in your system prompt) and auto-compaction is likely to fire before you finish: compacting mid-task loses task-specific detail that only you currently have, so a handoff you write now — capturing the in-flight task, its decisions, and the exact next step in focus/reason — is the better choice.",
        "The one real anti-condition: do not call handoff unless you can state the next steps concretely — the document must carry them. When mid-task and in doubt between handing off and letting compaction run, prefer handing off.",
        "Call handoff as the only tool call in your final message so the session ends cleanly, and stop working after calling it.",
      ],
      parameters: Type.Object({
        focus: Type.Optional(
          Type.String({
            description:
              "What the continuation session should concentrate on. For a mid-task handoff: the in-flight task and its exact next step.",
          }),
        ),
        reason: Type.Optional(
          Type.String({
            description:
              "Why you are handing off now (e.g. 'context at 80%, mid-refactor — preempting auto-compaction', or 'task complete, next work is independent'). Recorded in the handoff document and told to the continuation session.",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!HANDOFF_MODES.has(ctx.mode)) {
          return {
            content: [
              {
                type: "text",
                text: "handoff requires interactive mode (TUI or RPC); no handoff was queued. Continue the work in this session.",
              },
            ],
            details: { queued: false, reason: `mode-${ctx.mode}` },
          };
        }
        // Context floor: below it auto-compaction is not imminent, so an
        // agent-initiated handoff is churn, not preemption. Decline in-band
        // (no terminate) so the agent simply keeps working.
        const usage = ctx.getContextUsage();
        const percent = usage?.percent ?? null;
        const floor = autoSettings.minContextPercent;
        if (floor > 0 && typeof percent === "number" && percent < floor) {
          return {
            content: [
              {
                type: "text",
                text: `Handoff skipped: context is only at ${Math.round(percent)}% of the window (minimum for an agent-initiated handoff: ${floor}%), so auto-compaction is not imminent. Continue working; if you still believe a fresh session is right, tell the user and let them run /handoff.`,
              },
            ],
            details: { queued: false, reason: "below-floor", contextPercent: percent },
          };
        }
        pendingAuto = { source: "agent", focus: params.focus, reason: params.reason };
        const usageLine =
          typeof percent === "number" && typeof usage?.tokens === "number" && usage.contextWindow
            ? ` Context at queue time: ${Math.round(percent)}% (${formatK(usage.tokens)}/${formatK(usage.contextWindow)} tokens).`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Handoff queued.${usageLine} Once this turn ends, this session will be handed to a new pi session (a handoff document is written first, then the new session starts with it loaded). Stop working now — do not call other tools or start new work.`,
            },
          ],
          details: { queued: true, source: "agent", focus: params.focus, reason: params.reason, contextPercent: percent },
          terminate: true, // stop the run so agent_settled fires and can dispatch
        };
      },
    });
  }

  /**
   * Dispatch point for automatic handoffs. Fires after every fully settled
   * run: (1) checks the opt-in token threshold, (2) if a handoff is pending
   * (agent tool or threshold), re-enters the normal /handoff flow via
   * sendUserMessage with expandPromptTemplates — pi dispatches that text as
   * the registered command, which is the only code path with access to
   * newSession(). The --auto marker labels the handoff as automatic so the
   * receiving agent is told in the kickoff.
   */
  pi.on("agent_settled", async (_event, ctx) => {
    // Token-threshold trigger (opt-in). Context usage is null right after
    // compaction (until the next LLM response), so a just-compacted session
    // is skipped naturally.
    if (!pendingAuto && Date.now() >= autoHandoffCooldownUntil) {
      const settings = getAutoHandoffSettings(loadConfig(ctx.cwd));
      const tokens = ctx.getContextUsage()?.tokens;
      if (
        settings.thresholdTokens > 0 &&
        typeof tokens === "number" &&
        tokens >= settings.thresholdTokens
      ) {
        pendingAuto = { source: "threshold" };
      }
    }
    if (!pendingAuto) return;
    // Don't drop the handoff while user messages are queued; retry on the
    // next settle instead.
    if (ctx.hasPendingMessages()) return;
    if (!HANDOFF_MODES.has(ctx.mode)) {
      pendingAuto = undefined;
      console.error(`[handoff] Automatic handoff skipped: requires interactive mode (TUI or RPC), got "${ctx.mode}".`);
      return;
    }
    const { source, focus, reason } = pendingAuto;
    pendingAuto = undefined;
    lastAutoReason = reason;
    autoHandoffCooldownUntil = Date.now() + AUTO_HANDOFF_COOLDOWN_MS;
    ctx.ui.notify(
      [
        `Automatic handoff — ${
          source === "agent" ? "requested by the agent" : "context crossed the configured token threshold"
        }.`,
        "A handoff document will be written, then a new pi session will start with it loaded.",
      ].join("\n"),
      "info",
    );
    dispatchCommand(pi, buildAutoHandoffCommand(source, focus));
  });

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
      const { action, focus, count, target, autoSource } = parseHandoffArgs(args ?? "");
      // Only auto dispatches carry a reason; a user-typed /handoff never
      // reads (or clobbers) the pending one.
      const autoReason = autoSource ? consumeAutoReason() : undefined;
      const config = loadConfig(ctx.cwd);
      const dir = getHandoffDir(ctx.cwd, config);

      if (action === "status") {
        const files = listMarkdownFiles(dir);
        const auto = getAutoHandoffSettings(config);
        ctx.ui.notify(
          [
            `Handoff dir: ${dir}`,
            `Files: ${files.length}`,
            files.length > 0 ? `Newest: ${basename(files[0])}` : "",
            `Auto handoff: tool ${auto.tool ? "on" : "off"}; threshold ${
              auto.thresholdTokens > 0 ? `${auto.thresholdTokens} tokens` : "off"
            }; agent-initiated floor ${auto.minContextPercent > 0 ? `${auto.minContextPercent}%` : "off"}`,
            'Change with "dir" / "autoHandoff" in ~/.pi/agent/handoff.json / .pi/handoff.json, or PI_HANDOFF_DIR.',
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
          autoSource ? `Trigger: automatic — ${describeAutoSource(autoSource)}` : "",
          `Handoff → ${file}`,
          action === "write" ? "Writing handoff only — no new session will be started." : "After the handoff is written, a new pi session will start with it loaded.",
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );

      const wrote = await generateHandoff(ctx, file, focus, autoSource, autoReason);
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
          ctx.ui.notify(
            `New session started — handoff loaded from ${file}${autoSource ? " (automatic handoff)" : ""}`,
            "info",
          );
          await ctx.sendUserMessage(buildKickoff(file, autoSource, autoReason));
        },
      });
      if (result.cancelled) {
        // Cancelled before replacement — the old session is still active.
        ctx.ui.notify(`New session cancelled — handoff kept at ${file}. Run /handoff again to retry.`, "info");
      }
    },
  });
}
