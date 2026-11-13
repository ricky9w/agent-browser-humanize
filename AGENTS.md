# Agent instructions

Read `README.md` before planning or changing this project. It owns the design, the rewrite rules, the configuration and how to run the tests.

## Rules

- Never log, print, persist or put into an error message typed text, `insertText` payloads or any CDP message body. Log counts and method names only: password managers and other credential tools may type secrets through this proxy.
- Keep zero runtime dependencies; Bun built-ins cover everything.
- Close a tab only when it has an owner (a client created it through the proxy, or a page of an owned tab opened it) and the owner's lease has ended. Never close a tab without an owner. Decide from the recorded state at each check, never from having seen an event.
- Recognize agent-browser's page functions only by their exact source, copied from the agent-browser version in use. Anything not recognized passes through unchanged.
- Before using a library or API (CDP methods, Bun, agent-browser), read its current docs, for example with `npx ctx7@latest`.
- Run `bun run check` and `bun test` before committing. Update `README.md` in the same commit when behaviour, limits or configuration change; documents describe the design, not test results.
- Run `bun test/integration.ts` after changing input rules and after upgrading agent-browser or Chrome. It launches a Chrome of its own with a temporary profile; do not point it at a browser someone is using (`--upstream`) unless asked.
- After upgrading agent-browser, check that every entry of `agentBrowser.recognizers` in `/__humanize/health` is `true`, and update the recognized sources in `src/recognize.ts` from the new version when one is not.
- Tests do not depend on how fast the machine is. A rule about time is tested on an injected or stopped clock, at both sides of its limit. Wait for what happens with `until` from `test/until.ts`, never for a fixed time; before asserting that something did not happen, wait for something sent after it on the same ordered channel. Real elapsed time is asserted only as a lower bound. A real delay that has to stay, such as a real browser's own pace, carries a comment saying what it outlasts.
