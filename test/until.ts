/**
 * Waits for something that happens asynchronously and returns the first truthy value of `probe`.
 *
 * The deadline is not what a test asserts: it only turns a wait that would never end into a failure that
 * says what was missing, so it is generous and sits just under Bun's 5 s test timeout. A test with a longer
 * timeout of its own passes a longer one. Never wait a fixed time for something to happen; wait for it.
 */
export async function until<T>(probe: () => T | Promise<T>, what = String(probe), ms = 4_000): Promise<NonNullable<T>> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
