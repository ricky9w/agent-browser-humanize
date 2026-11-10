import { afterAll, describe, expect, test } from "bun:test";
import { isMacUserAgent, macOSBrowser } from "../src/platform.ts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const LINUX_HEADLESS = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

/** A fake Chrome whose /json/version names `userAgent`, counting the requests. */
const servers: ReturnType<typeof Bun.serve>[] = [];
function chrome(userAgent?: string) {
  const state = { requests: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname !== "/json/version") return new Response("not found", { status: 404 });
      state.requests++;
      return Response.json({ Browser: "Chrome/157.0.8103.39", ...(userAgent ? { "User-Agent": userAgent } : {}) });
    },
  });
  servers.push(server);
  return { upstream: `127.0.0.1:${server.port}`, state };
}
afterAll(() => servers.forEach((s) => s.stop(true)));

describe("browser platform", () => {
  test("the User-Agent names macOS only on a Mac", () => {
    expect(isMacUserAgent(MAC)).toBe(true);
    for (const ua of [LINUX, LINUX_HEADLESS, WINDOWS]) expect(isMacUserAgent(ua)).toBe(false);
  });

  test("macOS from the upstream's /json/version, asked once", async () => {
    const { upstream, state } = chrome(MAC);
    const macOS = macOSBrowser(upstream);
    expect(await macOS()).toBe(true);
    expect(await macOS()).toBe(true);
    expect(state.requests).toBe(1);
  });

  test("Linux and Windows are not macOS, whatever the proxy runs on", async () => {
    for (const ua of [LINUX, WINDOWS]) expect(await macOSBrowser(chrome(ua).upstream)()).toBe(false);
  });

  test("while Chrome does not answer, the proxy's own platform is assumed and Chrome is asked again", async () => {
    const { upstream, state } = chrome();
    const macOS = macOSBrowser(upstream);
    expect(await macOS()).toBe(process.platform === "darwin");
    expect(await macOS()).toBe(process.platform === "darwin");
    expect(state.requests).toBe(2);
    expect(await macOSBrowser("127.0.0.1:1")()).toBe(process.platform === "darwin");
  });
});
