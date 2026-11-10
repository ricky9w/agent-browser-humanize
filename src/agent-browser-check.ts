// Self-check: does the installed agent-browser still contain the page functions recognize.ts knows? agent-browser is
// a Rust binary that embeds them verbatim as string literals. When one is missing, recognition silently falls back to
// agent-browser's own page script, so the result goes to the log and to /__humanize/health.
import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RECOGNIZERS, normalize, type RecognizerName } from "./recognize.ts";

type Env = Record<string, string | undefined>;
export interface AgentBrowserInfo {
  path: string;
  /** `agent-browser --version` without the name, or null when it did not answer. */
  version: string | null;
  recognizers: Record<RecognizerName, boolean>;
}
export type AgentBrowserStatus = AgentBrowserInfo | { error: string };

const VERSION_TIMEOUT_MS = 5000;
const NAMES = Object.keys(RECOGNIZERS) as RecognizerName[];

/**
 * The native agent-browser binary: AGENT_BROWSER_HUMANIZE_AGENT_BROWSER, or agent-browser on PATH, with symlinks
 * resolved. A script (the npm JS shim) is replaced by its sibling native binary `agent-browser-<platform>-<arch>` when
 * there is one.
 */
export async function locateAgentBrowser(env: Env = process.env): Promise<string> {
  const given = env.AGENT_BROWSER_HUMANIZE_AGENT_BROWSER || Bun.which("agent-browser", { PATH: env.PATH ?? "" });
  if (!given) throw new Error("agent-browser not found on PATH");
  const path = await realpath(given).catch(() => {
    throw new Error(`agent-browser not found at ${given}`);
  });
  if ((await Bun.file(path).slice(0, 2).text()) !== "#!") return path;
  const native = join(dirname(path), `agent-browser-${process.platform}-${process.arch}`);
  return (await Bun.file(native).exists()) ? native : path;
}

/** Which recognizers' signatures the binary (read as latin1) contains, compared like recognize.ts compares sources. */
export function findRecognizers(binary: string): Record<RecognizerName, boolean> {
  const text = normalize(binary);
  return Object.fromEntries(NAMES.map((name) => [name, text.includes(normalize(RECOGNIZERS[name].signature))])) as Record<RecognizerName, boolean>;
}

async function version(path: string): Promise<string | null> {
  try {
    const p = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: VERSION_TIMEOUT_MS });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return (code === 0 && out.trim().split("\n")[0]!.replace(/^agent-browser\s+/, "")) || null;
  } catch {
    return null;
  }
}

export async function checkAgentBrowser(path: string): Promise<AgentBrowserInfo> {
  const [bytes, v] = await Promise.all([Bun.file(path).arrayBuffer(), version(path)]);
  return { path, version: v, recognizers: findRecognizers(Buffer.from(bytes).toString("latin1")) };
}

/** The log line for a check: short when everything is found, a marked warning otherwise. */
export function describeCheck(status: AgentBrowserStatus): string {
  if ("error" in status) return `WARNING agent-browser self-check: ${status.error}; cannot verify the recognized page functions`;
  const name = `agent-browser ${status.version ?? "(version unknown)"} at ${status.path}`;
  const missing = NAMES.filter((n) => !status.recognizers[n]);
  if (!missing.length) return `${name}: all ${NAMES.length} recognized page functions found`;
  const fallbacks = missing.map((n) => RECOGNIZERS[n].fallback).join(", ");
  return `WARNING ${name}: page functions not found: ${missing.join(", ")}; agent-browser's own page script runs again for ${fallbacks}`;
}

/** Caches the check and re-runs it only when the binary's path, size or mtime changed. Nothing here throws. */
export class AgentBrowserMonitor {
  private result: AgentBrowserStatus = { error: "not checked yet" };
  private checked?: string;
  private running?: Promise<void>;

  constructor(
    private log: (line: string) => void = () => {},
    private env: Env = process.env,
  ) {}

  /** Starts a check if the binary changed since the last one; callers need not wait for it. */
  refresh(): Promise<void> {
    return (this.running ??= this.run().finally(() => (this.running = undefined)));
  }

  async status(): Promise<AgentBrowserStatus> {
    await this.refresh();
    return this.result;
  }

  private async run() {
    let path: string | undefined, key: string;
    try {
      const found = await locateAgentBrowser(this.env);
      const { size, mtimeMs } = await stat(found);
      key = `${found}\0${size}\0${mtimeMs}`;
      path = found;
    } catch (error) {
      key = (error as Error).message;
    }
    if (key === this.checked) return;
    this.checked = key;
    this.result = path ? await checkAgentBrowser(path).catch((error: Error) => ({ error: error.message })) : { error: key };
    this.log(describeCheck(this.result));
  }
}
