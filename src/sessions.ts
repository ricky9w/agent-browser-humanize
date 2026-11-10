// agent-browser's session files, as agent-browser itself lays them out: the directory, and the binding of a pinned
// session to its tab (`<session>.target`).
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/** A session's binding to its tab. `close` sets `pinned` to false and keeps the file. */
export interface Binding {
  targetId: string;
  pinned: boolean;
}

/** Where agent-browser keeps its session files: per namespace when there is one. */
export function sessionDir(env: Env = process.env, namespace = ""): string {
  const base = env.AGENT_BROWSER_SOCKET_DIR
    ? env.AGENT_BROWSER_SOCKET_DIR
    : env.XDG_RUNTIME_DIR
      ? join(env.XDG_RUNTIME_DIR, "agent-browser")
      : join(homedir(), ".agent-browser");
  return namespace ? join(base, "namespaces", namespace, "run") : base;
}

async function bindingsIn(dir: string): Promise<Binding[]> {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".target"));
  const read = names.map(async (name) => {
    const json = (await Bun.file(join(dir, name)).json().catch(() => undefined)) as { targetId?: unknown; pinned?: unknown } | undefined;
    return typeof json?.targetId === "string" ? [{ targetId: json.targetId, pinned: json.pinned === true }] : [];
  });
  return (await Promise.all(read)).flat();
}

/** The bindings of every session, of every namespace too. Unreadable files are skipped. */
export async function readBindings(env: Env = process.env): Promise<Binding[]> {
  const base = sessionDir(env);
  const namespaces = await readdir(join(base, "namespaces")).catch(() => []);
  const all = await Promise.all([base, ...namespaces.map((namespace) => sessionDir(env, namespace))].map(bindingsIn));
  return all.flat();
}
