/**
 * Handoff helpers: config loading, handoff file path resolution, argument
 * parsing, and the prompts used to generate the handoff and to kick off
 * the continuation session.
 *
 * Handoff files deliberately live OUTSIDE the project (default:
 * `~/.pi/agent/handoffs/`), so projects don't accumulate markdown files.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE = "handoff.json";
export const DEFAULT_HANDOFF_DIR = "handoffs"; // relative to the pi agent dir

export interface HandoffConfig {
  /** Directory for handoff files. Default: <agent dir>/handoffs. */
  dir?: string;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/** Expand a leading `~` to the home directory (configs may use it). */
export function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const home = process.env.HOME;
    if (home) return join(home, p.slice(2));
  }
  return p;
}

/**
 * Load the handoff config: global (`~/.pi/agent/handoff.json`) merged with
 * project (`.pi/handoff.json`); the project wins. The PI_HANDOFF_DIR env
 * var overrides everything.
 */
export function loadConfig(cwd: string): HandoffConfig {
  const merged: HandoffConfig = {};
  const paths = [join(getAgentDir(), CONFIG_FILE), join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as HandoffConfig;
      Object.assign(merged, parsed);
    } catch (e) {
      console.error(`[handoff] Could not parse ${p}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (process.env.PI_HANDOFF_DIR) merged.dir = process.env.PI_HANDOFF_DIR;
  return merged;
}

/** Effective handoff directory for a project (never inside the project). */
export function getHandoffDir(cwd: string, config: HandoffConfig): string {
  if (config.dir) {
    const expanded = expandHome(config.dir);
    // Relative dirs resolve against the agent dir, not the project.
    return isAbsolute(expanded) ? expanded : join(getAgentDir(), expanded);
  }
  return join(getAgentDir(), DEFAULT_HANDOFF_DIR);
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

/** Slugify free text for filenames: lowercase, dashes, ≤ max chars. */
export function slugify(input: string, max = 48): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "handoff";
}

/** Sanitized project name (cwd basename) for handoff filenames. */
export function projectName(cwd: string): string {
  const base = basename(resolve(cwd));
  if (!base || base === "/" || base === ".") return "session";
  return slugify(base, 40);
}

/** Local timestamp like `2026-08-13_19-45-30` (sortable, readable). */
export function formatTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Handoff file name: `<project>-<timestamp>.md`, plus a slug from the
 * focus when one was given.
 */
export function buildHandoffFileName(cwd: string, focus: string | undefined): string {
  const base = `${projectName(cwd)}-${formatTimestamp()}`;
  const f = focus?.trim();
  return f ? `${base}-${slugify(f)}.md` : `${base}.md`;
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

export type HandoffAction = "handoff" | "write" | "list" | "open" | "status";

export interface HandoffArgs {
  action: HandoffAction;
  /** Free-text focus ("" for write/handoff means: derive automatically). */
  focus?: string;
  /** list: how many files to show (default 10). */
  count: number;
  /** open: 1-based index into newest-first list, or a path. */
  target?: string;
}

function parseIntArg(rest: string, fallback: number): number {
  const n = Number.parseInt(rest, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse `/handoff` arguments. A leading subcommand (`write`, `list`,
 * `open`, `status`) is consumed; anything else is the focus text.
 */
export function parseHandoffArgs(raw: string): HandoffArgs {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/);
  const first = parts[0]?.toLowerCase();
  const rest = parts.slice(1).join(" ").trim();
  if (first === "write") return { action: "write", focus: rest || undefined, count: 10 };
  if (first === "list") return { action: "list", count: parseIntArg(rest, 10), focus: undefined };
  if (first === "open") {
    return {
      action: "open",
      target: rest || undefined,
      count: 10,
      focus: undefined,
    };
  }
  if (first === "status") return { action: "status", count: 10, focus: undefined };
  return { action: "handoff", focus: trimmed || undefined, count: 10 };
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

/**
 * The handoff-generation prompt. Sent to the current agent as a follow-up
 * turn: it reflects on the conversation (what's outstanding / not done /
 * worth taking forward) and writes the handoff file with its write tool.
 */
export function buildHandoffPrompt(opts: {
  cwd: string;
  project: string;
  focus: string | undefined;
  file: string;
}): string {
  const focusLine = opts.focus?.trim()
    ? `Focus: ${opts.focus.trim()}`
    : "Focus: (none given — derive it from this conversation: what was left outstanding, what is not yet done, and what select information is worth taking forward)";
  return [
    "[HANDOFF GENERATION]",
    "You are handing this session over to a brand-new pi session that has NO memory of this conversation. Write a handoff document that lets the continuation session keep this work moving.",
    "",
    `Project: ${opts.project} (working directory: ${opts.cwd})`,
    focusLine,
    `Handoff file: ${opts.file}`,
    "",
    "Base the handoff on everything in this session's conversation so far.",
    "",
    "Create the file at exactly that path with your write tool. The document is the ONLY thing the continuation session will know about this work, so it must stand completely alone.",
    "",
    "Use this structure:",
    "# Handoff — <one-line title>",
    "",
    "## Focus",
    "What this work is trying to achieve and what the continuation session should concentrate on.",
    "",
    "## Current state",
    "What has been done so far and what exists now — files, branches, services, decisions already made.",
    "",
    "## Outstanding",
    "What is NOT done, in priority order: loose ends, unfinished items, open questions.",
    "",
    "## Key context",
    "Select information worth taking forward: constraints, gotchas, important paths and commands, technical terms, references.",
    "",
    "## Next steps",
    "Concrete first actions for the continuation session, in order.",
    "",
    "Guidelines:",
    '- Write for a reader with zero memory of this conversation: no "as discussed", no unexplained shorthand.',
    "- Be concrete: exact file paths, commands, terms, and numbers.",
    "- Be selective: take forward what matters, leave settled detail behind. A handoff is a map, not a transcript.",
    "- Keep it tight — aim for a page or less unless the work genuinely needs more.",
    `- Use your write tool with exactly this path: ${opts.file} (the directory already exists).`,
    "- If you cannot write to this path (e.g. restricted tools), reply with ONE line explaining why — do not improvise a different location.",
    "- When done, reply with ONE line: the path and a one-sentence summary of what the handoff covers. Do not paste the document into your reply.",
  ].join("\n");
}

/**
 * The kickoff message for the continuation session. The full handoff
 * content is embedded in the session's first user message (via
 * `newSession` setup); this message tells the fresh agent what to do with
 * it.
 */
export function buildKickoff(file: string): string {
  return [
    "You are continuing work handed off from a previous pi session.",
    "",
    "The handoff document is included in the message above — read it carefully before doing anything else. It describes what the work is, what has been done, what is still outstanding, and the next steps.",
    "",
    `Handoff file (for reference): ${file}`,
    "",
    "Start by orienting yourself (the handoff's Key context and Next steps sections), then work through the outstanding items in order. If something in the handoff is ambiguous, explore the project to resolve it before asking.",
  ].join("\n");
}
