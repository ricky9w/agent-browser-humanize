// The platform of the Chrome being driven, which can differ from the proxy's: select-all is Meta+A on macOS and
// Control+A elsewhere. Read from the User-Agent of the upstream's /json/version, which names the OS even with
// Chrome's reduced User-Agent ("Macintosh; Intel Mac OS X 10_15_7" on every Mac).

const TIMEOUT_MS = 2000;

export const isMacUserAgent = (userAgent: string) => /\bMacintosh\b/.test(userAgent);

/**
 * Whether the Chrome at `upstream` runs on macOS. Asks once and caches the answer; while Chrome does not answer, it
 * guesses the proxy's own platform and asks again next time.
 */
export function macOSBrowser(upstream: string): () => Promise<boolean> {
  let known: boolean | undefined;
  return async () => {
    if (known !== undefined) return known;
    const res = await fetch(`http://${upstream}/json/version`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
    const version = res?.ok ? ((await res.json().catch(() => undefined)) as { "User-Agent"?: unknown } | undefined) : undefined;
    const userAgent = version?.["User-Agent"];
    if (typeof userAgent !== "string") return process.platform === "darwin";
    return (known = isMacUserAgent(userAgent));
  };
}
