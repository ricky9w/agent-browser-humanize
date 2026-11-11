import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowserMonitor, describeCheck, locateAgentBrowser } from "../src/agent-browser-check.ts";
import { FOCUS_SOURCE, SCROLL_ELEMENT_SOURCE } from "../src/recognize.ts";

const root = mkdtempSync(join(tmpdir(), "abh-check-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const newDir = () => {
  const dir = join(root, String(dirs++));
  mkdirSync(dir);
  return dir;
};

// The clear function as `type --clear` embeds it, indented differently from CLEAR_SOURCE.
const typeClear = `function() {
                        this.select && this.select();
                        this.value = '';
                        this.dispatchEvent(new Event('input', { bubbles: true }));
                    }`;
// What Rust's format!("window.scrollBy({}, {})", ..) leaves contiguous in the binary.
const windowScroll = "window.scrollBy(";
const ALL = [FOCUS_SOURCE, typeClear, SCROLL_ELEMENT_SOURCE, windowScroll];

/** An executable stand-in for the binary: a shell script that prints a version, then binary bytes and the given strings. */
function fakeBinary(path: string, sources: string[], version = "0.42.0") {
  const script = Buffer.from(`#!/bin/sh\necho "agent-browser ${version}"\nexit 0\n`);
  const junk = Buffer.from([0, 0xcf, 0xfa, 0xed, 0xfe, 0x80, 0xff, 0]);
  writeFileSync(path, Buffer.concat([script, ...sources.flatMap((s) => [junk, Buffer.from(s, "latin1")]), junk]), { mode: 0o755 });
  return realpathSync(path);
}

const monitor = (env: Record<string, string>) => {
  const lines: string[] = [];
  return { lines, m: new AgentBrowserMonitor((line) => lines.push(line), env) };
};

describe("agent-browser self-check", () => {
  test("all sources present, the clear function with different indentation", async () => {
    const path = fakeBinary(join(newDir(), "agent-browser"), ALL);
    const { m, lines } = monitor({ AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: path });
    expect(await m.status()).toEqual({ path, version: "0.42.0", recognizers: { focus: true, clear: true, scrollElement: true, scrollWindow: true } });
    expect(lines).toEqual([`agent-browser 0.42.0 at ${path}: all 4 recognized page functions found`]);
  });

  test("some missing: a warning names them and what falls back", async () => {
    const path = fakeBinary(join(newDir(), "agent-browser"), ["function() { this.focus({ preventScroll: true }); }", typeClear, "window.scrollTo("], "0.42.0");
    const { m, lines } = monitor({ AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: path });
    expect(((await m.status()) as any).recognizers).toEqual({ focus: false, clear: true, scrollElement: false, scrollWindow: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`WARNING agent-browser 0.42.0 at ${path}: page functions not found: focus, scrollElement, scrollWindow;`);
    expect(lines[0]).toContain("focusing fields (fill, type, focus), scroll --selector, scroll");
  });

  test("an npm JS shim on PATH resolves to the native sibling binary", async () => {
    const dir = newDir();
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "agent-browser.js"), "#!/usr/bin/env node\nconsole.log('shim');\n", { mode: 0o755 });
    symlinkSync("../lib/agent-browser.js", join(dir, "bin", "agent-browser"));
    const native = fakeBinary(join(dir, "lib", `agent-browser-${process.platform}-${process.arch}`), ALL);
    expect(await locateAgentBrowser({ PATH: `${newDir()}:${join(dir, "bin")}` })).toBe(native);
    const { m } = monitor({ PATH: join(dir, "bin") });
    expect(await m.status()).toMatchObject({ path: native, version: "0.42.0" });
  });

  test("a symlink to the native binary resolves to it", async () => {
    const dir = newDir();
    const native = fakeBinary(join(dir, "agent-browser-native"), ALL);
    symlinkSync(native, join(dir, "agent-browser"));
    expect(await locateAgentBrowser({ PATH: dir })).toBe(native);
  });

  test("not found: on PATH or at AGENT_BROWSER_HUMANIZE_AGENT_BROWSER", async () => {
    const empty = monitor({ PATH: newDir() });
    expect(await empty.m.status()).toEqual({ error: "agent-browser not found on PATH" });
    expect(empty.lines).toEqual([describeCheck({ error: "agent-browser not found on PATH" })]);
    expect(empty.lines[0]).toStartWith("WARNING ");
    const missing = join(newDir(), "nope");
    expect(await monitor({ AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: missing }).m.status()).toEqual({ error: `agent-browser not found at ${missing}` });
  });

  test("re-checks only when the binary's size or mtime changed; logs once per check", async () => {
    const file = join(newDir(), "agent-browser");
    const path = fakeBinary(file, ALL);
    const { m, lines } = monitor({ AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: file });
    await m.status();
    await m.refresh();
    await m.status();
    expect(lines).toHaveLength(1);
    fakeBinary(file, [FOCUS_SOURCE], "0.43.0");
    expect(((await m.status()) as any).recognizers).toEqual({ focus: true, clear: false, scrollElement: false, scrollWindow: false });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith(`WARNING agent-browser 0.43.0 at ${path}:`);
    rmSync(file);
    expect(await m.status()).toEqual({ error: `agent-browser not found at ${file}` });
    await m.status();
    expect(lines).toHaveLength(3);
  });

  test("concurrent refreshes share one check", async () => {
    const path = fakeBinary(join(newDir(), "agent-browser"), ALL);
    const { m, lines } = monitor({ AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: path });
    await Promise.all([m.refresh(), m.refresh(), m.status()]);
    expect(lines).toHaveLength(1);
  });
});
