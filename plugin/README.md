# dsh-sidebar-browser-cdp

A DSH plugin that lets the agent use DSH Desktop's built-in browser, the
Browser tab in the right sidebar. It adds 17 `browser_*` tools and works with
the app started the normal way.

Full documentation: https://github.com/alesha-pro/dsh-sidebar-browser

## Install

In DSH Desktop open Plugins, press Add plugin and enter
`dsh-sidebar-browser-cdp`. Press Install, then Enable now, and start a new
session. `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` are peer
dependencies and come from the running app.

## Two transports

The plugin has a host half (`lib/index.js`, the tools) and a client half
(`lib/client.js`) that DSH loads into its own window. By default a tool call
goes to the window, which drives the sidebar `<webview>` with the element's own
methods and the sidebar service. No launch flag is involved.

Started with `--remote-debugging-port=9222`, the app also accepts raw CDP on the
webview target. That path is required for `browser_cookies_export`, because a
login lives in `HttpOnly` cookies that no page script can read, and it turns
`browser_screenshot` into a pixel capture. Without the port a screenshot is
rendered in-page from the DOM by the vendored modern-screenshot library
(`lib/vendor/`, MIT).

The `transport` setting picks the path: `auto` (default), `window` or `cdp`.

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | open a new Browser tab (expands the sidebar) and load a URL |
| `browser_close` | close a sidebar tab by title or the active one, or collapse the sidebar |
| `browser_tabs` | list browser tabs and show which one is controlled |
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
| `browser_cookies_import` | restore a vault, or a cookie file exported from a regular browser, and reload |
| `browser_cookies_export` | save a site's cookies to the vault; needs the debug port |
| `browser_cookies_vaults` | what is in the vault: files, cookie counts, save times |

## Development

Link a local clone instead of installing from npm. A linked folder resolves
imports from its own directory, so it needs `node_modules`:

```sh
npm install
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "$PWD"

# the debug-port path against a live app started with the port
node selftest.mjs
```

Edits to `lib/` are picked up when the app restarts. Full rollback: uninstall
the bundle on the Plugins page, or drop `dsh-sidebar-browser-cdp` from
`dependencies` and from `dsh.profile.bundles` in
`~/.dsh/profiles/desktop/package.json`.
