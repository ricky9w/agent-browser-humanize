---
name: agent-browser-humanize
description: Use with agent-browser when it reaches Chrome through the agent-browser-humanize proxy. Covers which commands produce human input and which still reveal automation, how to see console output and page errors, and how to share one browser with other sessions and agents.
---

# agent-browser through agent-browser-humanize

agent-browser reaches Chrome through agent-browser-humanize, a local CDP proxy. It turns agent-browser's input into a person's input and hides DevTools traces from pages. Use agent-browser as usual; this skill covers only what is different. The full command reference is `agent-browser skills get core`.

This assumes the setup from the project README: agent-browser's `cdp` points at the proxy, with `pinTab` and `noAutoDialog` on.

## Sessions and tabs

- Give each task a session name that no other task or agent will use: a short prefix for yourself, the task and a random suffix, such as `--session cc-invoice-7k2q`. Pass it on every command. Sessions with the same name share one tab.
- `open <url>` opens a new tab for the session and pins the session to it. Other sessions' tabs and people's tabs are left alone.
- A session acts on one tab at a time. `tab new <url>` and `tab <tab>` switch to another tab and move the pin. Label extra tabs to tell them apart: `tab new --label docs <url>`, then `tab docs`.
- Tabs open in the background, and the proxy keeps your tabs visible and focused for the page. You never need to bring a tab to the front.
- A link or script that opens a new tab does not switch the session. List the tabs with `tab` and switch to it.
- Refs belong to one tab: run `snapshot -i` again after switching.
- `tab` lists every tab in the browser. Switch only to tabs your task opened.
- `tab_gone` means your tab was closed. Open a new one with `tab new <url>`; never take over another tab.
- When done, run `close`. The proxy then closes every tab the session opened; Chrome keeps running.
- To keep a tab for later, or while a person works in it, leave the session open and do not run `close`. A session left idle shuts down after an hour, but keeps its tab and comes back to it under the same name.
- After `close`, use a new session name for more work; the old name's tab is gone (`tab_gone`).

## What pages can see

The proxy turns `click`, `hover`, `check`, `fill`, `type`, `press`, `scroll` and `mouse wheel` into human input: the pointer travels along a random path to a random point in the element, clicks are held briefly, text is typed key by key at a typist's speed, and scrolling uses wheel steps. Use these commands as usual. Text longer than 120 characters is inserted at once, so use `fill` for long text.

These still run page JavaScript, change the DOM or produce input no person could, and pages can detect them:

- `find`, `nth` and CSS selectors: use refs from `snapshot` instead.
- `select`: open the dropdown with `click`, or Tab to it, then `press` the option's first letter, arrow keys and Enter.
- `scrollintoview`: use `scroll`.
- `screenshot --full`, `--annotate` and element screenshots: capture the viewport only.
- `eval`: only when nothing else works.

Keep a human pace: wait 1–3 seconds after a page loads before acting, and do not fire actions back to back. Every `snapshot` scans the page, so read it once, act on its refs, and snapshot again only after the page changes.

## Console output and page errors

The proxy blocks `Runtime.enable`, so the CDP Runtime domain is not enabled for pages. Runtime events (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, execution context events and others) do not reach agent-browser, and commands that depend on them, such as `console` and `errors`, return nothing. Commands that call `Runtime.evaluate` or `Runtime.callFunctionOn` directly, such as `eval` and `get`, are unaffected.

To debug, run `agent-browser-humanize runtime on <session>`. It enables the Runtime domain on the session's current tab, and console messages and exceptions from before are replayed. When done, run `agent-browser-humanize runtime off <session>`, which disables it on every tab the session turned it on for. If you run agent-browser with `--namespace <name>`, pass the same option to both commands.

## Notes

- Dialogs stay open. When a command reports an `alert`, `confirm` or leave-page dialog, wait a second or two, then `dialog accept` or `dialog dismiss` as intended.
- Other sessions and agents may use the browser at the same time. They share its cookies, accounts and download setting: run important actions on one account one after another, and after a download, check that the file arrived and download it again if it did not.
- For sign-ins, use the credential tool your environment provides; never ask for secrets in chat. Passkeys, SSO prompts and captchas need a person: ask them to take over, naming the site, the tab's title and the step.
- If agent-browser cannot connect (Chrome or the proxy is not running), report it. Do not fall back to headless or start another browser.
- Whether a site lets you in also depends on the network and the account, which the proxy does not change. If you are blocked, report it. Do not change the User-Agent or other identity settings: that only makes the browser inconsistent.
