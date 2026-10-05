/**
 * Sidebar Browser CDP — drive DSH Desktop's built-in sidebar browser.
 *
 * The built-in browser tab is an Electron `<webview>` guest. Electron reports it
 * over CDP as `type: "webview"`, which Playwright and Puppeteer both ignore (they
 * only enumerate `page` targets), so a client built on them that attaches to the
 * app's debug port finds only the app shell (`dsh-app://app/`), not the page.
 * This plugin talks raw CDP to the guest's own websocket endpoint, so the agent
 * works in exactly the tab that is visible in the right sidebar.
 *
 * Requires DSH Desktop to be started with --remote-debugging-port=<port>.
 *
 * @module dsh-sidebar-browser-cdp
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/** Stable Loader identity. */
const name = 'sidebar-browser-cdp'

/** Services used by the browser tools. */
const inject = ['tools']

/** Debug port, optional tab selector, and where the cookie vault lives. */
const Config = z.object({
  port: z.number().default(9222),
  tab: z.string().default(''),
  vaultDir: z.string().default(''),
})

/**
 * The built-in browser runs in a process-lifetime session (see
 * `DesktopBrowserGuests` in the desktop shell: `dsh-sidebar-browser-${uuid}`
 * without the `persist:` prefix), so cookies die with the app. The vault is how
 * a login survives a restart: export while logged in, import after launching.
 */
const defaultVaultDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cookie-vault')
const vaultKey = value => String(value).replace(/^\./, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'all'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listTargets (port) {
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })
  } catch (error) {
    throw new Error(
      `cannot reach the DSH debug port on 127.0.0.1:${port} (${error.message}). `
      + `Start the app with: open -a "DeepSeek Harness" --args --remote-debugging-port=${port}`,
    )
  }
  if (!res.ok) throw new Error(`CDP /json/list answered HTTP ${res.status} on port ${port}`)
  return res.json()
}

/** Sidebar guests only: the app shell (`dsh-app://`) is never a valid target. */
const guests = all => all.filter(t => t.type === 'webview' && !String(t.url).startsWith('dsh-app://'))

async function pickGuest (port, want) {
  const all = await listTargets(port)
  const list = guests(all)
  if (list.length === 0) {
    throw new Error(
      'no sidebar Browser tab is open. Call browser_open with a URL, or open one by hand in the right sidebar — '
      + 'the guest is created lazily, so the port alone is not enough.',
    )
  }
  if (want) {
    const hit = list.find(t => t.id === want) ?? list.find(t => t.id.startsWith(want)) ?? list.find(t => t.url.includes(want))
    if (hit) return { target: hit, list }
  }
  return { target: list[0], list }
}

class Session {
  constructor (target) {
    this.target = target
    this.pending = new Map()
    this.seq = 0
  }

  static async connect (target) {
    const session = new Session(target)
    await session.#open()
    return session
  }

  async #open () {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl)
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      const slot = message.id ? this.pending.get(message.id) : undefined
      if (!slot) return
      this.pending.delete(message.id)
      if (message.error) slot.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else slot.resolve(message.result)
    })
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket to the sidebar guest failed')), { once: true })
    })
    // A guest can vanish mid-call (tab closed, page replaced by the shell). Without
    // this, every awaited command would hang forever instead of failing loudly.
    const abandon = reason => this.#failAll(new Error(`${reason} — reopen the Browser tab in the right sidebar and retry`))
    this.ws.addEventListener('close', () => abandon('the sidebar guest connection closed'))
    this.ws.addEventListener('error', () => abandon('the sidebar guest connection errored'))
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  #failAll (error) {
    for (const slot of this.pending.values()) slot.reject(error)
    this.pending.clear()
  }

  send (method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  close () {
    try { this.ws.close() } catch {}
  }
}

/** What actually scrolls on this page: the window, or an inner container. */
const SCROLL_INFO_JS = `(() => {
  const doc = document.documentElement
  if (doc.scrollHeight > window.innerHeight + 50) {
    return { kind: 'window', top: Math.round(window.scrollY), height: doc.scrollHeight, client: window.innerHeight }
  }
  const box = [...document.querySelectorAll('div,main,section')]
    .filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  if (!box) return { kind: 'none', top: 0, height: doc.scrollHeight, client: window.innerHeight }
  box.setAttribute('data-dsh-scroll', '1')
  return { kind: 'container', cls: String(box.className).slice(0, 40), top: Math.round(box.scrollTop), height: box.scrollHeight, client: box.clientHeight }
})()`

const SNAPSHOT_JS = `(() => {
  const out = []
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[contenteditable=true]'
  let i = 0
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (r.width < 4 || r.height < 4) continue
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    i++
    el.setAttribute('data-dsh-idx', String(i))
    const tag = el.tagName.toLowerCase()
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 90)
    out.push({ i, tag, type: el.getAttribute('type') || undefined, role: el.getAttribute('role') || undefined,
      label: label || undefined, href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : undefined,
      value: (tag === 'input' || tag === 'textarea') ? String(el.value ?? '').slice(0, 60) : undefined })
  }
  const scroll = ${SCROLL_INFO_JS}
  return { title: document.title, url: location.href, readyState: document.readyState,
    scroll, viewport: { w: window.innerWidth, h: window.innerHeight }, elements: out }
})()`

function describeScroll (scroll) {
  const where = scroll.kind === 'container' ? `container${scroll.cls ? ` .${scroll.cls.trim().split(' ')[0]}` : ''}` : scroll.kind
  return `${where} ${scroll.top}/${scroll.height}`
}

/**
 * Expression that moves whichever element actually scrolls this page, and
 * reports where it landed. The container is tagged by SCROLL_INFO_JS first.
 */
const scrollTo = offset => `(() => {
  const box = document.querySelector('[data-dsh-scroll]')
  if (box) {
    box.scrollTop = ${Number(offset)}
    return { kind: 'container', top: Math.round(box.scrollTop), height: box.scrollHeight, client: box.clientHeight }
  }
  window.scrollTo(0, ${Number(offset)})
  const doc = document.documentElement
  return { kind: 'window', top: Math.round(window.scrollY), height: doc.scrollHeight, client: window.innerHeight }
})()`

function renderSnapshot (snap) {
  const lines = [
    `title : ${snap.title}`,
    `url   : ${snap.url}   [${snap.readyState}]  viewport=${snap.viewport.w}x${snap.viewport.h}  scroll=${describeScroll(snap.scroll)}`,
    `elements: ${snap.elements.length}`,
  ]
  for (const element of snap.elements) {
    const bits = [
      `${element.tag}${element.type ? `[${element.type}]` : ''}`,
      element.label ? `"${element.label}"` : '',
      element.href ? `-> ${element.href}` : '',
      element.value ? `= "${element.value}"` : '',
    ]
    lines.push(`  [${element.i}] ${bits.filter(Boolean).join(' ')}`)
  }
  return lines.join('\n')
}

const KEYCODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40,
  ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
}

/**
 * Register the sidebar browser tools.
 * @param ctx - agent-scoped services.
 * @param config - debug port and default tab.
 */
function apply (ctx, config) {
  const port = config.port
  const defaultTab = config.tab || ''

  const connect = async (tab) => {
    const want = tab || defaultTab
    const { target, list } = await pickGuest(port, want)
    return { session: await Session.connect(target), target, list }
  }

  const rectOf = (session, index) => session.eval(`(() => {
    const el = document.querySelector('[data-dsh-idx="${index}"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 60) }
  })()`)

  const clickRect = async (session, rect, clickCount = 1) => {
    const base = { x: rect.x, y: rect.y, button: 'left' }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' })
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount })
  }

  /** One tool call = one fresh connection; the guest may be replaced at any time. */
  const withSession = async (tab, body) => {
    const { session, target } = await connect(tab)
    try {
      return await body(session, target)
    } finally {
      session.close()
    }
  }

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  /**
   * Reload by navigating to the current URL. `Page.reload` on an Electron
   * `<webview>` guest can take the target down with it (observed on DSH Desktop
   * 0.2.0-rc.2), while a fresh navigation always lands on a live target.
   */
  const reloadPage = async session => {
    const href = await session.eval('location.href')
    await session.send('Page.navigate', { url: href })
    await sleep(1500)
    return session.eval('location.href')
  }

  const PORT_NOTE = `Drives the built-in Browser tab of DSH Desktop (the sidebar <webview>). Needs the app started with --remote-debugging-port=${port} and a Browser tab open in the right sidebar (browser_open creates one).`

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: `List the built-in browser's sidebar tabs and show which one is controlled. ${PORT_NOTE}`,
    parameters: {},
    output: textOutput,
    execute: () => withSession(undefined, async (session, target) => {
      const { list } = await pickGuest(port, defaultTab)
      return [
        `${list.length} sidebar tab(s); controlling: ${target.title || target.url}`,
        ...list.map((tab, index) => `  [${index}] ${tab.id.slice(0, 8)}  ${(tab.title || '').slice(0, 50)}  ${tab.url.slice(0, 90)}`),
      ].join('\n')
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: `Read the built-in browser's page: title, URL, and a numbered inventory of interactive elements. Every other browser tool addresses elements by these numbers. ${PORT_NOTE}`,
    parameters: { tab: { type: 'string', description: 'Tab id or URL fragment; omit for the current tab.' } },
    output: textOutput,
    execute: args => withSession(args.tab, session => session.eval(SNAPSHOT_JS).then(renderSnapshot)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: `Navigate the built-in browser's tab to a URL. ${PORT_NOTE}`,
    parameters: { url: { type: 'string', required: true, description: 'Absolute URL, or a host that becomes https://.' } },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const url = /^[a-z]+:\/\//i.test(args.url) ? args.url : `https://${args.url}`
      await session.send('Page.navigate', { url })
      for (let i = 0; i < 60; i++) {
        await sleep(200)
        const state = await session.eval('document.readyState')
        if (state === 'complete' && i > 1) break
      }
      return `${await session.eval('location.href')}\n${await session.eval('document.title')}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: `Click an element in the built-in browser by its snapshot number. ${PORT_NOTE}`,
    parameters: {
      index: { type: 'integer', required: true, description: 'Element number from browser_snapshot.' },
      double: { type: 'boolean', description: 'Double click instead of a single click.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const rect = await rectOf(session, args.index)
      if (!rect) throw new Error(`element [${args.index}] is no longer on the page — run browser_snapshot again`)
      await sleep(60)
      await clickRect(session, rect, args.double ? 2 : 1)
      await sleep(700)
      const after = await session.eval(SNAPSHOT_JS)
      return `clicked [${args.index}] <${rect.tag}> "${rect.text}"\nnow: ${after.url}\n${renderSnapshot(after)}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: `Type text into the built-in browser, optionally focusing an element first. React/Vue compatible. ${PORT_NOTE}`,
    parameters: {
      text: { type: 'string', required: true, description: 'Text to insert.' },
      index: { type: 'integer', description: 'Element number to focus before typing; omit to type into the focused element.' },
      replace: { type: 'boolean', description: 'Select all first, so the typed text replaces the existing value.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      if (args.index !== undefined) {
        const rect = await rectOf(session, args.index)
        if (!rect) throw new Error(`element [${args.index}] is no longer on the page — run browser_snapshot again`)
        await sleep(60)
        await clickRect(session, rect)
        await sleep(120)
      }
      if (args.replace) {
        const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 }
        await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll })
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll })
        await sleep(40)
      }
      await session.send('Input.insertText', { text: args.text })
      await sleep(150)
      return `typed ${args.text.length} char(s) into ${args.index !== undefined ? `element [${args.index}]` : 'the focused element'}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: `Send one key press to the built-in browser (Enter, Tab, Escape, arrows, or a single character). ${PORT_NOTE}`,
    parameters: { key: { type: 'string', required: true, description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown; a single character types itself.' } },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const { key } = args
      const code = KEYCODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined)
      if (code === undefined) throw new Error(`unsupported key: ${key}`)
      const common = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
      if (key.length === 1) await session.send('Input.dispatchKeyEvent', { type: 'char', text: key, ...common })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(200)
      return `pressed ${key}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: `Scroll the built-in browser's page. ${PORT_NOTE}`,
    parameters: {
      direction: { type: 'string', required: true, description: 'up, down, top or bottom.' },
      amount: { type: 'integer', description: 'Pixels for up/down; defaults to 600.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const before = await session.eval(SCROLL_INFO_JS)
      // Sites that scroll an inner container are the common case (SPA
      // shells); window.scrollY stays 0 there, so the target is resolved first
      // and the report names whichever element actually moved.
      const moved = await session.eval(`(() => {
        const doc = document.documentElement
        const wantWindow = doc.scrollHeight > window.innerHeight + 50
        const boxes = [...document.querySelectorAll('div,main,section')]
          .filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)
        const box = document.querySelector('[data-dsh-scroll]') ?? boxes[0]
        if (!wantWindow && !box) return 'none'
        const target = wantWindow ? null : box
        if (target) target.setAttribute('data-dsh-scroll', '1')
        const amount = ${Math.abs(Number(args.amount ?? 600))}
        if ('${args.direction}' === 'top') {
          if (target) target.scrollTop = 0; else window.scrollTo(0, 0)
        } else if ('${args.direction}' === 'bottom') {
          if (target) target.scrollTop = target.scrollHeight; else window.scrollTo(0, doc.scrollHeight)
        } else {
          const delta = '${args.direction}' === 'up' ? -amount : amount
          if (target) target.scrollBy(0, delta); else window.scrollBy(0, delta)
        }
        return target ? 'container' : 'window'
      })()`)
      if (moved === 'none') throw new Error('the page has nothing to scroll')
      await sleep(400)
      const after = await session.eval(SCROLL_INFO_JS)
      return `${args.direction}: ${describeScroll(before)} -> ${describeScroll(after)}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_text',
    description: `Read the visible text of the built-in browser's page. ${PORT_NOTE}`,
    parameters: { max: { type: 'integer', description: 'Maximum characters to return; defaults to 4000.' } },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const text = await session.eval('document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n") : ""')
      const max = args.max ?? 4000
      return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_html',
    description: `Return the outer HTML of one element of the built-in browser's page, by snapshot number. ${PORT_NOTE}`,
    parameters: {
      index: { type: 'integer', required: true, description: 'Element number from browser_snapshot.' },
      max: { type: 'integer', description: 'Maximum characters to return; defaults to 1200.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const html = await session.eval(`(() => { const el = document.querySelector('[data-dsh-idx="${args.index}"]'); return el ? el.outerHTML : null })()`)
      if (!html) throw new Error(`element [${args.index}] not found — run browser_snapshot again`)
      const max = args.max ?? 1200
      return html.length > max ? `${html.slice(0, max)}\n… (${html.length - max} more chars)` : html
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_eval',
    description: `Evaluate a JavaScript expression in the built-in browser's page and return its value. Keep it read-only unless the user asked for a change. ${PORT_NOTE}`,
    parameters: { expression: { type: 'string', required: true, description: 'Expression evaluated in the page context.' } },
    output: textOutput,
    execute: args => withSession(undefined, async session => JSON.stringify(await session.eval(args.expression), null, 2)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: `Screenshot the built-in browser's page to PNG and return the path(s). Use full=true for a long page: it is captured as viewport-sized slices, because Electron's single-shot full-page capture (captureBeyondViewport) repeats the viewport instead of rendering the whole page — measured on DSH Desktop 0.2.0-rc.2. ${PORT_NOTE}`,
    parameters: {
      full: { type: 'boolean', description: 'Capture the whole page as numbered slice files instead of only the viewport.' },
      savePath: { type: 'string', description: 'Target PNG path; defaults to a temp file. With full, slices get -01, -02… suffixes.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const requested = args.savePath ?? join(tmpdir(), 'dsh-sidebar-browser', `shot-${Date.now()}.png`)
      const base = requested.replace(/\.png$/i, '')
      mkdirSync(join(requested, '..'), { recursive: true })

      const grab = async file => {
        const shot = await session.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        return file
      }

      if (!args.full) return grab(requested)

      const start = await session.eval(SCROLL_INFO_JS)
      if (start.kind === 'none') return grab(requested)
      const step = Math.max(200, start.client - 40)
      const files = []
      let previousTop = -1

      for (let offset = 0, index = 1; offset < start.height && index <= 40; offset += step, index++) {
        const position = await session.eval(scrollTo(offset))
        const atEnd = position.top + position.client >= position.height - 2
        // A target that refuses to move would otherwise yield identical slices.
        if (index > 1 && position.top === previousTop) break
        previousTop = position.top
        await sleep(350)
        files.push(await grab(`${base}-${String(index).padStart(2, '0')}.png`))
        if (atEnd) break
      }

      await session.eval(scrollTo(start.top))
      return `${start.kind} ${start.height}px, viewport ${start.client}px -> ${files.length} slice(s):\n${files.join('\n')}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_history',
    description: `Move the built-in browser back, forward, or reload its page. ${PORT_NOTE}`,
    parameters: { action: { type: 'string', required: true, description: 'back, forward or reload.' } },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      if (args.action === 'reload') {
        return `reloaded: ${await reloadPage(session)}`
      }
      if (args.action !== 'back' && args.action !== 'forward') throw new Error(`unsupported action: ${args.action}`)
      const history = await session.send('Page.getNavigationHistory')
      const index = args.action === 'back' ? history.currentIndex - 1 : history.currentIndex + 1
      if (index < 0 || index >= history.entries.length) return `nothing to go ${args.action} to`
      await session.send('Page.navigateToHistoryEntry', { entryId: history.entries[index].id })
      await sleep(1200)
      return `${args.action}: ${await session.eval('location.href')}`
    }),
  }))

  const vaultDir = () => config.vaultDir || defaultVaultDir()
  const vaultFile = key => join(vaultDir(), `${vaultKey(key)}.json`)
  /**
   * Does a cookie belong to a site? True for the site itself, its own
   * subdomains, and a parent domain cookie (`.example.com` for `example.com`) —
   * but not for a sibling registrable domain (`.example.net`).
   */
  const belongsToSite = (cookieDomain, site) => {
    const domain = String(cookieDomain).replace(/^\./, '')
    const host = String(site).replace(/^\./, '')
    if (!domain || !host) return false
    return domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`)
  }

  ctx.tools.register(defineTool({
    name: 'browser_cookies_export',
    description: `Save the built-in browser's cookies into a local vault file so a login survives an app restart — the sidebar browser keeps no storage between runs. Run it while you are logged in, before quitting. The file holds live session tokens: treat it like a password. ${PORT_NOTE}`,
    parameters: {
      domain: { type: 'string', description: 'Site to save, e.g. example.com (subdomains included). Defaults to the current page host.' },
      all: { type: 'boolean', description: 'Save every cookie in the tab into all.json instead of just the current site.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      await session.send('Network.enable')
      const all = (await session.send('Network.getAllCookies')).cookies ?? []
      const page = await session.eval('location.href')
      let pageHost = ''
      try { pageHost = new URL(page).hostname } catch {}
      const key = args.all ? 'all' : (args.domain ?? pageHost)
      if (!key) throw new Error('the tab is not on an http(s) page — pass domain explicitly')
      const site = args.domain ?? pageHost
      const wanted = args.all ? all : all.filter(cookie => belongsToSite(cookie.domain, site))
      if (wanted.length === 0) {
        throw new Error(`no cookies for ${site} in this tab — log in first, then export`)
      }
      const file = vaultFile(key)
      mkdirSync(vaultDir(), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify({
        savedAt: new Date().toISOString(),
        page,
        domain: args.all ? null : (args.domain ?? pageHost),
        count: wanted.length,
        cookies: wanted,
      }, null, 2), { mode: 0o600 })
      const hosts = [...new Set(wanted.map(cookie => cookie.domain))].slice(0, 8).join(', ')
      const ephemeral = wanted.filter(cookie => cookie.session).length
      return `${wanted.length} cookie(s) -> ${file}\nhosts: ${hosts}\nsession cookies: ${ephemeral} · persistent: ${wanted.length - ephemeral}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_cookies_import',
    description: `Restore cookies saved by browser_cookies_export into the built-in browser and reload, so a login comes back after an app restart. Navigates to the site first when the tab is elsewhere. ${PORT_NOTE}`,
    parameters: {
      domain: { type: 'string', description: 'Vault to restore, e.g. example.com. Defaults to the current page host.' },
      file: { type: 'string', description: 'Explicit vault file path instead of a domain name.' },
    },
    output: textOutput,
    execute: args => withSession(undefined, async session => {
      const current = await session.eval('location.href')
      let host = ''
      try { host = new URL(current).hostname } catch {}
      // An explicit file wins; otherwise the site's own vault, falling back to a
      // catch-all `all.json` written by `browser_cookies_export({ all: true })`.
      let file = args.file ?? vaultFile(args.domain ?? host)
      if (!args.file && !existsSync(file) && !args.domain) {
        const fallback = vaultFile('all')
        if (existsSync(fallback)) file = fallback
      }
      if (!existsSync(file)) {
        throw new Error(`no vault at ${file} — run browser_cookies_export while logged in first`
          + (args.domain ? '' : `, or export with all: true into ${vaultFile('all')}`))
      }
      const vault = JSON.parse(readFileSync(file, 'utf8'))
      const cookies = Array.isArray(vault.cookies) ? vault.cookies : []
      if (cookies.length === 0) throw new Error(`${file} holds no cookies`)

      await session.send('Network.enable')
      // Being on the site is the reliable way to have the browser accept its own
      // cookies; a cross-site Network.setCookie is rejected often enough to matter.
      const alreadyThere = cookies.some(cookie => host && belongsToSite(cookie.domain, host))
      if (!alreadyThere) {
        // Prefer the site the vault was saved from; otherwise the shortest cookie
        // domain in it (`.example.com` outranks `auth.example.com`).
        const shortest = cookies.reduce((best, cookie) => {
          const domain = String(cookie.domain).replace(/^\./, '')
          return !best || domain.length < best.length ? domain : best
        }, '')
        const destination = args.domain ?? vault.domain ?? host ?? shortest
        if (destination) {
          await session.send('Page.navigate', { url: `https://${destination}/` })
          await sleep(1500)
        }
      }

      let restored = 0
      const failed = []
      for (const cookie of cookies) {
        const params = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
        }
        if (cookie.sameSite && cookie.sameSite !== 'Unspecified') params.sameSite = cookie.sameSite
        if (!cookie.session && typeof cookie.expires === 'number' && cookie.expires > 0) params.expires = cookie.expires
        try {
          const result = await session.send('Network.setCookie', params)
          if (result.success) restored++
          else failed.push(cookie.name)
        } catch (error) {
          failed.push(`${cookie.name} (${error.message.split('\n')[0].slice(0, 40)})`)
        }
      }

      await reloadPage(session)
      await sleep(800)
      const title = await session.eval('document.title')
      const tail = failed.length ? `\nrejected: ${failed.slice(0, 8).join(', ')}` : ''
      return `restored ${restored}/${cookies.length} cookie(s) from ${file}\nnow: ${await session.eval('location.href')}\ntitle: ${title}${tail}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_cookies_vaults',
    description: `List the saved cookie vaults on disk, with size and save time. ${PORT_NOTE}`,
    parameters: {},
    output: textOutput,
    execute: async () => {
      const dir = vaultDir()
      if (!existsSync(dir)) return `no vault yet at ${dir} — run browser_cookies_export while logged in`
      const entries = readdirSync(dir).filter(file => file.endsWith('.json'))
      if (entries.length === 0) return `${dir} is empty`
      const lines = entries.map(file => {
        const path = join(dir, file)
        try {
          const vault = JSON.parse(readFileSync(path, 'utf8'))
          return `  ${file}  ${vault.count ?? '?'} cookie(s)  saved ${vault.savedAt ?? '?'}  ${vault.page ?? ''}`
        } catch {
          return `  ${file}  (unreadable)`
        }
      })
      return `${dir}\n${lines.join('\n')}`
    },
  }))

  /**
   * Opening and closing tabs is the one job the guest cannot do for itself: the
   * shell owns the sidebar and creates guests lazily. These two tools therefore
   * attach to the app window (`dsh-app://`) and press the same controls a person
   * would, located by the shell's own `data-*` hooks rather than by label text,
   * so they do not depend on the UI language. Measured on DSH Desktop 0.2.0-rc.2.
   */
  const withShell = async body => {
    const all = await listTargets(port)
    const shell = all.find(t => t.type === 'page' && String(t.url).startsWith('dsh-app://'))
    if (!shell) throw new Error('the DSH app window is not reachable on the debug port')
    const session = await Session.connect(shell)
    try {
      return await body(session)
    } finally {
      session.close()
    }
  }

  /** Helpers evaluated inside the app window. Hidden duplicates of the sidebar header exist, so only visible nodes count. */
  const SHELL_JS = `
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const one = sel => [...document.querySelectorAll(sel)].find(vis)
    const tabs = () => [...document.querySelectorAll('[data-dockkit-tab]')].filter(vis)
      .filter(e => !e.hasAttribute('data-dockkit-tab-quiet'))
      .map(e => ({ id: e.getAttribute('data-dockkit-tab'), title: e.innerText.trim(), active: e.getAttribute('aria-selected') === 'true' }))
    const address = () => {
      const tab = [...document.querySelectorAll('[data-dockkit-tab]')].find(vis)
      for (let node = tab; node; node = node.parentElement) {
        const input = [...node.querySelectorAll('input')].find(e => vis(e) && e.type !== 'checkbox')
        if (input) return input
      }
      return null
    }
  `
  const shellEval = (session, body) => session.eval(`(() => { ${SHELL_JS}\n${body} })()`)
  const sidebarTabs = session => shellEval(session, 'return tabs()')
  const renderTabs = list => list.length === 0
    ? 'no sidebar tabs'
    : list.map(tab => `  ${tab.active ? '*' : ' '} ${tab.title.slice(0, 70)}`).join('\n')

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: `Open a new Browser tab in DSH Desktop's right sidebar, expanding the sidebar if it is collapsed, and optionally load a URL in it. Use this when no Browser tab is open or when a separate tab is wanted; use browser_navigate to change the page of the current tab. This is the only way to create a tab: the page tools cannot. Needs the app started with --remote-debugging-port=${port}.`,
    parameters: { url: { type: 'string', description: 'Address to load, absolute or a bare host. Omit to open an empty tab.' } },
    output: textOutput,
    execute: args => withShell(async session => {
      const before = guests(await listTargets(port)).map(t => t.id)
      const click = sel => shellEval(session, `const e = one(${JSON.stringify(sel)}); if (e) e.click(); return Boolean(e)`)
      if (await click('[data-sidebar-right-expand]')) await sleep(600)
      // The Browser card lives on the sidebar's start page; "new tab" brings that page up.
      if (!await shellEval(session, `return Boolean(one('[data-sidebar-right-guide-entry="browser"]'))`)) {
        if (!await click('[data-dockkit-add-tab]')) throw new Error('could not find the new-tab button in the right sidebar')
        await sleep(600)
      }
      if (!await click('[data-sidebar-right-guide-entry="browser"]')) {
        throw new Error('the Browser entry is missing from the sidebar start page; is the built-in browser enabled?')
      }
      await sleep(700)
      if (!args.url) return `opened an empty Browser tab\n${renderTabs(await sidebarTabs(session))}`

      const url = /^[a-z]+:\/\//i.test(args.url) ? args.url : `https://${args.url}`
      const focused = await shellEval(session, 'const input = address(); if (!input) return false; input.focus(); input.select(); return true')
      if (!focused) throw new Error('opened a Browser tab but could not find its address field')
      await session.send('Input.insertText', { text: url })
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
      for (let i = 0; i < 40; i++) {
        await sleep(250)
        const fresh = guests(await listTargets(port)).find(t => !before.includes(t.id))
        if (fresh) return `opened ${fresh.url}\n${renderTabs(await sidebarTabs(session))}`
      }
      throw new Error(`the tab opened but no page appeared for ${url} within 10 s`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: `Close a tab in DSH Desktop's right sidebar, or collapse the sidebar. With no arguments it closes the active tab. Sidebar tabs can also be files or terminals, so pass a title fragment when the active tab may not be the browser. Collapsing keeps the tabs. Needs the app started with --remote-debugging-port=${port}.`,
    parameters: {
      tab: { type: 'string', description: 'Fragment of the tab title to close; omit for the active tab.' },
      sidebar: { type: 'boolean', description: 'Collapse the right sidebar instead of closing a tab.' },
    },
    output: textOutput,
    execute: args => withShell(async session => {
      if (args.sidebar) {
        const done = await shellEval(session, `const e = one('[data-sidebar-right-toggle]'); if (e) e.click(); return Boolean(e)`)
        return done ? 'collapsed the right sidebar; its tabs are kept' : 'the right sidebar is already collapsed'
      }
      const list = await sidebarTabs(session)
      if (list.length === 0) return 'no sidebar tab is open (the sidebar may be collapsed)'
      const want = String(args.tab ?? '').toLowerCase()
      const hit = want ? list.find(tab => tab.title.toLowerCase().includes(want)) : list.find(tab => tab.active)
      if (!hit) return `no sidebar tab matches "${args.tab}"\n${renderTabs(list)}`
      const closed = await shellEval(session, `const e = document.querySelector('[data-dockkit-tab-close="${hit.id}"]'); if (e) e.click(); return Boolean(e)`)
      if (!closed) throw new Error(`could not find the close button of "${hit.title}"`)
      await sleep(500)
      return `closed "${hit.title}"\n${renderTabs(await sidebarTabs(session))}`
    }),
  }))
}

export { Config, apply, inject, name }
