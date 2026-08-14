import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHandoffFileName,
  buildHandoffPrompt,
  buildKickoff,
  expandHome,
  getHandoffDir,
  loadConfig,
  parseHandoffArgs,
  projectName,
  slugify,
} from "../utils.ts";

test("slugify: basic text", () => {
  assert.equal(slugify("Fix the parser bug!"), "fix-the-parser-bug");
});

test("slugify: empty input falls back to 'handoff'", () => {
  assert.equal(slugify(""), "handoff");
  assert.equal(slugify("   "), "handoff");
  assert.equal(slugify("!!!"), "handoff");
});

test("slugify: truncates to max and strips trailing dashes", () => {
  const s = slugify("a very long focus about refactoring the event system into modules", 48);
  assert.ok(s.length <= 48);
  assert.ok(!s.endsWith("-"));
  assert.equal(slugify("fix"), "fix"); // short input unaffected
});

test("slugify: strips punctuation and unicode", () => {
  assert.equal(slugify("Payments API — webhook retries"), "payments-api-webhook-retries");
  // Accented letters fall outside [a-z0-9], so they collapse into dashes.
  assert.equal(slugify("héllo wörld"), "h-llo-w-rld");
});

test("projectName: basename of cwd, sanitized", () => {
  assert.equal(projectName("/home/user/My-Project"), "my-project");
  assert.equal(projectName("/home/user/pi-plan-ng"), "pi-plan-ng");
  assert.equal(projectName("/"), "session");
});

test("buildHandoffFileName: project + timestamp, slug only when focus given", () => {
  const withFocus = buildHandoffFileName("/home/user/My-Project", "Fix the parser");
  assert.ok(withFocus.startsWith("my-project-"));
  assert.ok(withFocus.endsWith("-fix-the-parser.md"));
  assert.match(withFocus, /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);

  const without = buildHandoffFileName("/home/user/My-Project", undefined);
  assert.ok(without.startsWith("my-project-"));
  assert.ok(without.endsWith(".md"));
  assert.ok(!without.includes("handoff"));
});

test("parseHandoffArgs: bare /handoff derives focus", () => {
  assert.deepEqual(parseHandoffArgs(""), { action: "handoff", focus: undefined, count: 10 });
  assert.deepEqual(parseHandoffArgs("   "), { action: "handoff", focus: undefined, count: 10 });
});

test("parseHandoffArgs: free text is the focus", () => {
  const a = parseHandoffArgs("fix the parser bug");
  assert.equal(a.action, "handoff");
  assert.equal(a.focus, "fix the parser bug");
});

test("parseHandoffArgs: subcommands", () => {
  assert.deepEqual(parseHandoffArgs("write"), { action: "write", focus: undefined, count: 10 });
  assert.deepEqual(parseHandoffArgs("write fix the bug"), {
    action: "write",
    focus: "fix the bug",
    count: 10,
  });
  assert.deepEqual(parseHandoffArgs("list"), { action: "list", count: 10, focus: undefined });
  assert.deepEqual(parseHandoffArgs("list 5"), { action: "list", count: 5, focus: undefined });
  assert.deepEqual(parseHandoffArgs("list 0"), { action: "list", count: 10, focus: undefined });
  assert.deepEqual(parseHandoffArgs("open"), {
    action: "open",
    target: undefined,
    count: 10,
    focus: undefined,
  });
  assert.deepEqual(parseHandoffArgs("open 3"), {
    action: "open",
    target: "3",
    count: 10,
    focus: undefined,
  });
  assert.deepEqual(parseHandoffArgs("status"), { action: "status", count: 10, focus: undefined });
});

test("expandHome: tilde expansion", () => {
  const home = process.env.HOME;
  assert.ok(home, "HOME must be set for this test");
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("~/handoffs"), join(home, "handoffs"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("relative/path"), "relative/path");
});

test("getHandoffDir: defaults outside the project, config can override", () => {
  const tmp = mkdtempSync(join(tmpdir(), "handoff-test-"));
  try {
    const defaultDir = getHandoffDir(tmp, {});
    assert.ok(defaultDir.startsWith(process.env.HOME ?? "/"));
    assert.ok(defaultDir.endsWith("handoffs"));
    assert.ok(!defaultDir.startsWith(tmp), "handoff dir must not be inside the project");

    const custom = getHandoffDir(tmp, { dir: "~/custom-handoffs" });
    assert.equal(custom, join(process.env.HOME!, "custom-handoffs"));

    // Relative dirs resolve against the agent dir, never the project.
    const relative = getHandoffDir(tmp, { dir: "scratch/handoffs" });
    assert.ok(relative.endsWith("scratch/handoffs"));
    assert.ok(!relative.startsWith(tmp), "relative dir must not resolve into the project");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: project config applies, env overrides, malformed ignored", () => {
  const tmp = mkdtempSync(join(tmpdir(), "handoff-config-"));
  const projectDir = join(tmp, ".pi");
  const oldEnv = process.env.PI_HANDOFF_DIR;
  delete process.env.PI_HANDOFF_DIR;

  try {
    // No config anywhere: never throws, returns an object.
    assert.deepEqual(loadConfig(tmp), {});

    // Project config applies (project wins over any global config).
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "handoff.json"), JSON.stringify({ dir: "/tmp/proj-handoffs" }));
    assert.equal(loadConfig(tmp).dir, "/tmp/proj-handoffs");

    // PI_HANDOFF_DIR overrides the project config.
    process.env.PI_HANDOFF_DIR = "/tmp/env-handoffs";
    assert.equal(loadConfig(tmp).dir, "/tmp/env-handoffs");
    delete process.env.PI_HANDOFF_DIR;

    // Malformed config is ignored without throwing.
    writeFileSync(join(projectDir, "handoff.json"), "{ not json");
    assert.equal(typeof loadConfig(tmp), "object");
  } finally {
    if (oldEnv === undefined) delete process.env.PI_HANDOFF_DIR;
    else process.env.PI_HANDOFF_DIR = oldEnv;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildHandoffPrompt: includes focus, path, and write-tool instruction", () => {
  const p = buildHandoffPrompt({
    cwd: "/home/user/proj",
    project: "proj",
    focus: "ship the fix",
    file: "/home/user/.pi/agent/handoffs/proj-2026-08-13_19-45-30-ship-the-fix.md",
  });
  assert.ok(p.includes("Focus: ship the fix"));
  assert.ok(p.includes("write tool with exactly this path: /home/user/.pi/agent/handoffs/proj-2026-08-13_19-45-30-ship-the-fix.md"));
  assert.ok(p.includes("## Next steps"));
  assert.ok(p.includes("NO memory of this conversation"));
});

test("buildHandoffPrompt: no focus → derive-instruction", () => {
  const p = buildHandoffPrompt({
    cwd: "/home/user/proj",
    project: "proj",
    focus: undefined,
    file: "/x.md",
  });
  assert.ok(p.includes("Focus: (none given"));
  assert.ok(p.includes("what was left outstanding"));
});

test("buildKickoff: references the handoff file", () => {
  const k = buildKickoff("/home/user/.pi/agent/handoffs/proj.md");
  assert.ok(k.includes("Handoff file (for reference): /home/user/.pi/agent/handoffs/proj.md"));
  assert.ok(k.includes("read it carefully"));
});
