# dsh-sidebar-browser

Drive **DSH Desktop's built-in sidebar browser** from an agent: a plugin that adds
`browser_*` tools, plus a standalone CLI that does the same thing with zero
dependencies.

The built-in browser is an Electron `<webview>` living in the right sidebar. Out
of the box it is user-facing only — the shipped package
`@deepseek-ai/dsh-client-ui-sidebar-browser` registers a UI tab and no model
tools at all (its host half is literally `function apply() {}`). This project
closes that gap without touching the app bundle.

```
agent ──browser_* tools──▶ raw CDP ──▶ Electron <webview> guest  ◀── you, watching the same page
```

## Why raw CDP, and not Playwright or Puppeteer

Electron reports a sidebar guest as a CDP target of type **`webview`**.
Playwright and Puppeteer only enumerate targets of type `page`, so both ignore
it — and worse, when you ask them to attach to the app's debug port they happily
pick the app shell instead:

```console
$ node probes/probe.mjs          # playwright-core, connectOverCDP
contexts: 1
  ctx0 app-shell :: dsh-app://app/
RESULT: no webview page found

$ node probes/pp-test.mjs        # puppeteer-core, connect()
puppeteer pages(): 1
  - dsh-app://app/ | <the harness UI>
!! puppeteer cannot see the webview as a page
```

That is why every browser plugin built on those libraries ends up driving the
harness interface rather than the page you are looking at. This plugin talks to
the guest's own `webSocketDebuggerUrl` instead and filters strictly on
`type === 'webview'`, so the app shell can never be picked by accident.

## Requirements

```sh
open -a "DeepSeek Harness" --args --remote-debugging-port=9222
```

* DSH Desktop **0.2.0-rc.2** or newer (measured on Electron 44 / Chrome 152, macOS).
* The app must be started **with the debug port** — otherwise the tools exist but
  every call fails with an actionable message.
* A **Browser tab must be open** in the right sidebar: the shell creates the
  guest lazily, so the port alone is not enough.
* Node.js ≥ 20 for the CLI (the plugin runs inside the app).

## Install the plugin

The plugin is installed into a DSH *profile* (the `desktop` profile for DSH
Desktop), not into a project, so the tools are then available in every workspace.

```sh
git clone https://github.com/alesha-pro/dsh-sidebar-browser.git
cd dsh-sidebar-browser/plugin
npm install                      # required: see the note below

dsh plugin --profile desktop add "$PWD"
# restart DSH Desktop afterwards, launched with the debug port
```

> **Why `npm install` inside `plugin/`?** `dsh plugin add <path>` links the
> folder (`link:`) instead of copying it, so the plugin's own imports
> (`@deepseek-ai/dsh-tools`, `schemastery`) resolve relative to its own
> directory. Without `node_modules` there the bundle fails to load.

Verify without restarting the app — the self-test runs the plugin's real code
against the live debug port with a stub context:

```sh
node plugin/selftest.mjs
```

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
| `browser_cookies_export` | save a site's cookies into a local vault |
| `browser_cookies_import` | restore that vault after a restart |
| `browser_cookies_vaults` | list saved vaults |

Element numbers come from the last `browser_snapshot` and are written onto the
page as a `data-dsh-idx` attribute.

## CLI

Same engine, no dependencies, no DSH install needed — useful for scripting and
for checking the mechanism by hand:

```sh
node cli/browser.mjs tabs
node cli/browser.mjs snapshot
node cli/browser.mjs click 12
node cli/browser.mjs type 3 "hello" --replace
node cli/browser.mjs press Enter
node cli/browser.mjs scroll down 800
node cli/browser.mjs text --max 4000
node cli/browser.mjs eval "document.title"
node cli/browser.mjs screenshot out.png --full
node cli/browser.mjs navigate example.com
node cli/browser.mjs back | forward | reload
node cli/browser.mjs html 12
```

## Sessions and cookies

The built-in browser **keeps no storage between app runs, by design**. The
desktop shell reserves its guests in a process-lifetime partition:

```js
// DesktopBrowserGuests.acquire(owner, workspace)
partition = `dsh-sidebar-browser-${randomUUID()}`
this.configureSession(session.fromPartition(partition))
```

No `persist:` prefix means an in-memory session, and the random UUID would start
empty on the next launch anyway. The same session also denies every permission
request, blocks downloads, and allows only `http(s)`, `data` and `blob` requests
that do not target the harness itself.

So logins disappear when you quit — that is expected, not a bug. The cookie
vault is the workaround:

```sh
# while logged in, before quitting
#   browser_cookies_export {}                     -> ~/.dsh/cookie-vault/<host>.json
# after restarting, with the tab open
#   browser_cookies_import { domain: "example.com" }
```

Vault files are written with mode `600` into a `700` directory, and they contain
**live session tokens in plaintext** — treat them like passwords, and never
commit them (`.gitignore` already excludes them).

## Measured quirks of the Electron webview

| Behaviour | What actually happens |
|---|---|
| `Page.captureScreenshot` with `captureBeyondViewport` | repeats the viewport instead of rendering the page. Confirmed against the DOM: one `<h1>` and one infobox, three copies in the image. `full: true` therefore scrolls and captures slices |
| `Page.reload` on a guest | can take the CDP target down with it; reload is implemented as a navigation to the current URL |
| Target disappearing mid-call | every pending command now rejects with a hint instead of hanging forever |
| SPA scrolling | `window.scrollY` stays 0 while an inner container scrolls, so tools resolve the scroll target themselves |
| Reading tall images | viewer limit of 8192 px per side — long pages are read as slices or cropped |

## Security

* The debug port is bound to loopback, but while it is open any local process
  can attach to the app shell, not just to the browser tab. Start the app with
  the flag when you need the tools, not permanently.
* Host code from a plugin runs in-process, outside the workspace sandbox. Read
  the source before installing anything into a profile.
* Nothing here modifies `DeepSeek Harness.app`: no `app.asar` unpacking, no
  signature damage. The only change to your system is a bundle entry in the
  profile and, if you use it, the cookie vault.

## Layout

| Path | What it is |
|---|---|
| `plugin/` | the DSH bundle: `lib/index.js`, `cordis.patch.yml`, self-test |
| `cli/browser.mjs` | standalone raw-CDP CLI, no dependencies |
| `probes/` | the negative results above, reproducible: Playwright and Puppeteer both miss the guest |

## License

MIT. Not affiliated with DeepSeek; DSH internals were inspected read-only from
an installed copy.
