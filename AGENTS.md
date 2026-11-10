# Agent instructions

Read `README.md` before planning or changing this project. It owns the design, the rewrite rules, the configuration and how to run the tests.

## Rules

- Never log, print, persist or put into an error message typed text, `insertText` payloads or any CDP message body. Log counts and method names only: password managers and other credential tools may type secrets through this proxy.
- Keep zero runtime dependencies; Bun built-ins cover everything.
- Recognize agent-browser's page functions only by their exact source, copied from the agent-browser version in use. Anything not recognized passes through unchanged.
- Before using a library or API (CDP methods, Bun, agent-browser), read its current docs, for example with `npx ctx7@latest`.
- Run `bun run check` and `bun test` before committing. Update `README.md` in the same commit when behaviour, limits or configuration change; documents describe the design, not test results.
- Run `bun test/integration.ts` after changing input rules and after upgrading agent-browser or Chrome. It launches a Chrome of its own with a temporary profile; do not point it at a browser someone is using (`--upstream`) unless asked.
- After upgrading agent-browser, check that every entry of `agentBrowser.recognizers` in `/__humanize/health` is `true`, and update the recognized sources in `src/recognize.ts` from the new version when one is not.
