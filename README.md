# agent-browser-humanize

A local CDP proxy between [agent-browser](https://github.com/vercel-labs/agent-browser) and Chrome. It hides the DevTools `Runtime` domain from pages, turns agent-browser's instant input into input that looks like a person's, and keeps the tabs agent-browser works in visible and focused in the background, so that several sessions can share one Chrome without changing what is on screen. It also closes the tabs of sessions that ended with `close`, which agent-browser leaves open on a Chrome it did not start, and pauses the agent's actions on a tab while a person has taken it over.

agent-browser itself is not changed, and you call it as before. Only the CDP port it connects to changes, from Chrome's (`9222`) to the proxy's (`9333`).

Bun and TypeScript, no runtime dependencies. agent-browser-humanize is an independent project, not affiliated with Vercel.

## Why

- **Runtime domain.** agent-browser sends `Runtime.enable` on every tab it attaches to. While it is enabled, Chrome formats every logged error at once, and a page notices that through `Error.prepareStackTrace`. Bot detectors such as deviceandbrowserinfo, FPScanner, Pixelscan, Fingerprint-Scan and rebrowser flag it.
- **Focus.** An agent's Chrome often runs where nobody looks at it: on a machine whose screen is locked, or shared by several sessions, of which at most one tab per window can be in front. Chrome reports a page in a background tab or window as hidden and unfocused and stops its animation frames. CDP input still reaches such a page, so it receives clicks and keystrokes while it says nobody can see it, which a person cannot do. agent-browser never asks Chrome to emulate focus. And a session that opens or switches tabs brings its tab to the front, over the tab a person may be working in by hand, for example for a login.
- **Input.** agent-browser clicks with one `mouseMoved` exactly at the sub-pixel centre of the element and a 1-2 ms press, with pointer pressure 0. `fill` focuses and clears the field from page script, firing an untrusted `input` event, and then inserts the whole text at once. `type` inserts one character after another with no key events. `press` has no hold, an empty `code` for symbols such as `@`, and no Shift key event for `Shift+X`. `scroll` calls `scrollBy` from page script. None of this is what a real mouse and keyboard produce.
- **Tabs.** On a Chrome it did not start, agent-browser never closes a tab: `close` only disconnects, and a session that is forgotten or crashes leaves its tabs anyway. In a browser that runs for weeks they pile up. The proxy owns the lifetime of the tabs created through it.
- **Taking over.** A person may take over an agent's tab from another program with a DevTools connection of its own, for example to sign in. The agent must not act on the tab meanwhile, and only the proxy sits where that can be enforced.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later.
- agent-browser 0.42.x. The proxy recognizes some of agent-browser's page functions by their exact source, copied from 0.42.0; the [self-check](#agent-browser-self-check) tells you when the installed agent-browser no longer contains them.
- Google Chrome or Chromium with remote debugging. Developed against Chrome 157.
- Tested on macOS. Nothing in the proxy is specific to macOS, and for a Chrome on Linux it sends the Linux select-all shortcut, but it has not been tested on Linux. Windows is untested.

## Install

There is no npm package. Install a release, or link a clone of this repository.

**A release.** Each release on [GitHub Releases](https://github.com/ricky9w/agent-browser-humanize/releases) has a tarball, `agent-browser-humanize-<version>.tar.gz`, with the command in `bin/`, the code, the [skill](#agent-skill), this README and the license. It needs no `bun install`: the proxy has no runtime dependencies. Unpack it into a directory of its own and link the command into a directory on your `PATH`:

```sh
version=0.1.1
mkdir -p ~/opt/agent-browser-humanize/releases ~/.local/bin
curl -fsSL "https://github.com/ricky9w/agent-browser-humanize/releases/download/v$version/agent-browser-humanize-$version.tar.gz" |
  tar -xz -C ~/opt/agent-browser-humanize/releases
mv ~/opt/agent-browser-humanize/releases/agent-browser-humanize-$version ~/opt/agent-browser-humanize/releases/$version
ln -sfn releases/$version ~/opt/agent-browser-humanize/current
ln -sfn ~/opt/agent-browser-humanize/current/bin/agent-browser-humanize ~/.local/bin/agent-browser-humanize
agent-browser-humanize --version
```

With this layout, an upgrade unpacks the next release beside the others and moves the `current` link, and going back moves it back; restart the proxy after either. Point services and links at `current/bin/agent-browser-humanize`, never at a file of one release.

**A clone.** For development, or to follow `main`:

```sh
git clone https://github.com/ricky9w/agent-browser-humanize.git
cd agent-browser-humanize
bun link
```

`bun link` registers the checkout with Bun and links the `agent-browser-humanize` command (`bin/agent-browser-humanize`) into Bun's global bin directory (`~/.bun/bin` by default; `bun pm bin -g` prints it), which must be on your `PATH`. The command runs the checkout itself, so `git pull` updates it, and `bun unlink` in the checkout removes it. Without linking, run `bin/agent-browser-humanize` in the checkout instead. Running it needs no `bun install`; that is only for development.

`agent-browser-humanize --version` prints the version, and the running proxy reports it in [`/__humanize/health`](#control-api).

## Quick start

1. Start Chrome with remote debugging and a profile of its own. Since Chrome 136, Chrome ignores `--remote-debugging-port` for its default profile, so `--user-data-dir` is required; it also keeps the agent's browsing apart from yours.

   ```sh
   # macOS
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-agent"
   # Linux
   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-agent"
   ```

2. Start the proxy. It listens on 127.0.0.1:9333 and forwards to Chrome on 127.0.0.1:9222.

   ```sh
   agent-browser-humanize serve
   ```

3. Point agent-browser at the proxy, with tab pinning, either per command:

   ```sh
   agent-browser --session demo --cdp 9333 --pin-tab --no-auto-dialog open https://example.com
   ```

   or once in `~/.agent-browser/config.json`:

   ```json
   { "cdp": "9333", "pinTab": true, "noAutoDialog": true }
   ```

   `pinTab` gives each agent-browser session a tab of its own in the shared Chrome. `noAutoDialog` is recommended: by default agent-browser accepts `alert` and `beforeunload` dialogs itself the moment they open, so `alert()` returns within milliseconds, which a page can measure and no person manages. With `noAutoDialog`, the agent answers dialogs with `agent-browser dialog accept` or `dismiss`, as it already must for `confirm` and `prompt`.

4. Check that the proxy reaches Chrome and recognizes your agent-browser: `upstream` should be `true`, and every entry of `agentBrowser.recognizers` `true`.

   ```sh
   curl -s http://127.0.0.1:9333/__humanize/health
   ```

## Agent skill

`skills/agent-browser-humanize/SKILL.md` is an agent skill for agents that use agent-browser through the proxy: which commands produce human input and which still reveal automation, how to see console output and page errors, and how to share one browser with other sessions.

The repository, and every release, is a [Pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) that declares this skill (`pi.skills` in `package.json`). For Pi, install it as a local package, for example the installed release:

```sh
pi install ~/opt/agent-browser-humanize/current
```

For other agents, copy or symlink the directory into the directory your agent loads skills from, for example:

```sh
ln -s "$PWD/skills/agent-browser-humanize" <skills-directory>/agent-browser-humanize
```

## Run in the background

The proxy is a single long-running process. Run it under your service manager, and make sure Bun and agent-browser can be found there: `agent-browser-humanize` starts with `#!/usr/bin/env bun`, and the self-check looks for `agent-browser` on `PATH`. Service managers start with a minimal `PATH`, so set one that contains both, or set `AGENT_BROWSER_HUMANIZE_AGENT_BROWSER` to agent-browser's path. `which agent-browser-humanize bun agent-browser` shows the paths to use. The proxy reads agent-browser's session files to [close the tabs of ended sessions](#tabs-of-ended-sessions), so if you set `AGENT_BROWSER_SOCKET_DIR` or `XDG_RUNTIME_DIR` for agent-browser, set them for the proxy too. Chrome must be started separately.

**macOS (launchd).** Save as `~/Library/LaunchAgents/com.example.agent-browser-humanize.plist`, replacing the `/path/to` placeholders with absolute paths (launchd expands neither `~` nor `$HOME`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.agent-browser-humanize</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/.bun/bin/agent-browser-humanize</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/path/to/.bun/bin:/path/to/agent-browser/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/path/to/agent-browser-humanize.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/agent-browser-humanize.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.agent-browser-humanize.plist
launchctl kickstart -k gui/$(id -u)/com.example.agent-browser-humanize   # restart, e.g. after an upgrade
```

**Linux (systemd).** Save as `~/.config/systemd/user/agent-browser-humanize.service`; `%h` is your home directory:

```ini
[Unit]
Description=agent-browser-humanize CDP proxy

[Service]
ExecStart=%h/.bun/bin/agent-browser-humanize serve
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-browser-humanize
journalctl --user -u agent-browser-humanize   # the log
```

## Configuration

| Setting | Default | |
| --- | --- | --- |
| `--port`, `AGENT_BROWSER_HUMANIZE_PORT` | `9333` | Port on 127.0.0.1; `0` picks a free one. See [the runtime command](#the-runtime-command) for how `runtime` finds the port. |
| `--upstream`, `AGENT_BROWSER_HUMANIZE_UPSTREAM` | `127.0.0.1:9222` | Chrome's DevTools endpoint, `host:port`. |
| `AGENT_BROWSER_HUMANIZE_CPS` | `9` | Average typing speed, characters per second. |
| `AGENT_BROWSER_HUMANIZE_AGENT_BROWSER` | `agent-browser` on `PATH` | The agent-browser binary the self-check inspects. |

Options win over environment variables. The other limits (120 characters, holds, path timing) are named constants at the top of `src/keyboard.ts`, `src/motion.ts` and `src/humanize.ts`.

`serve` logs to stdout: the address it listens on, the self-check's result, the focus keeper's connects and disconnects, and once a minute the counters, when they changed.

## The runtime command

With Runtime hidden, `agent-browser console` and `errors` stay empty. When you need them, switch Runtime on for a session's tab:

```sh
agent-browser-humanize runtime on <session>    # console and errors of the session's tab become visible, earlier ones included
agent-browser-humanize runtime off <session>   # hidden again, in every tab the session turned it on for
agent-browser-humanize runtime on --namespace <name> <session>   # a session of an agent-browser namespace
agent-browser-humanize runtime on              # the session named in AGENT_BROWSER_SESSION
```

It reads the session's pinned tab from agent-browser's binding file (`<session>.target` in `AGENT_BROWSER_SOCKET_DIR`, `$XDG_RUNTIME_DIR/agent-browser` or `~/.agent-browser`, where agent-browser keeps it) and calls the control API with the tab and the session name. Sessions of an agent-browser namespace keep their files in `namespaces/<namespace>/run` below that directory, and may share a name with sessions of other namespaces. `runtime` takes the namespace as agent-browser does: `--namespace`, then `AGENT_BROWSER_NAMESPACE` (even when empty), then `namespace` in agent-browser's config file, turned into a directory name the same way (letters and digits lowercased, anything else one `-`). The proxy records the session per namespace. It finds the proxy where agent-browser connects: `AGENT_BROWSER_HUMANIZE_PORT` if set, otherwise the port of agent-browser's own CDP endpoint on this machine (`AGENT_BROWSER_CDP`, then `cdp` in agent-browser's config file, `AGENT_BROWSER_CONFIG` or `~/.agent-browser/config.json`), otherwise 9333. A session can switch tabs (`tab new`, `tab <ref>`) while Runtime is on, and the binding file then names the new tab. So `off` turns Runtime off in that tab and in every tab `on` turned it on for the session. It prints one line: `on` names the tab, `off` says in how many tabs Runtime was turned off. On failure it exits 1 with one line naming the reason: no binding for the session, the proxy is not running, or, for `on`, the tab is gone or no agent-browser connection is attached to it. Usage errors exit 2. Turn Runtime off again when done: while it is on, pages can detect it.

## How it works

agent-browser connects to the proxy exactly as it would to Chrome. The proxy answers the HTTP discovery endpoints (`/json/version`, `/json`, `/json/list`, `/json/new`, `/json/close/*`, `/json/activate/*`) from Chrome's, with WebSocket URLs pointing at itself. It pipes every `/devtools/...` WebSocket to the same path on Chrome. For each client connection it tracks which flattened CDP session belongs to which target, and the target's type, from `Target.attachedToTarget` events and `Target.attachToTarget` responses (Chrome sends the event, with the type, before the response; a page-level socket's own target comes from its path).

The proxy rewrites only `Runtime.enable`, `Runtime.disable`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText` and three agent-browser page functions it recognizes. It adds `background: true` to `Target.createTarget` and notes the tab Chrome creates, answers `Page.bringToFront` itself, and holds the answer to the `Page.enable` that brings a connection to a tab until the tab is emulated as focused. While a person [holds](#holds) a tab, it answers the client's actions on it itself. It sends its own commands on the same session the client used, with ids of its own. Chrome's responses to those stay in the proxy, and the client gets one answer per command, as if Chrome had run it. Everything else passes through byte for byte. Besides one upstream connection per client, the proxy has one DevTools connection of its own, the focus keeper.

### Runtime domain

- A client's `Runtime.enable` and `Runtime.disable` are answered locally with `{}` and never reach Chrome. The proxy only records whether the client wants the domain.
- Runtime is really enabled on a session only while the client wants it and its target has been switched on through the control API. When that changes, the proxy itself sends `Runtime.enable` or `Runtime.disable` on the session, and Runtime events then flow to the client as usual.
- Switching on is per target and per client connection, and never touches other targets. It ends by itself when the client disconnects (Chrome drops the connection's sessions with it) or when the target is detached or destroyed.
- Chrome replays a page's earlier console messages and exceptions when Runtime is enabled late, so `agent-browser console` and `errors` show the page's history after `runtime on`. While Runtime is off they stay empty. Everything else agent-browser does (navigation, snapshots including iframes, clicks, typing, screenshots, `eval`, `wait --fn`, network requests) works without it.

### Input rewrite rules

All coordinates the proxy sends are integers. Every delay and position is drawn afresh each time.

**Pointer** (per target):

- A `mouseMoved` without buttons means "move to (x, y)". The proxy finds the element there with `DOM.getNodeForLocation` and its box with `DOM.getBoxModel` (CDP only, no page script). It picks a random integer point in the box's central area: the middle half of the box, at most 40 px from the centre and from (x, y). It checks with `DOM.getNodeForLocation` that the point still hits the same element; if not, it uses (x, y) rounded. It then moves the pointer there from its last position along a path: 100-700 ms long depending on distance, a step every 8-16 ms, minimum-jerk easing, a slight curve and sub-pixel jitter. The client is answered after the last step, and its (x, y) is mapped to the chosen point for the following press, release or wheel.
- When the pointer is already at the point chosen for the same (x, y), nothing moves (a second click on the same element). Moves within 40 ms or 8 px of the previous one are a path the client draws itself (agent-browser's `--input-mode human`, `mouse move` sequences) and pass through.
- `mousePressed` uses the chosen point and `force: 0.5`, so pointer events report pressure 0.5. `mouseReleased` follows after a 60-140 ms hold, with `force: 0`. Moves while a button is held keep the press's offset, so drags stay continuous.
- A `clickCount: 2` press and release become two clicks (`clickCount` 1, then 2), each held, 80-140 ms apart.
- A `mouseWheel` delta over 120 px is split into 80-120 px steps 30-90 ms apart.

**Keyboard** (a US layout):

- `Input.insertText` with at most 120 characters is typed key by key. Each character gets `keyDown` (with `text`, `key`, `code`, `windowsVirtualKeyCode`) and `keyUp`. Characters that need Shift get a real Shift press around them (`key: "Shift"`, `code: "ShiftLeft"`, key code 16, `location: 1`; one press for a run of them) and the Shift modifier on their own events. `\n` becomes Enter and `\t` becomes Tab. Characters with no US key (accented letters, CJK, emoji) are inserted as text, consecutive ones together.
- Timing follows a professional typist: 9 characters per second on average (`AGENT_BROWSER_HUMANIZE_CPS`), key-down to key-down about 110 ms with natural variation and never under 55 ms, longer pauses after spaces, punctuation and line breaks. Keys are held 40-90 ms and released at least 10 ms before the next one goes down, except for an occasional rollover, where the next key goes down first. 120 characters take about 13-15 s, within agent-browser's 30 s limit per command.
- Longer text is forwarded unchanged as one `Input.insertText`.
- Burst guard: agent-browser's `type` sends one `insertText` per character. Once more than 120 single characters have arrived back to back (less than 1 s apart), the rest are forwarded at once, so the command stays within the 30 s limit.
- Client `keyDown`/`keyUp` (`press`, `keydown`, `keyup`, `keyboard`): a missing `code` or key code is filled in from the US layout. Shift, Control, Alt and Meta get their left-hand `code`, key code and `location: 1`, and carry their own modifier bit while down. A key whose modifiers are not already held gets real modifier key events around it; a character that needs Shift (`press @`) counts as modified. A `keyUp` waits until the key has been held 50-110 ms.

### Recognized page functions

agent-browser 0.42.0's page functions, recognized by their exact source from `cli/src/native/interaction.rs` (only whitespace is normalized):

- `function() { this.focus(); }` (`fill`, `type <sel>`, `focus`): for a text field (`<input>` of a text type, `<textarea>`, an element with `contenteditable`), a click into the field as above: `DOM.describeNode({objectId})`, then box, aim, path, press and release. If no point in the field is hittable, the proxy calls `DOM.scrollIntoViewIfNeeded` and tries again, and otherwise runs the original call. A `DOM.focus` afterwards keeps the original effect if the click did not focus the field. The client is answered as if the call had run. Other elements (buttons, links) keep the original `focus()`, because a click would activate them.
- The clear function of `fill` and `type --clear` (select, `value = ''`, untrusted `input` event): select-all with real key events, then Backspace. Select-all follows the platform Chrome runs on, which can differ from the proxy's: the proxy reads it once from the `User-Agent` of the upstream's `/json/version` (`Macintosh` on macOS, which Chrome's reduced User-Agent still names) and asks again later while Chrome does not answer, assuming its own platform meanwhile. On macOS it sends `Meta+A` with `commands: ["selectAll"]`, because Chrome takes the editing command for a shortcut from the OS there, which CDP key events bypass. Elsewhere it sends `Control+A`, which Chrome maps to select-all itself.
- `window.scrollBy(dx, dy)` (`scroll`): the pointer moves into the viewport if it is not there, then wheel steps scroll the same distance. The wheel scrolls whatever is under the pointer, and scrolling can bring a scrollable panel under it. So the proxy checks the page's scroll position between steps (`Page.getLayoutMetrics`). When a step did not move the page, it moves the pointer once to a spot over the page itself (`<html>` or `<body>`) and wheels the rest from there. Whatever is still left is scrolled with `window.scrollBy`, as the original call would have.
- `function(dx, dy) { this.scrollBy(dx, dy); }` (`scroll --selector`): the pointer moves into the visible part of the element, then wheel steps. An element outside the viewport keeps the original call.

Anything not recognized passes through unchanged, including these functions from another agent-browser version. The self-check shows when that happens.

### Focus emulation and the focus keeper

`Emulation.setFocusEmulationEnabled` makes Chrome treat one page as visible and focused, whatever its tab, window or screen: `document.visibilityState` is `visible`, `document.hasFocus()` is true, and animation frames run. So the tabs agent-browser works in need not be in front, and several sessions can work at once, each in its own tab.

Chrome keeps the two halves apart. Visibility is counted per DevTools session: each session that turned emulation on keeps the page visible while it is attached. Focus is one flag per page, and Chrome clears it as soon as any session that turned it on detaches. Every connected agent-browser enables `Page` on every new tab, so if each client session emulated on its own, one session ending would take the focus from the other sessions' tabs: still visible, but `hasFocus()` false. A session that attaches without emulating leaves the flag alone when it detaches. So one session owns the emulation:

- **The focus keeper** is the proxy's own DevTools connection to Chrome's browser endpoint (`webSocketDebuggerUrl` from the upstream's `/json/version`), opened when first needed. It is the only session that sends `Emulation.setFocusEmulationEnabled`; client sessions never get it. When its connection drops (Chrome quits, or does not answer one of its commands within 5 s), its state is cleared, and after 1 s it connects again and emulates the tabs still in use.
- **Reference counting.** A tab is in use while at least one client connection has a page session on it on which the client sent `Page.enable`; connections count, not commands or sessions. When a tab comes into use, the keeper attaches to it (`Target.attachToTarget {targetId, flatten: true}`) and sends `Emulation.setFocusEmulationEnabled {enabled: true}` on its own session. When the last connection stops using it (its sessions on the tab detach, the tab is destroyed, or the connection closes), the keeper detaches (`Target.detachFromTarget`), and a background tab is hidden again. Attaching and detaching for one tab run one after another, each for the state wanted when it starts, so a quick on, off, on ends emulated. A tab that closes while the keeper is attached just ends the keeper's session (`Target.detachedFromTarget`).
- **Pages load emulated.** agent-browser creates a tab (`about:blank`), attaches, enables `Page` and navigates, waiting for each answer. The `Page.enable` that brings a connection to a tab is sent as one of the proxy's own commands, and the client gets Chrome's answer once the keeper has emulated the tab as well. The page then gets a `visibilitychange` to visible and a `focus` event, as when a person switches to a tab. Later `Page.enable`s pass through. agent-browser enables `Page` on every tab it creates, switches to or restores, before the first navigation, so this covers every tab a session works in.
- A keeper failure is counted (`focus.keeper.failed`) and never reaches the client, which gets Chrome's answer to `Page.enable` all the same. A tab that closes before the keeper has attached to it counts too (CDP error -32602), so a few are normal. The keeper tries again when another connection starts using the tab, or after it reconnects.
- Only pages: a session whose target is known to be something else (`iframe`, `worker`, `service_worker`, `shared_worker`, `browser_ui`, ...) from `Target.attachedToTarget`'s `targetInfo.type` is skipped. A page-level socket's own session, and a session of unknown type, count as pages; a browser-level socket's own session does not.
- Counters: `focus.keeper.attach`, `focus.keeper.detach`, `focus.keeper.ended` (keeper sessions Chrome ended: the tab closed first, or the keeper's connection dropped), `focus.keeper.failed`. `/__humanize/health` shows `focus: { inUse, emulated }`, the number of tabs in use and of tabs the keeper emulates. The log has a line when the keeper connects or disconnects, and one for each failure, naming the step and the error (for Chrome's errors, only the CDP error code).

### Background tabs

Agent tabs never change what is on screen. With focus emulation they need not be in front, and a session must not cover the tab a person is working in.

- A client's `Target.createTarget` without `newWindow: true`, `background` or `focus: true` (which Chrome refuses together with `background: true`) gets `background: true`: Chrome adds the tab to its window without activating it. When there is no window for it (Chrome has none open, or the tab is in a new browser context, as with `window new`), Chrome opens one. This message is re-serialized; all others pass through byte for byte. agent-browser creates every tab this way: a pinned session's first tab, `tab new`, `click --new-tab`, `window new` and others.
- A client's `Page.bringToFront` (agent-browser sends it on `tab <ref>`, and for the fresh tab it opens when auto-connecting) is answered with `{}` and never reaches Chrome.
- `Target.activateTarget` passes through: agent-browser needs it to revive tabs Chrome discarded (Memory Saver).
- Counters: `target.background`, `Page.bringToFront.answered`.

### Tab ownership and leases

On a Chrome it did not start (`--cdp`, `--auto-connect`), agent-browser's `close` disconnects and leaves every tab the session opened, and nothing closes the tabs of a session that was forgotten, crashed or lost the machine it ran on. Whether a tab is still needed cannot be read from such events, which may never come. So every tab created through the proxy has an owner, and lives as long as the owner's lease:

- **Owner.** A client names its owner in the `X-Humanize-Owner` header when it connects (agent-browser: `--cdp-headers '{"X-Humanize-Owner":"<name>"}'` or `AGENT_BROWSER_CDP_HEADERS`); the name follows the rules of an agent-browser session name. A client without the header is an owner of its own for as long as it is connected. A tab belongs to the owner whose client created it (Chrome's answer to `Target.createTarget`); a tab a page opens itself (`window.open`, a link in a new tab) belongs to the owner of the tab that opened it.
- **Lease.** An owner's tabs are kept for an hour after any of them was last used: every command a client sends to a session of the tab renews the lease, whichever connection it comes from. `PUT /__humanize/lease/<owner>` renews it for an owner that is waiting without using the browser, and a person [holding](#holds) one of the tabs keeps it alive.
- **End.** Every minute the proxy closes the tabs of owners whose lease ran out, through Chrome's `/json/close`. `DELETE /__humanize/lease/<owner>` ends a lease at once. So does `close`: when agent-browser's binding of a session (`<session>.target` in its session directory, and in `namespaces/*/run` below it) names one of an owner's tabs with `pinned: false`, which only `close` writes, and no binding still pins one of them, the owner's tabs are closed a few seconds after it disconnects. `close` is a courtesy, not a duty.
- **Record.** Owners and leases are kept in `humanize-tabs.json` in agent-browser's session directory (`AGENT_BROWSER_SOCKET_DIR`, `$XDG_RUNTIME_DIR/agent-browser` or `~/.agent-browser`), so they outlive the proxy. A tab Chrome no longer has, because it was closed or Chrome started again, is dropped from the record at the next check. While Chrome does not answer, nothing is closed and nothing is dropped.
- Tabs without an owner are never closed: tabs people open, and tabs opened on Chrome directly.
- A session whose tab is gone, for whichever of these reasons, gets `tab_gone` from agent-browser and goes on with `tab new <url>`.
- Each closing is logged with the number of tabs and the reason. Counter: `tabs.closed`.

### Holds

A program with a DevTools connection of its own to Chrome (not through the proxy), such as a page that shows a tab to a person and forwards their input, can let the person take over an agent's tab. While the person is in control, it puts a hold on the tab through the [control API](#control-api) and renews it.

- While a tab is held, a client command to a session of that tab that acts on it never reaches Chrome. The proxy answers it with the CDP error `{ code: -32000, message: "The user has taken over this tab. Wait until they hand it back." }`. Actions are every `Input.*` method, `Page.navigate`, `Page.reload`, `Page.navigateToHistoryEntry`, `Page.close` and the [recognized page functions](#recognized-page-functions), and `Target.closeTarget` naming the tab, on any session. agent-browser prints the error (`✗ CDP error (<method>): The user has taken over this tab. ...`) and exits 1.
- Everything else passes through, so the agent can still read the tab (`snapshot`, `get`, `screenshot`) and see when the person is done.
- Input in progress when the hold starts (a pointer path, typed text, wheel steps) stops. The proxy at once releases the mouse buttons and keys it pressed on the tab and has not released, also those an earlier `mouse down` or `keydown` left pressed. The sequence sends nothing more, and at its next step, within a few hundred milliseconds, the client's command gets the same error. The tab's input state starts afresh, since the person moves the pointer.
- A hold ends when it is released or not renewed within its time (`ttl`, 15 s by default), so a program that crashed cannot lock the agent out. Holds are kept in memory: a restart of the proxy ends them.
- Holds change nothing else: the focus keeper's own sessions, focus emulation and background tabs work as before, and the tabs of ended sessions wait (see [above](#tabs-of-ended-sessions)).
- Counters: `hold.set`, `hold.renewed`, `hold.released`, `hold.expired` (counted when the proxy next looks at the tab or counts the holds), `hold.refused` (commands answered with the error), `hold.interrupted` (commands whose input was cut short). The log has a line when a hold starts or is released, with the number of tabs held.

### agent-browser self-check

Recognition depends on agent-browser's exact function sources, and the agent-browser version is not pinned. agent-browser is a Rust binary that embeds these sources verbatim as string literals, so the proxy looks for them in the installed binary: at startup, and again when a client connects or `/__humanize/health` is requested and the binary's path, size or modification time has changed since the last check. The check runs in the background and its result is cached; clients never wait for it.

- The binary is `AGENT_BROWSER_HUMANIZE_AGENT_BROWSER`, or `agent-browser` on `PATH`, with symlinks resolved. When that is a script (the npm JS shim) and the native `agent-browser-<platform>-<arch>` lies next to it, the check uses that one.
- It reads the binary as latin1, normalizes whitespace as recognition does, and looks for each recognizer's signature, listed next to the sources in `RECOGNIZERS` (`src/recognize.ts`): the sources of `focus`, `clear` and `scrollElement`, and for `scrollWindow` the prefix `window.scrollBy(`, the only part of the expression Rust's `format!` stores in one piece. It also runs `agent-browser --version` (5 s timeout).
- `/__humanize/health` shows the result as `agentBrowser: { path, version, recognizers: { focus, clear, scrollElement, scrollWindow } }`, or `agentBrowser: { error }` when agent-browser is not found.
- Each check logs one line: a short one when every signature is found, otherwise a line starting with `WARNING` that names the missing recognizers and what runs agent-browser's own page script again.

### What passes through

Every other command and event: navigation, `Target.*` (`Target.activateTarget` too), `Page.*` (`Page.enable` too, except the first of a connection on a tab, see [focus emulation](#focus-emulation-and-the-focus-keeper)), `Emulation.*`, `Network.*`, `DOM.*`, screenshots, `Runtime.evaluate` and `Runtime.callFunctionOn` (including agent-browser's own page script for snapshots, hit tests, `select`, `check`, `get`, `is` and `eval`), `Runtime.runIfWaitingForDebugger`, and the remaining `Input.*` methods (touch, drag, IME), except actions on a [held](#holds) tab.

### Why there is no `browser.provider` plugin

agent-browser can also get its CDP URL from a `browser.provider` plugin. In 0.41.2, though, it applies its tab binding only to `--cdp` and auto-connect attachments, not to provider attachments. A pinned session that connects through a provider adopts whatever tab Chrome lists first, which in a shared browser is another session's tab or a person's, instead of opening its own. It also ignores its binding after a daemon restart. With `--cdp` pointing at the proxy, pinning works exactly as it does against Chrome. The plugin would only have added a hook on `close`, and the proxy does not need one: Runtime goes off anyway when agent-browser disconnects.

## Control API

| Request | Result |
| --- | --- |
| `GET /__humanize/health` | `{ ok, version, upstream, connections, focus, holds, tabs, agentBrowser, stats }`; `version` is the proxy's version, `upstream` says whether Chrome answers, `focus` is `{ inUse, emulated }` (tabs a client connection uses, tabs the focus keeper emulates), `holds` the number of tabs held, `tabs` the number of tabs that have an owner, `agentBrowser` is the self-check's result, `stats` the counters. |
| `POST /__humanize/runtime` `{ targetId, enabled, session?, namespace? }` | On: `200 { targetId, enabled, sessions }`, and the tab is recorded for `session`. `404` when the tab is gone, `409` when no client is attached to it, `502` when Chrome does not answer. Off: turns off `targetId` and every tab recorded for `session`, then forgets them. It always answers `200 { targetId, enabled, tabs, sessions }`, also for a gone tab or one no client is attached to; `tabs` counts the tabs that had Runtime switched on. `namespace` keeps sessions of different agent-browser namespaces apart. Without `session`, only `targetId` is affected. `400` for a bad body; `session` is an agent-browser session name (letters, digits, `_`, `-`, at most 128 characters). Recorded tabs that no client connection knows anymore are forgotten. |
| `PUT /__humanize/hold/<targetId>?ttl=<seconds>` | [Holds](#holds) the tab, or renews its hold, for `ttl` seconds: whole seconds from 1 to 60, 15 without `ttl`. `200 { ok, targetId, expiresIn }`, `expiresIn` in seconds. `400` for a `targetId` that is not Chrome's (32 hexadecimal digits, upper case) or a bad `ttl`. The proxy does not check that the tab exists. |
| `DELETE /__humanize/hold/<targetId>` | Releases the hold: `200 { ok, targetId }`, also when there was none. `400` for a bad `targetId`. |
| `PUT /__humanize/lease/<owner>` | Keeps the owner's tabs for another hour ([leases](#tab-ownership-and-leases)): `200 { ok, owner, tabs, expiresIn }`, `tabs` the number it has. An owner without tabs has no lease, and `tabs` is 0. `400` for a name that is not an agent-browser session name. |
| `DELETE /__humanize/lease/<owner>` | Ends the owner's lease and closes its tabs now, or once no person holds one of them: `200 { ok, owner, tabs }`. |

## Security

- The proxy listens on 127.0.0.1 only. Like Chrome's own endpoint, it refuses requests that carry an `Origin` header (web pages) or a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- It is no security boundary. Like Chrome's debugging port, it lets anything on the machine that can reach it drive the browser, with every login in its profile. Keep Chrome's debugging port on loopback as well.
- It never logs, prints or stores typed text, `insertText` payloads or CDP message bodies, because password managers and other credential tools may type secrets through it. The log has connection counts, the focus keeper's connects and disconnects, the self-check's result and counters such as `text.typed.chars`.

## Known limits

- agent-browser's own page script stays as it is: snapshots, the hit test before a click, `select`, `check`, `get`, `is` and `eval` still run in the page (main world).
- Recognition is tied to agent-browser 0.42.0's exact function sources. After an upgrade that changes them, `fill` focuses and clears from page script again (and still types), and `scroll` uses `scrollBy`. Such a mismatch shows in `/__humanize/health` and as a `WARNING` in the log. The self-check only finds the sources in the binary; it cannot tell whether agent-browser still calls them the same way.
- A US keyboard layout is assumed. Characters it has no key for are inserted as text.
- Select-all follows the `User-Agent` Chrome reports in `/json/version`. A Chrome started with a `--user-agent` that names another platform gets that platform's shortcut.
- `keyboard inserttext`, meant to insert without key events, looks the same as `fill`'s insert at the CDP level and is typed too when it has at most 120 characters.
- `type <sel>` into a field that already has text inserts where the click put the caret.
- The wheel scrolls what is under the pointer. A panel may take a step before the proxy moves the pointer away. Wheel scrolling at the end of an element continues on the page (scroll chaining), where `scrollBy` would stop.
- The pointer position is kept per CDP session. A page and each of its out-of-process iframes have their own coordinates, so the first move inside such a frame starts from a guessed point.
- Once agent-browser has enabled the DOM domain (it does for snapshots), Chrome reports the path to each hit-tested node with `DOM.setChildNodes` events, which agent-browser ignores.
- Every emulated tab reports focus, so several tabs report focus at the same time, which a person's browser never does.
- A tab is emulated while any connected session has `Page` enabled on it, and that is more tabs than the sessions' own: the first existing tab a session enables domains on when it connects (often another session's or a person's), and every tab opened in Chrome while a session is connected, because agent-browser attaches to new tabs and enables `Page` on them without switching to them. Such a tab stays emulated until the last of those sessions has let go of it; one session ending does not take the focus from tabs other sessions still use.
- While the focus keeper reconnects (about a second, after its connection dropped with Chrome still running), background tabs in use report hidden and unfocused.
- Closing tabs at `close`, before their lease runs out, relies on the session files of agent-browser 0.42.0. If a later version changes them, tabs are closed only when the lease runs out.
- A tab created on Chrome directly, not through the proxy, has no owner and stays open.
- A session name whose tab is gone (after `close`, a lease that ran out, or a Chrome restart) gets `tab_gone` on `open` too and needs `tab new <url>`.
- A page-opened tab gets its owner from Chrome's target events, which reach the proxy only while a client that discovers targets is connected, as agent-browser is. One opened while no client is connected has no owner.
- Tabs that pages open themselves (`target=_blank`, `window.open`) are Chrome's decision and come to the front. So does a discarded tab that agent-browser revives with `Target.activateTarget`.
- The proxy never brings an agent tab to the front, so to take over a session's tab by hand, click it.
- A hold cannot classify page script: `Runtime.evaluate` and `Runtime.callFunctionOn` it does not recognize pass through, so `eval` and agent-browser's own page script (`select`, `check` and others) still run on a held tab. So do the steps agent-browser takes before input, such as scrolling the element into view, until the input itself is refused.
- A hold covers the sessions of the tab's own target. A session of an out-of-process iframe in the tab is a target of its own, and commands on it are not refused. Chrome's `/json/close/<targetId>` passes through for a held tab too; agent-browser closes tabs with `Target.closeTarget`.

## Development

```sh
bun install       # dev dependencies: TypeScript and Bun's types
bun run check     # tsc
bun test          # unit tests
```

The unit tests cover closing the tabs of ended sessions and reading agent-browser's session files, the US layout, Shift, typing timing, pointer paths, wheel steps, recognition, the self-check, the humanizer on both platforms, routing, holds, the focus keeper, background tabs, the browser platform and the command line.

```sh
bun test/integration.ts [--chrome <path>] [--headless] [--external]
```

The integration test drives agent-browser through the proxy against a real Chrome and checks what a page receives. It needs agent-browser and Chrome installed and takes a few minutes.

- By default it launches a Chrome of its own with a temporary profile and a free debugging port (`--remote-debugging-port=0`), and at the end, also on failure, quits it and deletes the profile. It never touches a browser you are using. `--chrome <path>` or `CHROME_PATH` picks the binary; otherwise it uses Google Chrome's usual location on macOS, or `google-chrome`, `google-chrome-stable` or `chromium` on `PATH` on Linux. The window is shown unless you pass `--headless`.
- The proxy and the probe page (`test/probe.html`) listen on free ports. agent-browser runs with a throwaway `AGENT_BROWSER_CONFIG` and session directory, as session `abh-test-int` and a few short-lived `abh-test-int-*` sessions.
- `--upstream <host:port>` attaches to a running Chrome instead. This is for advanced use: the test then opens tabs in that browser and closes them again.
- `--external` also runs rebrowser's public bot detector and checks its `runtimeEnableLeak`.

It checks the self-check's result in health and the log, that the tabs of a session that ended with `close` are closed while a session that shut down idle keeps its tab and comes back to it, that a tab a page opens gets its opener's owner and an ended lease closes both, that opening and switching session tabs leaves Chrome's focused tab alone (seen through `document.hasFocus()` in a control tab opened straight on Chrome, and skipped when that does not show a tab opened in front), that the session's tab is visible, focused and rendering, two sessions clicking and filling in their own tabs at the same time, a session's tab staying visible and focused and still taking a click and a `fill` after another session ended, an `alert` and a `confirm` handled with `dialog accept` and `dismiss` and a screenshot in a background agent tab, click points, holds and pressure, keystrokes and Shift for short `fill`s, select-all for the platform Chrome runs on, a single `insertText` for long ones, typing speed, wheel scrolling, and the `runtime` command with `agent-browser console` and after a tab switch. Run it after changing input rules and after upgrading agent-browser or Chrome.

### Releases

A release is a tag `v<version>` on `main`, where `<version>` is the `version` in `package.json`. To make one, change the version in `package.json` and merge that commit to `main`, then tag it and push the tag:

```sh
git tag v0.2.0 origin/main
git push origin v0.2.0
```

The [release workflow](.github/workflows/release.yml) refuses a tag that does not match `package.json` or is not on `main`, runs `bun run check` and `bun test`, packs `agent-browser-humanize-<version>.tar.gz`, checks that the packed command reports that version, and attaches the tarball to the tag's GitHub Release, which it creates if there is none. A version with a `-`, such as `0.2.0-rc.1`, is marked as a prerelease.

## License

[MIT](LICENSE)
