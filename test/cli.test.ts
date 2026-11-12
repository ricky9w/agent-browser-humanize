import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowserMonitor } from "../src/agent-browser-check.ts";
import { DEFAULT_PORT, DEFAULT_UPSTREAM, USAGE, agentBrowserConfig, localPort, namespaceOf, proxyPort, sanitizeNamespace, serveConfig } from "../src/cli.ts";
import { sessionDir } from "../src/sessions.ts";
import { Humanizer } from "../src/humanize.ts";
import { TYPING_CPS } from "../src/keyboard.ts";
import { VERSION } from "../src/version.ts";
import { startProxy } from "../src/server.ts";
import { fakeClock } from "./helpers.ts";

// The command as installed: the entry in bin/, which runs main() from src/cli.ts.
const CLI = join(import.meta.dir, "../bin/agent-browser-humanize");
const dir = mkdtempSync(join(tmpdir(), "abh-cli-"));
// A Chrome with no tabs, and a proxy in front of it.
const chrome = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json([]) });
const upstream = `127.0.0.1:${chrome.port}`;
const agentBrowser = new AgentBrowserMonitor(() => {}, { AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: "/nonexistent/agent-browser" });
const { server } = startProxy({ port: 0, upstream, humanizer: new Humanizer(fakeClock()), agentBrowser });
afterAll(() => {
  server.stop(true);
  chrome.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The environment without this project's settings or agent-browser's CDP endpoint, with agent-browser's session files
 * in a directory of the test and its config file absent.
 */
const baseEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_CONFIG: join(dir, "none.json"), ...extra };
  for (const name of Object.keys(env)) if ((name.startsWith("AGENT_BROWSER_HUMANIZE_") || name === "AGENT_BROWSER_CDP") && !(name in extra)) delete env[name];
  return env;
};
const spawn = (args: string[], extra?: Record<string, string>) =>
  Bun.spawn([process.execPath, CLI, ...args], { env: baseEnv(extra), stdout: "pipe", stderr: "pipe" });
async function cli(args: string[], extra?: Record<string, string>) {
  const p = spawn(args, extra);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}
const bind = (session: string, targetId: string) => writeFileSync(join(dir, `${session}.target`), JSON.stringify({ targetId, url: "about:blank", pinned: true }));

describe("serve settings", () => {
  test("defaults: port 9333, Chrome on 127.0.0.1:9222, 9 chars/s", () => {
    expect(serveConfig([], {})).toEqual({ port: 9333, upstream: "127.0.0.1:9222", cps: TYPING_CPS });
    expect([DEFAULT_PORT, DEFAULT_UPSTREAM, TYPING_CPS]).toEqual([9333, "127.0.0.1:9222", 9]);
  });

  test("environment variables, empty ones ignored", () => {
    const env = { AGENT_BROWSER_HUMANIZE_PORT: "9400", AGENT_BROWSER_HUMANIZE_UPSTREAM: "localhost:9223", AGENT_BROWSER_HUMANIZE_CPS: "6.5" };
    expect(serveConfig([], env)).toEqual({ port: 9400, upstream: "localhost:9223", cps: 6.5 });
    expect(serveConfig([], { AGENT_BROWSER_HUMANIZE_PORT: "", AGENT_BROWSER_HUMANIZE_UPSTREAM: "", AGENT_BROWSER_HUMANIZE_CPS: "" })).toEqual(serveConfig([], {}));
  });

  test("options win over the environment; port 0 picks a free port", () => {
    const env = { AGENT_BROWSER_HUMANIZE_PORT: "9400", AGENT_BROWSER_HUMANIZE_UPSTREAM: "localhost:9223" };
    expect(serveConfig(["--port", "0", "--upstream", "127.0.0.1:9555"], env)).toMatchObject({ port: 0, upstream: "127.0.0.1:9555" });
    expect(serveConfig(["--port=9401"], env)).toMatchObject({ port: 9401, upstream: "localhost:9223" });
  });

  test("invalid settings are usage errors", () => {
    for (const args of [["--port", "x"], ["--port", "70000"], ["--port", ""], ["--upstream", "9222"], ["--upstream", "http://127.0.0.1:9222"], ["--nope"], ["extra"]]) {
      expect(() => serveConfig(args, {})).toThrow();
    }
    expect(() => serveConfig([], { AGENT_BROWSER_HUMANIZE_CPS: "0" })).toThrow("AGENT_BROWSER_HUMANIZE_CPS");
    expect(() => serveConfig([], { AGENT_BROWSER_HUMANIZE_CPS: "fast" })).toThrow("AGENT_BROWSER_HUMANIZE_CPS");
  });
});

describe("agent-browser's session directory", () => {
  test("AGENT_BROWSER_SOCKET_DIR, then $XDG_RUNTIME_DIR/agent-browser, then ~/.agent-browser", () => {
    expect(sessionDir({ AGENT_BROWSER_SOCKET_DIR: "/s", XDG_RUNTIME_DIR: "/run/user/1" })).toBe("/s");
    expect(sessionDir({ AGENT_BROWSER_SOCKET_DIR: "", XDG_RUNTIME_DIR: "/run/user/1" })).toBe("/run/user/1/agent-browser");
    expect(sessionDir({ XDG_RUNTIME_DIR: "" })).toBe(join(homedir(), ".agent-browser"));
  });
});

describe("the proxy's port for runtime", () => {
  test("agent-browser's cdp forms: a port, host:port or a URL on this machine", () => {
    expect(["9333", "127.0.0.1:9333", "localhost:9333", "http://127.0.0.1:9333", "ws://localhost:9333/devtools/browser/x", "ws://[::1]:9333"].map(localPort)).toEqual(Array(6).fill(9333));
    expect(["", "ws://10.0.0.5:9333", "example.com:9333", "ws://127.0.0.1/devtools", "not a url", undefined, 9333].map(localPort)).toEqual(Array(7).fill(undefined));
  });

  test("AGENT_BROWSER_HUMANIZE_PORT, then AGENT_BROWSER_CDP, then cdp in agent-browser's config file, then the default", async () => {
    const file = join(dir, "port-config.json");
    writeFileSync(file, JSON.stringify({ cdp: "19400" }));
    const config = await agentBrowserConfig({ AGENT_BROWSER_CONFIG: file });
    expect(config).toEqual({ cdp: "19400" });
    expect(proxyPort({ AGENT_BROWSER_HUMANIZE_PORT: "9401", AGENT_BROWSER_CDP: "9402" }, config)).toBe(9401);
    expect(proxyPort({ AGENT_BROWSER_CDP: "ws://127.0.0.1:9402/devtools/browser/x" }, config)).toBe(9402);
    expect(proxyPort({}, config)).toBe(19400);
    expect(proxyPort({}, await agentBrowserConfig({ AGENT_BROWSER_CONFIG: join(dir, "missing.json") }))).toBe(DEFAULT_PORT);
    // agent-browser connects to a remote browser: no local proxy to find.
    expect(proxyPort({ AGENT_BROWSER_CDP: "ws://10.0.0.5:9222" }, config)).toBe(DEFAULT_PORT);
    expect(() => proxyPort({ AGENT_BROWSER_HUMANIZE_PORT: "x" }, {})).toThrow("invalid AGENT_BROWSER_HUMANIZE_PORT: x");
  });
});

describe("agent-browser namespaces", () => {
  test("names become directory names as agent-browser makes them", () => {
    // Cases from agent-browser's own tests (cli/src/validation.rs, connection.rs).
    expect(sanitizeNamespace("Next Dev Loop: /Users/me/worktree!")).toBe("next-dev-loop-users-me-worktree");
    expect(sanitizeNamespace(" --Agent__ ")).toBe("agent");
    expect(sanitizeNamespace("Worktree: One")).toBe("worktree-one");
    expect(sanitizeNamespace("Café-東京_7")).toBe("café-東京_7");
    expect(sanitizeNamespace("a--b__c")).toBe("a-b_c");
    expect(sanitizeNamespace("!!")).toBe("");
  });

  test("--namespace, then AGENT_BROWSER_NAMESPACE (even when empty), then namespace in the config file", () => {
    const config = { namespace: "From Config" };
    expect(namespaceOf("Opt", { AGENT_BROWSER_NAMESPACE: "env" }, config)).toBe("opt");
    expect(namespaceOf(undefined, { AGENT_BROWSER_NAMESPACE: "Env" }, config)).toBe("env");
    expect(namespaceOf(undefined, { AGENT_BROWSER_NAMESPACE: "" }, config)).toBe("");
    expect(namespaceOf(undefined, {}, config)).toBe("from-config");
    expect(namespaceOf(undefined, {}, {})).toBe("");
  });

  test("a namespace's session files are in <dir>/namespaces/<namespace>/run", () => {
    expect(sessionDir({ AGENT_BROWSER_SOCKET_DIR: "/s" }, "proj-a")).toBe("/s/namespaces/proj-a/run");
    expect(sessionDir({ AGENT_BROWSER_SOCKET_DIR: "/s" }, "")).toBe("/s");
  });
});

describe("command line", () => {
  test("no command, an unknown one or wrong arguments print the usage and exit 2", async () => {
    for (const args of [[], ["proxy"], ["serve", "--nope"], ["serve", "--port", "x"], ["runtime"], ["runtime", "on"], ["runtime", "maybe", "s"], ["runtime", "on", "s", "extra"]]) {
      const { code, stderr, stdout } = await cli(args);
      expect({ args, code }).toEqual({ args, code: 2 });
      expect(stderr).toEndWith(USAGE);
      expect(stdout).toBe("");
    }
    expect((await cli(["proxy"])).stderr).toStartWith("agent-browser-humanize: unknown command: proxy\n");
  });

  test("--help prints the usage and exits 0", async () => {
    expect(await cli(["--help"])).toEqual({ stdout: USAGE, stderr: "", code: 0 });
  });

  test("--version prints the version in package.json", async () => {
    const { version } = await Bun.file(join(import.meta.dir, "../package.json")).json();
    expect(await cli(["--version"])).toEqual({ stdout: version, stderr: "", code: 0 });
  });

  test("serve listens, reports health on the control API, and names the port it got", async () => {
    const p = spawn(["serve", "--port", "0", "--upstream", upstream], { AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: "/nonexistent/agent-browser" });
    try {
      let out = "";
      const decoder = new TextDecoder();
      const reader = p.stdout.getReader();
      while (!/listening on 127\.0\.0\.1:\d+/.test(out)) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
      const listening = /listening on 127\.0\.0\.1:(\d+), upstream ([^,]+), typing 9 chars\/s/.exec(out);
      expect(listening?.[2]).toBe(upstream);
      const health = (await (await fetch(`http://127.0.0.1:${listening![1]}/__humanize/health`)).json()) as any;
      expect(health).toMatchObject({ ok: true, version: VERSION, upstream: true, connections: 0, agentBrowser: { error: "agent-browser not found at /nonexistent/agent-browser" } });
    } finally {
      p.kill();
      await p.exited;
    }
  });

  test("serve on a port in use exits 1 with one line", async () => {
    expect(await cli(["serve", "--port", String(server.port), "--upstream", upstream])).toEqual({
      stdout: "",
      stderr: `agent-browser-humanize: cannot listen on 127.0.0.1:${server.port} (EADDRINUSE)`,
      code: 1,
    });
  });

  test("runtime calls the control API with the session's pinned tab", async () => {
    bind("abh-s", "T1");
    const env = { AGENT_BROWSER_HUMANIZE_PORT: String(server.port) };
    expect(await cli(["runtime", "off", "abh-s"], env)).toEqual({ stdout: "Runtime off for abh-s: turned off in 0 tabs", stderr: "", code: 0 });
    expect(await cli(["runtime", "off"], { ...env, AGENT_BROWSER_SESSION: "abh-s" })).toEqual({ stdout: "Runtime off for abh-s: turned off in 0 tabs", stderr: "", code: 0 });
    expect(await cli(["runtime", "on", "abh-s"], env)).toEqual({ stdout: "", stderr: "agent-browser-humanize: the tab is gone (session abh-s, tab T1)", code: 1 });
  });

  test("runtime finds the proxy where agent-browser connects: AGENT_BROWSER_CDP, then its config file", async () => {
    bind("abh-cdp", "T1");
    const ok = { stdout: "Runtime off for abh-cdp: turned off in 0 tabs", stderr: "", code: 0 };
    expect(await cli(["runtime", "off", "abh-cdp"], { AGENT_BROWSER_CDP: String(server.port) })).toEqual(ok);
    const config = join(dir, "agent-browser.json");
    writeFileSync(config, JSON.stringify({ cdp: `ws://127.0.0.1:${server.port}/devtools/browser/x`, pinTab: true }));
    expect(await cli(["runtime", "off", "abh-cdp"], { AGENT_BROWSER_CONFIG: config })).toEqual(ok);
  });

  test("runtime reads the binding of the session's namespace: --namespace or AGENT_BROWSER_NAMESPACE", async () => {
    mkdirSync(join(dir, "namespaces", "proj-a", "run"), { recursive: true });
    writeFileSync(join(dir, "namespaces", "proj-a", "run", "abh-ns.target"), JSON.stringify({ targetId: "T1", url: "about:blank", pinned: true }));
    const env = { AGENT_BROWSER_HUMANIZE_PORT: String(server.port) };
    const ok = { stdout: "Runtime off for abh-ns (namespace proj-a): turned off in 0 tabs", stderr: "", code: 0 };
    expect(await cli(["runtime", "off", "--namespace", "Proj A", "abh-ns"], env)).toEqual(ok);
    expect(await cli(["runtime", "off", "abh-ns"], { ...env, AGENT_BROWSER_NAMESPACE: "proj-a" })).toEqual(ok);
    // Without the namespace, the session is not found: its binding is not in the shared directory.
    expect(await cli(["runtime", "off", "abh-ns"], env)).toMatchObject({ stderr: expect.stringMatching(/^agent-browser-humanize: session abh-ns has no pinned tab/), code: 1 });
  });

  test("runtime fails with exit 1 and one line: no binding, bad session name, proxy not running", async () => {
    expect(await cli(["runtime", "on", "abh-none"])).toMatchObject({ stderr: expect.stringMatching(/^agent-browser-humanize: session abh-none has no pinned tab \(.*abh-none\.target is missing or unreadable\)$/), code: 1 });
    expect(await cli(["runtime", "on", "../x"])).toEqual({ stdout: "", stderr: "agent-browser-humanize: invalid session name: ../x", code: 1 });
    bind("abh-down", "T1");
    expect(await cli(["runtime", "on", "abh-down"], { AGENT_BROWSER_HUMANIZE_PORT: "1" })).toEqual({ stdout: "", stderr: "agent-browser-humanize: the proxy is not running on 127.0.0.1:1", code: 1 });
  });
});
