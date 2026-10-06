# dsh-sidebar-browser

**English** · [Русский](README.ru.md)

A plugin for DSH Desktop (DeepSeek Harness) that lets the model use the built-in browser. It adds 17 `browser_*` tools that open and close tabs in the right sidebar and read, click, type, scroll and screenshot the page in them. It is the same Browser tab you are looking at, and it works with the app started the normal way.

<p align="center">
  <img src="docs/demo.gif" alt="DeepSeek V4.1 Flash in DSH Desktop opens Wikipedia in the sidebar browser, finds the RTX 3090 article and highlights the 24 GB cell" width="800">
</p>

Real session at 4x speed: the model navigates, searches, scrolls and highlights the answer in the sidebar tab.

DSH Desktop ships that browser for the human only. The package `@deepseek-ai/dsh-client-ui-sidebar-browser` registers a UI tab and no model tools, and its host half is a single line, `function apply() {}`. The other browser plugins I found either drive a separate Chrome or Chromium window, or reach the sidebar by unpacking `app.asar`, which invalidates the app's code signature on macOS. This one works in the sidebar tab itself and does not modify `DeepSeek Harness.app`.

## Quick start

Open **Plugins** in DSH Desktop, press **Add plugin** and enter the package name:

```
dsh-sidebar-browser-cdp
```

The Git address works in the same field and always installs the latest commit:

```
github:alesha-pro/dsh-sidebar-browser#path:/plugin
```

Press **Install**, then **Enable now**. DSH downloads the plugin and its dependencies itself. Start a new session and ask the agent to do something in the browser. It opens a tab itself with `browser_open`, or works in a Browser tab you already have open in the right sidebar.

You do not need any launch flag. A plugin installed this way lives in the `desktop` profile and is available in every workspace.

The same install from a terminal, with the app closed:

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add dsh-sidebar-browser-cdp
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

## Requirements

* DSH Desktop 0.2.0-rc.2. I measured everything here on that build (Electron 44, Chrome 152) on macOS. Windows and Linux are untested.
* An open DSH Desktop window. The plugin has a half that runs in the window, and the tools talk to the page through it.
* The page tools need a Browser tab that has loaded a URL. The shell creates the webview lazily, so `browser_open` or a tab opened by hand has to come first.
* The debug port is optional and serves 2 things described below. Start the app with `open -a "DeepSeek Harness" --args --remote-debugging-port=9222` when you want them.

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | opens a new Browser tab, expands the sidebar if it is collapsed, and loads a URL |
| `browser_close` | closes a sidebar tab by title or the active one, or collapses the sidebar |
| `browser_tabs` | lists browser tabs and shows which one is controlled |
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
| `browser_cookies_import` | restores a saved login after a restart |
| `browser_cookies_export` | saves a site's cookies into a local vault; this one needs the debug port |
| `browser_cookies_vaults` | lists saved vaults |

Element numbers come from the last `browser_snapshot`. The snapshot writes them onto the page as a `data-dsh-idx` attribute, and they stay valid until the next snapshot.

## Transports

<p align="center">
  <img src="docs/hero.svg" alt="The agent calls browser tools, the plugin reaches the sidebar webview through the app window, and you watch the same tab" width="880">
</p>

The plugin has 2 halves. The host half registers the tools. The client half (`plugin/lib/client.js`) is loaded into the DSH window by the app's own plugin loader, next to the right sidebar. A tool call becomes a command in a queue, the window picks it up over 2 routes on DSH's own web server, runs it and posts the result back.

In the window the client half uses what the app already exposes:

* the sidebar service (`sidebarRight.openTab`, `close`, `toggleExpanded`) to open and close tabs;
* the `<webview>` element's own methods (`executeJavaScript`, `sendInputEvent`, `insertText`, `loadURL`, `goBack`) for everything on the page. Clicks and key presses sent this way arrive as trusted events.

`browser_tabs` tells you which path a call took: `via the app window` or `via the debug port`.

### Screenshots without a debug port

The `<webview>` element has a `capturePage()` method, and calling it from the window crashes the window's renderer process on this build. So without the port the page draws itself. The plugin loads [modern-screenshot](https://github.com/qq15725/modern-screenshot) (MIT, vendored in `plugin/lib/vendor/`) into the page, which clones the DOM into an SVG `foreignObject` and paints it on a canvas. Layout, text and fonts are the browser's own, and on Wikipedia, GitHub and Hugging Face I could not tell the result from a pixel capture at a glance.

It is still a re-render and not a capture. Canvas, video, iframes and images served without CORS can come out blank, and the tool says `rendered in-page from the DOM` in its output. One viewport takes a few seconds. When the app runs with the debug port, `browser_screenshot` takes a pixel capture instead.

### Debug port

Start the app with `--remote-debugging-port=9222` and the plugin can also talk raw CDP to the webview. That path is needed for 1 thing and improves another:

* `browser_cookies_export` needs it. A login lives in `HttpOnly` cookies, and no page script can read those.
* `browser_screenshot` becomes a pixel capture.

Playwright and Puppeteer cannot serve as that CDP client. Electron reports the sidebar webview as a target of type `webview`, both libraries list only targets of type `page`, and the only page they find is the harness UI:

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

The plugin reads `/json/list`, keeps only targets with `type === 'webview'`, and talks to that target's own `webSocketDebuggerUrl`. Both probes are in `probes/` if you want to reproduce the result.

The `transport` setting of the bundle picks the path: `auto` (the default) prefers the app window and uses the port where it is needed, `window` and `cdp` force one.

## CLI

`cli/browser.mjs` is the debug-port engine as a standalone script with no dependencies. It needs the app started with the port and an open Browser tab, and it is handy for scripting or for checking the mechanism by hand.

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

`node plugin/selftest.mjs` loads the plugin code with a stub context and runs its debug-port path against the live app.

## Logins and the cookie vault

The built-in browser forgets logins when you quit the app. The desktop shell gives each workspace a session partition with a random name and no `persist:` prefix, which in Electron means an in-memory session:

```js
// DesktopBrowserGuests.acquire(owner, workspace)
partition = `dsh-sidebar-browser-${randomUUID()}`
this.configureSession(session.fromPartition(partition))
```

The same session denies every permission request, blocks downloads, and allows only `http(s)`, `data` and `blob` requests that do not target the harness itself. A plugin cannot change any of this from outside.

The cookie vault works around the lost logins. A vault is a file in `~/.dsh/cookie-vault/`, and restoring one needs no debug port:

```
browser_cookies_import { domain: "example.com" }
```

There are 2 ways to get the file:

* Export it from DSH. Start the app once with the debug port, log in, and call `browser_cookies_export {}`. This is the only step in the plugin that needs the port.
* Export the site's cookies from your regular browser, as Cookie-Editor JSON or a Netscape `cookies.txt`, and save the file as `~/.dsh/cookie-vault/<site>.json`. `browser_cookies_import` reads those formats too.

Without the port the page sets the cookies itself through `document.cookie`. A script cannot set the `HttpOnly` attribute, and the server never sees that attribute, so the login still comes back. In my test the server received a `__Secure-` and a `__Host-` cookie restored this way. The price is that the restored cookies are readable by the site's own scripts in that tab. With the port open the import sets real `HttpOnly` cookies.

I tested the full round trip on a real login over the debug port. After an app restart the import restored 6 of 6 cookies and the site's session endpoint answered as authenticated. A vault is a snapshot, so export again after you log in again or after the site rotates its token.

Vault files are written with mode `600` into a `700` directory. They hold live session tokens in plaintext, so treat them like passwords. `.gitignore` already excludes them.

## Measured quirks of the Electron webview

| Behaviour | What happens |
|---|---|
| `capturePage()` on the `<webview>` element | Called from the app window it crashes the window's renderer process (`EXC_BREAKPOINT`) and the app hangs. The plugin never calls it |
| `Page.captureScreenshot` on a covered window | A window that is fully covered does not paint, and the call never answers. The plugin waits 6 seconds and falls back to the in-page render |
| `Page.captureScreenshot` with `captureBeyondViewport` | The image repeats the viewport instead of showing the full page. The DOM had 1 `<h1>` and 1 infobox while the image had 3 copies. `full: true` scrolls and captures slices instead |
| `Page.reload` over CDP | It can take the CDP target down. Over the port, reload is a navigation to the current URL |
| Keyboard shortcuts | `Cmd+T` sent over CDP does not open a tab. Tabs are opened through the sidebar service |
| Pages with `scroll-behavior: smooth` | A scroll call returns before the page has moved, so the tools force an instant jump |
| SPA scrolling | `window.scrollY` stays at 0 while an inner container scrolls. The tools find the element that scrolls and report its position |
| Errors on pages that forbid `eval` | `executeJavaScript` reports a thrown error as 1 generic message. On a page whose CSP allows `eval` the plugin recovers the real text, on GitHub it cannot |
| Tall screenshots | The image reader in DSH rejects images over 8192 px per side, which is one more reason long pages come back as slices |

## Limits

* The tools act on the Browser tab that is visible in the window. If the agent works in one session while you look at another, it will drive the tab you are looking at.
* A cookie that belongs to a different host than the page cannot be restored without the debug port. The import reports it by name.

## Security

* In the default mode the plugin opens no port. It adds 2 routes to the web server DSH already runs for its own window, `/dsh-sidebar-browser/poll` and `/dsh-sidebar-browser/reply`. They accept only JSON `POST` requests, which a web page cannot send cross-origin without a preflight. I did not audit how DSH itself protects that server.
* The debug port, if you use it, listens on loopback. While it is open, any local process can attach to the entire app, including the harness UI. Start the app with the flag when you need it, and start it normally the rest of the time.
* Host code from a plugin runs in-process, outside the workspace sandbox. Read `plugin/lib/index.js` and `plugin/lib/client.js` before you install it.
* `browser_eval` runs arbitrary JavaScript in the page, and the cookie tools handle session tokens. Use them on sites where you would accept the agent acting as you.
* The plugin does not unpack `app.asar` and does not touch the app's code signature. It changes two things on your machine: a bundle entry in `~/.dsh/profiles/desktop/package.json` and, if you use it, `~/.dsh/cookie-vault/`.

## Uninstall

Uninstall the bundle on the Plugins page, or delete `dsh-sidebar-browser-cdp` from `dependencies` and from `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`. Delete `~/.dsh/cookie-vault/` if you exported any cookies.

## Layout

| Path | What it is |
|---|---|
| `plugin/lib/index.js` | host half: the tools, the command queue, the debug-port client |
| `plugin/lib/client.js` | client half: runs in the DSH window and drives the webview |
| `plugin/lib/vendor/` | modern-screenshot 4.7.0 with its license |
| `cli/browser.mjs` | standalone raw-CDP CLI |
| `probes/` | the Playwright and Puppeteer probes quoted above |

## License

MIT. This project is not affiliated with DeepSeek. I read DSH internals from an installed copy and did not modify it.
