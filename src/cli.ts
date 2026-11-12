#!/usr/bin/env bun
// The agent-browser-humanize command. `serve` runs the proxy; `runtime on|off <session>` turns the CDP Runtime domain
// on for an agent-browser session's pinned tab, so `agent-browser console` and `errors` see the page's messages
// (earlier ones included), or off again on every tab the session turned it on for.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AgentBrowserMonitor } from "./agent-browser-check.ts";
import { Humanizer } from "./humanize.ts";
import { TYPING_CPS } from "./keyboard.ts";
import { macOSBrowser } from "./platform.ts";
import { SESSION_NAME, startProxy } from "./server.ts";
import { sessionDir, type Env } from "./sessions.ts";
import { snapshot } from "./stats.ts";

export const DEFAULT_PORT = 9333;
/** Chrome's usual remote debugging port. */
export const DEFAULT_UPSTREAM = "127.0.0.1:9222";
export const USAGE = `usage: agent-browser-humanize serve [--port <port>] [--upstream <host:port>]
       agent-browser-humanize runtime on|off [--namespace <name>] <session>`;

/** Wrong arguments: exit 2 with the usage. */
class UsageError extends Error {}
/** The command could not do its work: exit 1 with the reason. */
class Failure extends Error {}

export interface ServeConfig {
  port: number;
  upstream: string;
  cps: number;
}

/** The proxy's settings from `serve`'s options, then the environment, then the defaults. */
export function serveConfig(args: string[], env: Env = process.env): ServeConfig {
  let values: { port?: string; upstream?: string };
  try {
    ({ values } = parseArgs({ args, options: { port: { type: "string" }, upstream: { type: "string" } } }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const port = values.port ?? (env.AGENT_BROWSER_HUMANIZE_PORT || String(DEFAULT_PORT));
  const upstream = values.upstream ?? (env.AGENT_BROWSER_HUMANIZE_UPSTREAM || DEFAULT_UPSTREAM);
  const cps = Number(env.AGENT_BROWSER_HUMANIZE_CPS || TYPING_CPS);
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new UsageError(`invalid port: ${port}`);
  if (!/^[\w.-]+:\d{1,5}$/.test(upstream)) throw new UsageError(`invalid upstream, expected host:port: ${upstream}`);
  if (!(cps > 0 && Number.isFinite(cps))) throw new UsageError("AGENT_BROWSER_HUMANIZE_CPS must be a positive number");
  return { port: Number(port), upstream, cps };
}

/** agent-browser's user config file, `{}` when there is none. `AGENT_BROWSER_CONFIG` replaces it, as in agent-browser. */
export async function agentBrowserConfig(env: Env = process.env): Promise<Record<string, unknown>> {
  const file = env.AGENT_BROWSER_CONFIG || join(homedir(), ".agent-browser", "config.json");
  const config = await Bun.file(file).json().catch(() => undefined);
  return config && typeof config === "object" ? config : {};
}

/** An agent-browser namespace as agent-browser turns it into a directory name (`sanitize_session_component`). */
export function sanitizeNamespace(value: string): string {
  let out = "";
  for (const c of value) {
    const separator = out === "" || /[-_]$/.test(out);
    if (/[\p{Alphabetic}\p{N}]/u.test(c)) out += c.toLowerCase();
    else if (!separator) out += c === "-" || c === "_" ? c : "-";
  }
  return out.replace(/[-_]+$/, "");
}

/**
 * The agent-browser namespace of a session, as agent-browser picks it: `--namespace`, then `AGENT_BROWSER_NAMESPACE`
 * (even when empty), then `namespace` in its config file. Empty means none.
 */
export function namespaceOf(option: string | undefined, env: Env, config: Record<string, unknown>): string {
  const value = option ?? env.AGENT_BROWSER_NAMESPACE ?? config.namespace;
  return typeof value === "string" ? sanitizeNamespace(value) : "";
}

/** The port of a CDP endpoint on this machine, as agent-browser's `cdp` takes it: `9333`, `host:9333` or a URL. */
export function localPort(cdp: unknown): number | undefined {
  if (typeof cdp !== "string" || !cdp) return undefined;
  if (/^\d{1,5}$/.test(cdp)) return Number(cdp);
  try {
    const url = new URL(/^[a-z][a-z+.-]*:\/\//i.test(cdp) ? cdp : `http://${cdp}`);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port ? Number(url.port) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The proxy's port for `runtime`: `AGENT_BROWSER_HUMANIZE_PORT`, else the local port agent-browser itself connects to
 * (`AGENT_BROWSER_CDP`, then `cdp` in its config file), else the default.
 */
export function proxyPort(env: Env, config: Record<string, unknown>): number {
  const own = env.AGENT_BROWSER_HUMANIZE_PORT;
  if (own) {
    if (!/^\d{1,5}$/.test(own)) throw new Failure(`invalid AGENT_BROWSER_HUMANIZE_PORT: ${own}`);
    return Number(own);
  }
  // Like agent-browser: the environment overrides the config file.
  return localPort(env.AGENT_BROWSER_CDP || config.cdp) ?? DEFAULT_PORT;
}

function serve({ port, upstream, cps }: ServeConfig) {
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const clock = { now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms), random: Math.random };
  const humanizer = new Humanizer(clock, { cps, macOS: macOSBrowser(upstream) });
  const agentBrowser = new AgentBrowserMonitor(log);
  let server: ReturnType<typeof startProxy>["server"];
  try {
    ({ server } = startProxy({ port, upstream, humanizer, agentBrowser, log }));
  } catch (error) {
    throw new Failure(`cannot listen on 127.0.0.1:${port} (${(error as { code?: string }).code ?? (error as Error).message})`);
  }
  let last = "";
  setInterval(() => {
    const line = JSON.stringify(snapshot());
    if (line !== last) log(`stats ${(last = line)}`);
  }, 60_000);
  log(`listening on 127.0.0.1:${server.port}, upstream ${upstream}, typing ${cps} chars/s`);
  void agentBrowser.refresh();
}

async function runtime(args: string[], env: Env) {
  let values: { namespace?: string }, positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: { namespace: { type: "string" } }, allowPositionals: true }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  // Without a name, the session the environment names, as agent-browser itself does.
  const [mode, session = env.AGENT_BROWSER_SESSION, ...rest] = positionals;
  if ((mode !== "on" && mode !== "off") || !session || rest.length) throw new UsageError();
  if (!SESSION_NAME.test(session)) throw new Failure(`invalid session name: ${session}`);
  const config = await agentBrowserConfig(env);
  const namespace = namespaceOf(values.namespace, env, config);
  const label = namespace ? `${session} (namespace ${namespace})` : session;
  const file = Bun.file(join(sessionDir(env, namespace), `${session}.target`));
  const binding = (await file.exists()) ? ((await file.json().catch(() => undefined)) as { targetId?: unknown } | undefined) : undefined;
  const targetId = binding?.targetId;
  if (typeof targetId !== "string") throw new Failure(`session ${label} has no pinned tab (${file.name} is missing or unreadable)`);

  const port = proxyPort(env, config);
  const res = await fetch(`http://127.0.0.1:${port}/__humanize/runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId, enabled: mode === "on", session, ...(namespace ? { namespace } : {}) }),
  }).catch(() => {
    throw new Failure(`the proxy is not running on 127.0.0.1:${port}`);
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; tabs?: number };
  if (!res.ok) throw new Failure(`${body.error ?? `proxy answered ${res.status}`} (session ${label}, tab ${targetId})`);
  const tabs = body.tabs ?? 0;
  console.log(mode === "on" ? `Runtime on for ${label} in tab ${targetId}` : `Runtime off for ${label}: turned off in ${tabs} tab${tabs === 1 ? "" : "s"}`);
}

async function main([command, ...args]: string[], env: Env) {
  try {
    if (command === "serve") serve(serveConfig(args, env));
    else if (command === "runtime") await runtime(args, env);
    else if (command === "-h" || command === "--help") console.log(USAGE);
    else throw new UsageError(command === undefined ? "" : `unknown command: ${command}`);
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof Failure)) throw error;
    if (error.message) console.error(`agent-browser-humanize: ${error.message}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2), process.env);
