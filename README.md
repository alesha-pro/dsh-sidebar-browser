# dsh-sidebar-browser

**English** · [Русский](README.ru.md)

A plugin for DSH Desktop (DeepSeek Harness) that lets the model use the built-in browser. It adds 17 `browser_*` tools that open and close tabs in the right sidebar and read, click, type, scroll and screenshot the page in them. It is the same Browser tab you are looking at.

<p align="center">
  <img src="docs/demo.gif" alt="DeepSeek V4.1 Flash in DSH Desktop opens Wikipedia in the sidebar browser, finds the RTX 3090 article and highlights the 24 GB cell" width="800">
</p>

Real session at 4x speed: the model navigates, searches, scrolls and highlights the answer in the sidebar tab.

DSH Desktop ships that browser for the human only. The package `@deepseek-ai/dsh-client-ui-sidebar-browser` registers a UI tab and no model tools, and its host half is a single line, `function apply() {}`. The other browser plugins I found either drive a separate Chrome or Chromium window, or reach the sidebar by unpacking `app.asar`, which invalidates the app's code signature on macOS. This one works in the sidebar tab itself and does not modify `DeepSeek Harness.app`.

## Quick start

Open **Plugins** in DSH Desktop, press **Add plugin** and paste this address:

```
github:alesha-pro/dsh-sidebar-browser#path:/plugin
```

The same plugin is on npm, so this also works in that field:

```
dsh-sidebar-browser-cdp@0.2.0
```

Keep the version in the name. DSH installs through pnpm, and pnpm skips versions published less than a day ago when you give it a bare name.

Press **Install**, then **Enable now**. DSH downloads the plugin and its dependencies itself. The tools show up in the next new session, and I did not have to restart the app for that.

The tools need a debug port, so quit DSH Desktop and start it like this:

```sh
open -a "DeepSeek Harness" --args --remote-debugging-port=9222
```

Ask the agent to do something in the browser. It opens a tab itself with `browser_open`, or works in a Browser tab you already have open in the right sidebar. A plugin installed this way lives in the `desktop` profile and is available in every workspace.

The same install from a terminal, with the app closed:

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "github:alesha-pro/dsh-sidebar-browser#path:/plugin"
```

The desktop app bundles its own `dsh` CLI at that path. If `dsh` is already on your `PATH`, use it instead.

### Install from a local clone

Use this when you want to edit the plugin. `dsh plugin add <path>` links the folder instead of copying it, so the plugin needs its own `node_modules`.

```sh
git clone https://github.com/alesha-pro/dsh-sidebar-browser.git
cd dsh-sidebar-browser/plugin
npm install
"$DSH" plugin --profile desktop add "$PWD"
```

The self-test loads the plugin code with a stub context and calls it against the live debug port, which lets you check an edit before restarting the app:

```sh
node plugin/selftest.mjs
```

## Requirements

* DSH Desktop 0.2.0-rc.2. I measured everything here on that build (Electron 44, Chrome 152) on macOS. Windows and Linux are untested.
* The app has to be started with `--remote-debugging-port`. Without it the tools still register, and every call returns an error that tells you how to start the app.
* The page tools need a Browser tab that has loaded a URL. The shell creates the webview lazily, so `browser_open` or a tab opened by hand has to come first.
* Node.js 20 or newer for the CLI. The plugin itself runs inside the app.

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | opens a new Browser tab, expands the sidebar if it is collapsed, and loads a URL |
| `browser_close` | closes a sidebar tab by title or the active one, or collapses the sidebar |
| `browser_tabs` | lists sidebar tabs and shows which one is controlled |
| `browser_snapshot` | title, URL and a numbered list of interactive elements |
| `browser_navigate` | opens a URL in the current tab |
| `browser_click` | clicks an element by its snapshot number, single or double |
| `browser_type` | types into an element; works with React and Vue inputs, `replace` clears the field first |
| `browser_press` | sends one key: Enter, Tab, Escape, arrows or a character |
| `browser_scroll` | up, down, top or bottom, on whichever element scrolls the page |
| `browser_text` | visible page text |
| `browser_html` | outerHTML of an element by number |
| `browser_eval` | evaluates JavaScript in the page |
| `browser_screenshot` | PNG of the viewport, or a long page as viewport-sized slices |
| `browser_history` | back, forward, reload |
| `browser_cookies_export` | saves a site's cookies into a local vault |
| `browser_cookies_import` | restores a vault after a restart |
| `browser_cookies_vaults` | lists saved vaults |

Element numbers come from the last `browser_snapshot`. The snapshot writes them onto the page as a `data-dsh-idx` attribute, and they stay valid until the next snapshot.

## Raw CDP instead of Playwright or Puppeteer

<p align="center">
  <img src="docs/hero.svg" alt="The agent calls browser tools, the plugin speaks raw CDP to the sidebar webview, and you watch the same tab" width="880">
</p>

Electron reports the sidebar webview as a CDP target of type `webview`. Playwright and Puppeteer list only targets of type `page`. When you connect either library to the app's debug port, the only page it finds is the harness UI:

```console
$ node probes/probe.mjs          # playwright-core, connectOverCDP
contexts: 1
  ctx0 app-shell :: dsh-app://app/
RESULT: no webview page found

$ node probes/pp-test.mjs        # puppeteer-core, connect()
puppeteer pages(): 1
  - dsh-app://app/ | <the harness UI>
all targets:
   webview :: https://example.com/
   page :: dsh-app://app/
!! puppeteer cannot see the webview as a page
```

An agent attached that way would click around the harness interface. This plugin reads `/json/list`, keeps only targets with `type === 'webview'`, and talks to that target's own `webSocketDebuggerUrl`. The page tools filter the app shell out before a connection is made. Both probes are in `probes/` if you want to reproduce the result.

Opening and closing tabs is different, because the shell owns the sidebar and a page cannot create its own tab. `browser_open` and `browser_close` attach to the app window and press its own controls: expand the sidebar, new tab, the Browser entry, the address field, the close button of a tab. They find those controls by the shell's `data-*` attributes, which do not change with the UI language. The attributes are internal to DSH Desktop 0.2.0-rc.2 and a later build can rename them.

## CLI

`cli/browser.mjs` is the same engine as a standalone script with no dependencies. It needs the debug port and an open Browser tab, and it is handy for scripting or for checking the mechanism by hand.

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

## Logins and the cookie vault

The built-in browser forgets logins when you quit the app. The desktop shell gives each workspace a session partition with a random name and no `persist:` prefix, which in Electron means an in-memory session:

```js
// DesktopBrowserGuests.acquire(owner, workspace)
partition = `dsh-sidebar-browser-${randomUUID()}`
this.configureSession(session.fromPartition(partition))
```

The same session denies every permission request, blocks downloads, and allows only `http(s)`, `data` and `blob` requests that do not target the harness itself. A plugin cannot change any of this from outside.

The cookie vault works around the lost logins. Log in by hand, export before you quit, and import after the next start:

```
browser_cookies_export {}                          -> ~/.dsh/cookie-vault/<host>.json
browser_cookies_import { domain: "example.com" }   after a restart, with the tab open
```

I tested the round trip on a real login. After a full app restart the import restored 6 of 6 cookies and the site's session endpoint answered as authenticated. A vault is a snapshot, so export again after you log in again or after the site rotates its token.

Vault files are written with mode `600` into a `700` directory. They hold live session tokens in plaintext, so treat them like passwords. `.gitignore` already excludes them.

## Measured quirks of the Electron webview

| Behaviour | What happens |
|---|---|
| `Page.captureScreenshot` with `captureBeyondViewport` | The image repeats the viewport instead of showing the full page. The DOM had 1 `<h1>` and 1 infobox while the image had 3 copies. `full: true` scrolls and captures slices instead |
| `Page.reload` on the webview | It can take the CDP target down. Reload is implemented as a navigation to the current URL |
| Keyboard shortcuts | `Cmd+T` sent over CDP does not open a tab, so `browser_open` clicks the controls instead |
| Target disappearing mid-call | Pending commands reject with a hint to reopen the tab |
| SPA scrolling | `window.scrollY` stays at 0 while an inner container scrolls. The tools find the element that scrolls and report its position |
| Tall screenshots | The image reader in DSH rejects images over 8192 px per side, which is one more reason long pages come back as slices |

## Security

* The debug port listens on loopback. While it is open, any local process can attach to the entire app, including the harness UI. Start the app with the flag when you need the tools, and start it normally the rest of the time.
* Host code from a plugin runs in-process, outside the workspace sandbox. Read `plugin/lib/index.js` before you install it. It is one file.
* `browser_eval` runs arbitrary JavaScript in the page, and the cookie tools read `httpOnly` cookies over CDP. Use them on sites where you would accept the agent acting as you.
* The plugin does not unpack `app.asar` and does not touch the app's code signature. It changes two things on your machine: a bundle entry in `~/.dsh/profiles/desktop/package.json` and, if you use it, `~/.dsh/cookie-vault/`.

## Uninstall

Uninstall the bundle on the Plugins page, or delete `dsh-sidebar-browser-cdp` from `dependencies` and from `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`. Delete `~/.dsh/cookie-vault/` if you exported any cookies.

## Layout

| Path | What it is |
|---|---|
| `plugin/` | the DSH bundle: `lib/index.js`, `cordis.patch.yml`, the self-test |
| `cli/browser.mjs` | standalone raw-CDP CLI |
| `probes/` | the Playwright and Puppeteer probes quoted above |

## License

MIT. This project is not affiliated with DeepSeek. I read DSH internals from an installed copy and did not modify it.
