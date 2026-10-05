# dsh-sidebar-browser-cdp

A DSH plugin that gives the agent `browser_*` tools operating **DSH Desktop's
built-in browser** — the very Browser tab in the right sidebar.

## Why raw CDP, and not Playwright or Puppeteer

The built-in browser is an Electron `<webview>`. Electron exposes it as a target
of type `webview`, while Playwright and Puppeteer enumerate only targets of type
`page`. A client built on them that attaches to the app's debug port finds only
the app shell (`dsh-app://app/`), not the page. Measured on a live app with
`playwright-core` and `puppeteer-core`; the probes are in this repository
(`../probes/probe.mjs`, `../probes/pp-test.mjs`).

This plugin therefore talks to the guest's own `webSocketDebuggerUrl` from
`/json/list` and selects targets strictly by `type === 'webview'`, so the app
shell can never be picked by accident.

## Requirement

```sh
open -a "DeepSeek Harness" --args --remote-debugging-port=9222
```

Plus an open Browser tab in the right sidebar (the guest is created lazily). The
port is loopback-only; without it the tools return an actionable error instead of
staying silent.

## Tools

| Tool | What it does |
|---|---|
| `browser_tabs` | list sidebar tabs and show which one is controlled |
| `browser_snapshot` | title, URL, and a numbered inventory of interactive elements |
| `browser_navigate` | go to a URL in the current tab |
| `browser_click` | click by snapshot number (single or double) |
| `browser_type` | type into an element (React/Vue safe, `replace` clears first) |
| `browser_press` | one key: Enter, Tab, Escape, arrows, a character |
| `browser_scroll` | up / down / top / bottom, scrolling whichever element really scrolls |
| `browser_text` | visible page text |
| `browser_html` | outerHTML of an element by number |
| `browser_eval` | evaluate JS in the page |
| `browser_screenshot` | PNG of the viewport, or of a long page as viewport-sized slices |
| `browser_history` | back / forward / reload |
| `browser_cookies_export` | save a site's cookies to the vault (current host by default, `all: true` for everything) |
| `browser_cookies_import` | put a vault back and reload the page |
| `browser_cookies_vaults` | what is in the vault: files, cookie counts, save times |

Element numbers are written onto the page as a `data-dsh-idx` attribute and stay
valid until the next `browser_snapshot`.

## The cookie vault, and why it exists

The built-in browser lives in a **process-lifetime** session: the shell creates
each guest in a partition named `dsh-sidebar-browser-<uuid>` (no `persist:`
prefix), so cookies, logins and localStorage die with the app. That is by design,
and it cannot be changed from outside.

The vault is a blunt workaround: `browser_cookies_export` pulls cookies over CDP
into `~/.dsh/cookie-vault/<domain>.json` (mode `600`), and
`browser_cookies_import` writes them back after a restart and reloads the page.
The file holds live session tokens — by risk it is a password, so keep it local.
The directory is configurable through `vaultDir`.

## Measured limitations of the Electron webview

| What | How it behaves |
|---|---|
| `captureBeyondViewport` | lies: it repeats the current viewport instead of rendering the page (one infobox in the DOM, three in the image). `full: true` therefore scrolls and captures slices |
| `Page.reload` on a guest | can take the target down with it; reload is implemented as a navigation to the current URL |
| Socket closing mid-call | used to hang the call forever; every pending command now rejects with a hint to reopen the tab |
| SPA scrolling | the window does not move while an inner container scrolls — the tools resolve the target themselves |

## Install and maintenance

```sh
# dependencies first: the plugin is linked (link:), so its imports resolve from
# its own folder and node_modules here is required
npm install

# install into the desktop profile (the app bundles its own dsh CLI)
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "$PWD"

# verify without restarting the app: 15 tools, live calls, and the error path
node selftest.mjs
```

Edits to `lib/index.js` are picked up when the app restarts (a profile with HMR
may pick them up sooner). Full rollback: untick or remove the bundle in the
Plugins page, or drop `dsh-sidebar-browser-cdp` from `dependencies` and from
`dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`.
