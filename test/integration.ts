#!/usr/bin/env bun
// Integration test against a real Chrome: drives agent-browser through the proxy (started here) on test/probe.html
// and checks that agent tabs stay in the background, focus emulation, two sessions at once, a session's tab after
// another session ended, dialogs, what the page receives, Runtime hiding, and the runtime command.
//
// By default it launches a Chrome of its own with a temporary profile and a free debugging port, and at the end quits
// it and deletes the profile. --upstream attaches to a running Chrome instead (advanced use): the test then opens tabs
// in that browser (one of its own, for a while a second one, a few for extra sessions and a control tab straight on
// Chrome) and closes them again. --external also runs a public bot detector (rebrowser).
// usage: bun test/integration.ts [--chrome <path>] [--headless] [--upstream <host:port>] [--session <name>] [--external]
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { macOSBrowser } from "../src/platform.ts";

const { values: opt } = parseArgs({
  options: {
    chrome: { type: "string" },
    headless: { type: "boolean", default: false },
    upstream: { type: "string" },
    session: { type: "string", default: "abh-test-int" },
    external: { type: "boolean", default: false },
  },
});
const session = opt.session!;
const root = join(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "abh-int-"));
// agent-browser keeps its session files and daemon sockets here, not in the user's ~/.agent-browser.
const sessions = join(work, "s");
mkdirSync(sessions);
// A throwaway agent-browser config: dialogs are left to the test (as recommended with the proxy), no plugins.
const config = join(work, "agent-browser.json");
writeFileSync(config, JSON.stringify({ noAutoDialog: true, noWebmcp: true }));
const agentBrowser = process.env.AGENT_BROWSER_HUMANIZE_AGENT_BROWSER || "agent-browser";
// No inherited agent-browser or proxy settings, except which agent-browser to run.
const env: Record<string, string | undefined> = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("AGENT_BROWSER_") && name !== "AGENT_BROWSER_HUMANIZE_AGENT_BROWSER") delete env[name];
Object.assign(env, { AGENT_BROWSER_PIN_TAB: "1", AGENT_BROWSER_CONFIG: config, AGENT_BROWSER_SOCKET_DIR: sessions });

// --- harness -------------------------------------------------------------------------------------------------------
type Ev = Record<string, any>;
const reports = new Map<string, any>();
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/report") {
      const r = (await req.json()) as { tag: string };
      reports.set(r.tag, r);
      return new Response("ok");
    }
    if (url.pathname === "/probe.html") return new Response(Bun.file(join(import.meta.dir, "probe.html")));
    return new Response("not found", { status: 404 });
  },
});
/** Chrome's DevTools endpoint and the proxy's port, once started. */
let upstream = opt.upstream ?? "";
let port = "";
let chrome: Bun.Subprocess | undefined;
let proxy: Bun.Subprocess | undefined;
let proxyLog = "";

/** Chrome's executable: --chrome, CHROME_PATH, or where Chrome is usually installed. */
function chromePath(): string {
  const given = opt.chrome || process.env.CHROME_PATH;
  if (given) return given;
  const found =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path))
      : ["google-chrome", "google-chrome-stable", "chromium"].map((name) => Bun.which(name)).find(Boolean);
  if (!found) throw new Error("Chrome not found: pass --chrome <path> or set CHROME_PATH");
  return found;
}

/** Starts a Chrome of the test's own: a temporary profile, never the user's, and a free debugging port. */
async function launchChrome() {
  const profile = join(work, "chrome");
  const flags = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"];
  chrome = Bun.spawn([chromePath(), ...flags, ...(opt.headless ? ["--headless"] : []), "about:blank"], { stdout: "ignore", stderr: "ignore" });
  // Chrome writes the port it picked, and the browser endpoint's path, to DevToolsActivePort in the profile.
  for (let i = 0; i < 300 && chrome.exitCode === null; i++) {
    const active = await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => "");
    const found = /^(\d+)\n\/devtools\/browser\//.exec(active)?.[1];
    if (found) return `127.0.0.1:${found}`;
    await Bun.sleep(100);
  }
  throw new Error(`Chrome did not open its debugging port (exit code ${chrome.exitCode})`);
}

/** Starts the proxy on a free port; returns the port it reports. */
async function startProxy() {
  proxy = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "serve", "--port", "0", "--upstream", upstream], { env, stdout: "pipe", stderr: "pipe" });
  for (const stream of [proxy.stdout, proxy.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) proxyLog += decoder.decode(chunk, { stream: true });
    })();
  }
  for (let i = 0; i < 100 && proxy.exitCode === null; i++) {
    const found = /listening on 127\.0\.0\.1:(\d+)/.exec(proxyLog)?.[1];
    if (found) return found;
    await Bun.sleep(100);
  }
  throw new Error(`the proxy did not start: ${proxyLog.trim()}`);
}

async function run(cmd: string[], extraEnv: Record<string, string> = {}) {
  const t = performance.now();
  const p = Bun.spawn(cmd, { env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: (out + err).trim(), code, ms: performance.now() - t };
}
const abAs = (name: string, ...args: string[]) => run([agentBrowser, "--session", name, "--cdp", port, ...args]);
const ab = (...args: string[]) => abAs(session, ...args);
const pinnedTab = async (name = session) => ((await Bun.file(join(sessions, `${name}.target`)).json().catch(() => ({}))) as { targetId?: string }).targetId;
const runtime = (mode: string, name = session, extraEnv?: Record<string, string>) =>
  run([process.execPath, join(root, "src/cli.ts"), "runtime", mode, name], { AGENT_BROWSER_HUMANIZE_PORT: port, ...extraEnv });
const health = async () => (await fetch(`http://127.0.0.1:${port}/__humanize/health`)).json() as Promise<any>;
const report = async (tag: string, wait = 800) => (await Bun.sleep(wait), reports.get(tag));
const probeUrl = (tag: string) => `http://127.0.0.1:${probe.port}/probe.html?tag=${tag}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const stats = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b), mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return { min: sorted[0] ?? NaN, max: sorted.at(-1) ?? NaN, mean, text: `min ${sorted[0]?.toFixed(1)} mean ${mean.toFixed(1)} max ${sorted.at(-1)?.toFixed(1)}` };
};
const after = (events: Ev[], i: number, pred: (e: Ev) => boolean) => events.slice(i + 1).find(pred);
/** A CDP connection straight to Chrome, without the proxy. */
async function direct() {
  const { webSocketDebuggerUrl } = (await (await fetch(`http://${upstream}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      pending.set(++id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => ws.close() };
}
/** A PNG file's size, as "<width>x<height>, <bytes> bytes", when it is one of at least 200x200 pixels. */
async function png(path: string) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.length < 24 || Buffer.from(bytes.subarray(0, 8)).toString("latin1") !== "\x89PNG\r\n\x1a\n") return undefined;
  const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
  return width >= 200 && height >= 200 ? `${width}x${height}, ${bytes.length} bytes` : undefined;
}
const seen = (r: any) => `${r.visible ? "visible" : "hidden"}, ${r.focused ? "focused" : "not focused"}, ${r.fps} fps`;

/** Typed keystrokes in a slice of events: key-downs other than Shift and the select-all/Backspace of the clear. */
function typing(events: Ev[]) {
  const downs = events.filter((e) => e.type === "keydown" && !["Shift", "Meta", "Control", "Backspace"].includes(e.key) && !e.meta && !e.ctrl);
  const holds: number[] = [];
  let rollovers = 0;
  for (const d of downs) {
    const up = after(events, events.indexOf(d), (e) => e.type === "keyup" && e.code === d.code);
    const next = downs[downs.indexOf(d) + 1];
    if (!up) continue;
    if (next && up.t > next.t) rollovers++;
    else holds.push(up.t - d.t);
  }
  const span = downs.length > 1 ? (downs.at(-1)!.t - downs[0]!.t) / 1000 : NaN;
  return { downs, holds, rollovers, cps: (downs.length - 1) / span, shifts: events.filter((e) => e.type === "keydown" && e.key === "Shift") };
}

// --- tests ---------------------------------------------------------------------------------------------------------
async function selfCheck() {
  console.log("\n# agent-browser self-check");
  const status = (await health()).agentBrowser;
  for (let i = 0; i < 20 && !/page functions/.test(proxyLog); i++) await Bun.sleep(100);
  check(
    "health and log: all recognized page functions found in agent-browser",
    !!status?.recognizers && Object.values(status.recognizers).every(Boolean) && /recognized page functions found/.test(proxyLog) && !proxyLog.includes("WARNING"),
    JSON.stringify(status),
  );
}

async function foreground() {
  console.log("\n# agent tabs stay in the background");
  // A control tab opened in front straight on Chrome has the focus, and document.hasFocus() in it says whether it
  // keeps it. It opens before the session connects: a connected agent-browser enables Page on new tabs, and the proxy
  // would then emulate focus there.
  const cdp = await direct();
  const name = `${session}-fg`;
  const opened: string[] = [], tabs: string[] = [];
  const open = async () => {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    opened.push(targetId);
    return targetId as string;
  };
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: await open(), flatten: true });
    const focused = async () => {
      await Bun.sleep(300);
      return (await cdp.send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true }, sessionId)).result.value === true;
    };
    const steps: [string, boolean][] = [["opened", await focused()]];
    await abAs(name, "open", probeUrl(`fg-${Date.now()}`));
    tabs.push((await pinnedTab(name))!);
    steps.push(["session's first tab", await focused()]);
    await abAs(name, "tab", "new", probeUrl(`fg2-${Date.now()}`));
    tabs.push((await pinnedTab(name))!);
    steps.push(["tab new", await focused()]);
    await abAs(name, "tab", tabs[0]!);
    steps.push(["tab switch", await focused()]);
    // The control tab is a valid observable only if a tab opened in front straight on Chrome takes its focus.
    await open();
    const taken = !(await focused());
    const detail = `control tab focused: ${steps.map(([step, f]) => `${step} ${f}`).join(", ")}; a foreground tab took the focus: ${taken}`;
    if (steps[0]![1] && taken) check("opening and switching session tabs leaves Chrome's focused tab alone", steps.every(([, f]) => f) && tabs[0] !== tabs[1], detail);
    else console.log(`SKIP  Chrome's focused tab is not observable  (${detail})`);
  } finally {
    for (const id of tabs.toReversed()) await abAs(name, "tab", "close", id);
    await abAs(name, "close");
    for (const id of [...opened, ...tabs]) await cdp.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
    cdp.close();
  }
}

async function focusEmulation() {
  console.log("\n# focus emulation");
  const tag = `seen-${Date.now()}`;
  await ab("open", probeUrl(tag));
  const r = await report(tag, 2500);
  check("the session's tab is visible, focused and rendering", r.visible && r.focused && r.fps > 30, seen(r));
}

async function parallel() {
  console.log("\n# two sessions at once");
  const names = [`${session}-a`, `${session}-b`];
  const texts = ["Alex.Morgan+parallel@example.org", "Sam Rivera, 42 Elm Street, Springfield"];
  const tags = names.map((_, i) => `par${i}-${Date.now()}`);
  try {
    await Promise.all(names.map((name, i) => abAs(name, "open", probeUrl(tags[i]!))));
    const before = await Promise.all(tags.map(async (tag) => structuredClone(await report(tag, 1500))));
    const work = async (name: string, text: string) => {
      const t = performance.now();
      for (const args of [["click", "#btn"], ["fill", "#name", text], ["click", "#btn"]]) await abAs(name, ...args);
      return performance.now() - t;
    };
    const t0 = performance.now();
    const times = await Promise.all(names.map((name, i) => work(name, texts[i]!)));
    const total = performance.now() - t0;
    const reports = await Promise.all(tags.map((tag) => report(tag, 1200)));
    reports.forEach((r, i) => {
      const samples: Ev[] = r.samples.slice(before[i].samples.length), changes: Ev[] = r.changes.slice(before[i].changes.length);
      const ev: Ev[] = r.events.slice(before[i].events.length);
      check(
        `session ${i + 1}: visible and focused throughout`,
        samples.length > 0 && samples.every((x) => x.visible && x.focused) && !changes.some((c) => c.type === "hidden" || c.type === "blur"),
        `${samples.length} samples, fps ${stats(samples.map((x) => x.fps)).text}, changes [${changes.map((c) => c.type).join(",")}]`,
      );
      const presses = ev.filter((e) => e.type === "mousedown").length, keys = typing(ev).downs.length;
      check(
        `session ${i + 1}: trusted input, right value`,
        ev.every((e) => e.trusted) && presses === 3 && keys === texts[i]!.length && r.values.name === texts[i],
        `${presses} clicks, ${keys} key-downs, ${ev.length} events`,
      );
    });
    const [short, long] = [...times].sort((a, b) => a - b) as [number, number];
    check(
      "both at once: total time close to the longer session, not the sum",
      total < long + short / 2,
      `sessions ${times.map((t) => (t / 1000).toFixed(1)).join(" s, ")} s, total ${(total / 1000).toFixed(1)} s`,
    );
  } finally {
    for (const name of names) {
      await abAs(name, "tab", "close");
      await abAs(name, "close");
    }
  }
}

async function otherSessionEnds() {
  console.log("\n# a session's tab after another session ended");
  // B connects first, so its agent-browser also enables Page on A's tab when A opens it. If client sessions emulated
  // focus themselves, B ending would take the focus from A's tab: Chrome clears a page's focus flag when any session
  // that set it detaches.
  const [a, b] = [`${session}-keep-a`, `${session}-keep-b`];
  const tag = `keep-${Date.now()}`;
  const text = "Kim O'Hara";
  const open = new Set<string>();
  try {
    for (const [name, t] of [[b, `${tag}-b`], [a, tag]] as const) {
      open.add(name);
      await abAs(name, "open", probeUrl(t));
    }
    const before = structuredClone(await report(tag, 1500));
    await abAs(b, "tab", "close");
    await abAs(b, "close");
    open.delete(b);
    const ended = structuredClone(await report(tag, 300));
    const r = structuredClone(await report(tag, 2500));
    const samples: Ev[] = r.samples.slice(ended.samples.length), changes: Ev[] = r.changes.slice(before.changes.length);
    check(
      "A's tab still visible and focused after session B ended",
      before.visible && before.focused && samples.length >= 2 && samples.every((x) => x.visible && x.focused) && !changes.some((c) => c.type === "hidden" || c.type === "blur"),
      `before: ${seen(before)}; after: ${samples.map((x) => `${x.visible ? "visible" : "hidden"}/${x.focused ? "focused" : "not focused"}`).join(", ")}; changes [${changes.map((c) => c.type).join(",")}]`,
    );
    await abAs(a, "click", "#btn");
    await abAs(a, "fill", "#name", text);
    const r2 = await report(tag, 1200);
    const ev: Ev[] = r2.events.slice(r.events.length);
    const presses = ev.filter((e) => e.type === "mousedown").length, keys = typing(ev).downs.length;
    check(
      "A still clicks and fills after session B ended: trusted, right value",
      ev.length > 0 && ev.every((e) => e.trusted) && presses === 2 && keys === text.length && r2.values.name === text && r2.focused,
      `${presses} clicks, ${keys} key-downs, ${ev.length} events, value ${r2.values.name === text ? "right" : "wrong"}, page ${seen(r2)}`,
    );
  } finally {
    for (const name of open) {
      await abAs(name, "tab", "close");
      await abAs(name, "close");
    }
  }
}

async function backgroundTab() {
  console.log("\n# dialogs and screenshot in a background agent tab");
  const tag = `dialog-${Date.now()}`;
  await ab("open", probeUrl(tag));
  const dialog = async (selector: string, type: string, message: string, answer: string) => {
    const click = await ab("click", selector);
    const status = (await ab("dialog", "status")).out;
    const handled = await ab("dialog", answer);
    const first = (text: string) => text.split("\n")[0];
    return {
      ok: click.code === 0 && status.includes(`JavaScript ${type} dialog is open: "${message}"`) && handled.code === 0,
      detail: `click: ${first(click.out)} | status: ${first(status)} | ${answer}: ${first(handled.out)}`,
    };
  };
  const alert = await dialog("#alert", "alert", "abh-alert", "accept");
  const confirm = await dialog("#confirm", "confirm", "abh-confirm", "dismiss");
  const r = await report(tag);
  check("alert reported by agent-browser and accepted", alert.ok && r.dialogs.includes("alert closed"), alert.detail);
  check("confirm reported by agent-browser and dismissed", confirm.ok && r.dialogs.includes("confirm false"), `${confirm.detail}; page: ${r.dialogs.join(", ")}`);
  const shot = join(work, "background.png");
  const taken = await ab("screenshot", shot);
  const image = await png(shot);
  check("screenshot of the background agent tab", taken.code === 0 && !!image, `${image ?? "no PNG"}; page ${seen(r)}`);
}

async function clicks() {
  console.log("\n# clicks");
  const tag = `click-${Date.now()}`;
  await ab("open", probeUrl(tag));
  const button = `@${/button "Press me" \[ref=(e\d+)\]/.exec((await ab("snapshot", "-i")).out)?.[1]}`;
  for (const target of [button, "#name", button, "#bio", button, "#name", button]) {
    await ab("click", target);
    await Bun.sleep(250 + Math.random() * 300);
  }
  await ab("dblclick", button);
  const r = await report(tag);
  const ev: Ev[] = r.events;
  const downs = ev.filter((e) => e.type === "pointerdown"), ups = ev.filter((e) => e.type === "pointerup");
  const c = { x: r.btn.x + r.btn.width / 2, y: r.btn.y + r.btn.height / 2 };
  const onButton = downs.filter((e) => e.target === "button#btn");
  const offsets = onButton.map((e) => Math.hypot(e.x - c.x, e.y - c.y));
  const points = new Set(onButton.map((e) => `${e.x},${e.y}`));
  check("presses on integer points", downs.length === 9 && downs.every((e) => Number.isInteger(e.x) && Number.isInteger(e.y)), `${downs.length} presses`);
  check("button presses not at the exact centre", offsets.every((o) => o > 0.01) && points.size >= 3, `centre (${c.x.toFixed(2)}, ${c.y.toFixed(2)}), offset px ${stats(offsets).text}, ${points.size} distinct points`);
  check("pointerdown pressure 0.5, pointerup 0", downs.every((e) => e.pressure === 0.5) && ups.every((e) => e.pressure === 0));
  const mdowns = ev.filter((e) => e.type === "mousedown");
  const holds = mdowns.map((d) => after(ev, ev.indexOf(d), (e) => e.type === "mouseup")!.t - d.t);
  const h = stats(holds);
  check("button held 60-140 ms", h.min >= 58 && h.max <= 145, `ms ${h.text}`);
  const moves = mdowns.map((d, i) => ev.slice(i ? ev.indexOf(mdowns[i - 1]!) : 0, ev.indexOf(d)).filter((e) => e.type === "mousemove").length);
  // The double click aims at the button clicked just before, so the pointer stays where it is.
  check("pointer travels a path before each new target", moves.slice(0, 7).every((m) => m >= 3) && moves[7] === 0, `mouse moves per click ${moves.join(",")}`);
  const [d1, d2] = mdowns.slice(-2);
  const gap = d2!.t - after(ev, ev.indexOf(d1!), (e) => e.type === "mouseup")!.t;
  check("dblclick is two clicks 80-140 ms apart", d1!.detail === 1 && d2!.detail === 2 && gap >= 78 && gap <= 145 && ev.some((e) => e.type === "dblclick"), `gap ${gap.toFixed(1)} ms`);
  check("all input events trusted", ev.every((e) => e.trusted));
  check("button worked", (await ab("get", "text", "#out")).out.includes("pressed"));
}

async function keyboard() {
  console.log("\n# typing");
  const tag = `type-${Date.now()}`;
  await ab("open", probeUrl(tag));
  const name = "Jamie.Lee+test@example.com";
  const sentence = "The quick brown fox jumps over the lazy dog, then naps. Meet me at 5:30 by the old oak tree near the river bank today ok";
  const long = `${sentence} -- and this part makes it longer than the limit.`;
  const f1 = await ab("fill", "#name", name);
  await Bun.sleep(300);
  const f2 = await ab("fill", "#name", "Pat O'Neil");
  const v2 = (await ab("get", "value", "#name")).out;
  const f3 = await ab("fill", "#bio", long);
  await Bun.sleep(300);
  const f4 = await ab("fill", "#name", sentence);
  const r = await report(tag);
  const ev: Ev[] = r.events;
  // Each fill starts with the click into its field.
  const starts = ev.flatMap((e, i) => (e.type === "mousedown" ? [i] : []));
  check("each fill clicks into the field", starts.length === 4, `${starts.length} clicks`);
  const part = (n: number) => ev.slice(starts[n], starts[n + 1]);

  const t1 = typing(part(0));
  check(`fill ≤120 chars is typed key by key (${name.length} chars)`, t1.downs.length === name.length && t1.downs.every((e) => e.code && e.keyCode > 0), `${t1.downs.length} key-downs`);
  const at = t1.downs.find((e) => e.key === "@");
  check("Shift key events for shifted characters", t1.shifts.length === 4 && t1.shifts.every((e) => e.code === "ShiftLeft" && e.location === 1) && at?.code === "Digit2" && at.shift, `${t1.shifts.length} Shift presses, @ code ${at?.code}`);
  const inputs = ev.filter((e) => e.type === "input");
  check("no untrusted input events", inputs.every((e) => e.trusted), `${inputs.length} input events`);

  // Select-all is Meta+A when Chrome runs on macOS, Control+A elsewhere.
  const clear = part(1);
  const mod = (await macOSBrowser(upstream)()) ? { key: "Meta", flag: "meta" } : { key: "Control", flag: "ctrl" };
  const selectAll = clear.find((e) => e.type === "keydown" && e.key === "a" && e[mod.flag]);
  check(
    `fill clears with ${mod.key}+A and Backspace`,
    !!selectAll && clear.some((e) => e.type === "keydown" && e.code === `${mod.key}Left`) && clear.some((e) => e.inputType === "deleteContentBackward" && e.trusted) && v2.includes("Pat O'Neil") && !v2.includes("Jamie"),
    `value ${v2}`,
  );

  const bio = part(2);
  const bioInserts = bio.filter((e) => e.type === "input" && e.inputType === "insertText");
  check(`fill >120 chars is one insertText (${long.length} chars)`, bioInserts.length === 1 && bioInserts[0]!.dataLength === long.length && typing(bio).downs.length === 0, `${bioInserts.length} input events, ${f3.ms.toFixed(0)} ms`);

  const t4 = typing(part(3));
  const holds = stats(t4.holds);
  check(`120-char fill within agent-browser's 30 s`, f4.code === 0 && f4.ms < 30000 && t4.downs.length === sentence.length, `${(f4.ms / 1000).toFixed(1)} s, ${t4.downs.length} key-downs`);
  check("typing speed 8-10 chars/s", t4.cps >= 7.5 && t4.cps <= 10.5, `${t4.cps.toFixed(2)} chars/s (${name.length}-char fill: ${t1.cps.toFixed(2)})`);
  check("key holds ~40-90 ms, some rollover", holds.min >= 35 && holds.max <= 100 && t4.rollovers > 0, `ms ${holds.text}, ${t4.rollovers} rollovers`);
  check("values are right", r.values.name === sentence && r.values.bio === long);
  console.log(`      fill times: ${[f1, f2, f3, f4].map((f) => `${(f.ms / 1000).toFixed(1)} s`).join(", ")}`);
}

async function scrolling() {
  console.log("\n# scroll");
  const tag = `scroll-${Date.now()}`;
  await ab("open", probeUrl(tag));
  // The element first: an element scrolled out of view is left to agent-browser's own scrollBy.
  await ab("scroll", "down", "200", "--selector", "#box");
  const r1 = structuredClone(await report(tag));
  await ab("scroll", "down", "600");
  const r2 = await report(tag);
  const wheels = (r2.events as Ev[]).filter((e) => e.type === "wheel");
  check("scroll → trusted wheel steps", wheels.length >= 3 && wheels.every((e) => e.trusted && Math.abs(e.deltaY) >= 79 && Math.abs(e.deltaY) <= 121), `${wheels.length} wheel events, deltaY ${wheels.map((e) => Math.round(e.deltaY)).join(",")}`);
  check("element scrolled as asked", Math.abs(r1.boxScroll - 200) <= 2, `box ${r1.boxScroll}`);
  check("window scrolled as asked", Math.abs(r2.scrollY - 600) <= 2, `scrollY ${r2.scrollY}; box ${r1.boxScroll} -> ${r2.boxScroll} (a panel under the pointer takes wheel steps, as for a person)`);
  const shot = join(work, "shot.png");
  await ab("screenshot", shot);
  const image = await png(shot);
  check("screenshot through the proxy", !!image, image ?? "no PNG");
}

async function runtimeDomain() {
  console.log("\n# Runtime");
  const tag = `runtime-${Date.now()}`;
  await ab("open", probeUrl(tag));
  await ab("eval", "console.log('abh-marker-early'); 1");
  const hidden = (await ab("console")).out;
  const r0 = await report(tag, 600);
  check("Runtime hidden: no console output, no detection", !hidden.includes("abh-marker-early") && r0.runtimeHits === 0, `${r0.runtimeHits}/${r0.runtimeChecks} detections`);
  const on = await runtime("on");
  await Bun.sleep(300);
  const shown = (await ab("console")).out;
  const r1 = await report(tag, 600);
  check("runtime on: console shows earlier messages", on.code === 0 && shown.includes("abh-marker-early") && r1.runtimeHits > 0, `${on.out}; marker ${shown.includes("abh-marker-early") ? "shown" : "missing"}, ${r1.runtimeHits} detections`);
  const off = await runtime("off");
  await Bun.sleep(400);
  const hitsAtOff = (await report(tag, 400)).runtimeHits;
  await ab("eval", "console.log('abh-marker-late'); 1");
  const later = (await ab("console")).out;
  const r2 = await report(tag, 1000);
  check("runtime off: hidden again", off.code === 0 && !later.includes("abh-marker-late") && r2.runtimeHits === hitsAtOff, `${off.out}; detections ${hitsAtOff} -> ${r2.runtimeHits}`);
  const missing = await runtime("on", "abh-test-no-such-session");
  const down = await runtime("on", session, { AGENT_BROWSER_HUMANIZE_PORT: "1" });
  check("runtime fails clearly", missing.code === 1 && down.code === 1, `${missing.out} | ${down.out}`);
}

async function tabSwitch() {
  console.log("\n# Runtime after a tab switch");
  const tag = `switch-${Date.now()}`;
  await ab("open", probeUrl(tag));
  const first = await pinnedTab();
  let second: string | undefined;
  try {
    await runtime("on");
    await ab("tab", "new", probeUrl(`${tag}-new`));
    second = await pinnedTab();
    // The first tab is in the background now; focus emulation keeps its timers at full rate.
    const h0 = (await report(tag, 1500)).runtimeHits;
    const h1 = (await report(tag, 2500)).runtimeHits;
    const off = await runtime("off");
    const h2 = (await report(tag, 1500)).runtimeHits;
    const h3 = (await report(tag, 3000)).runtimeHits;
    check(
      "runtime off after tab new hides the first tab again",
      !!second && second !== first && h1 > h0 && off.code === 0 && h3 === h2,
      `${off.out}; first tab detections ${h0} -> ${h1} while on, ${h2} -> ${h3} after off`,
    );
  } finally {
    if (first) await ab("tab", first);
    if (second && second !== first) await ab("tab", "close", second);
  }
}

async function rebrowser() {
  console.log("\n# rebrowser bot detector");
  const leak = async () => {
    await Bun.sleep(5000);
    const text = JSON.parse((await ab("eval", "document.body.innerText")).out || '""') as string;
    return /(\S+) runtimeEnableLeak\t[^\t]*\t([^\n]*)/.exec(text);
  };
  await ab("open", "https://bot-detector.rebrowser.net/");
  const off = await leak();
  check("runtimeEnableLeak green with Runtime off", off?.[1] === "🟢", off ? `${off[1]} ${off[2]}` : "row not found");
  await runtime("on");
  await ab("reload");
  const on = await leak();
  await runtime("off");
  check("detector sees Runtime when switched on (sanity)", on?.[1] === "🔴", on ? `${on[1]} ${on[2]}` : "row not found");
  await ab("reload");
  const again = await leak();
  check("green again after runtime off", again?.[1] === "🟢", again ? `${again[1]} ${again[2]}` : "row not found");
}

/** Closes the sessions, stops the proxy and the probe, quits Chrome and deletes the work directory with its profile. */
let cleaning: Promise<void> | undefined;
const cleanup = () =>
  (cleaning ??= (async () => {
    if (port) {
      await ab("tab", "close");
      await ab("close");
      console.log(`\nproxy health: ${JSON.stringify(await health().catch(() => undefined))}`);
    }
    proxy?.kill();
    probe.stop(true);
    if (chrome) {
      chrome.kill();
      if (!(await Promise.race([chrome.exited.then(() => true), Bun.sleep(10_000).then(() => false)]))) chrome.kill("SIGKILL");
      await chrome.exited;
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  })());
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

try {
  upstream ||= await launchChrome();
  port = await startProxy();
  const version = (await (await fetch(`http://${upstream}/json/version`)).json()) as { Browser: string };
  const where = opt.upstream ? `attached at ${upstream}` : `own, ${opt.headless ? "headless" : "headed"}`;
  console.log(`${version.Browser} (${where}), ${(await run([agentBrowser, "--version"])).out}, proxy on 127.0.0.1:${port}`);
  await selfCheck();
  await foreground();
  await focusEmulation();
  await parallel();
  await otherSessionEnds();
  await backgroundTab();
  await clicks();
  await keyboard();
  await scrolling();
  await runtimeDomain();
  await tabSwitch();
  if (opt.external) await rebrowser();
} catch (error) {
  failures++;
  console.log(`FAIL  ${(error as Error).stack}`);
} finally {
  await cleanup();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
