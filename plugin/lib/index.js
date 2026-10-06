/**
 * Sidebar Browser — drive DSH Desktop's built-in sidebar browser.
 *
 * The built-in browser tab is an Electron `<webview>` guest. Two transports
 * reach it:
 *
 *  - the app window (default). The client half (`lib/client.js`) runs in the
 *    DSH window and uses the `<webview>` element's own methods. Needs nothing
 *    but the installed plugin.
 *  - the debug port. Raw CDP to the guest's own websocket endpoint, for the two
 *    things the window cannot do: screenshots and the cookie vault (httpOnly
 *    cookies). Needs the app started with --remote-debugging-port=<port>.
 *    Playwright and Puppeteer cannot serve here: Electron reports the guest as
 *    `type: "webview"` and both only enumerate `page` targets.
 *
 * @module dsh-sidebar-browser-cdp
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/** Stable Loader identity. */
const name = 'sidebar-browser-cdp'

/** Services used by the browser tools. */
const inject = ['tools']

/** Transport choice, debug port, optional tab selector, and where the cookie vault lives. */
const Config = z.object({
  // auto: the app window when it is connected, else the debug port. window / cdp force one.
  transport: z.string().default('auto'),
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
 * The jump is forced to be instant: a page with `scroll-behavior: smooth`
 * (GitHub) would still read its old position right after the call.
 */
const scrollTo = offset => `(() => {
  const box = document.querySelector('[data-dsh-scroll]')
  if (box) {
    box.scrollTo({ top: ${Number(offset)}, behavior: 'instant' })
    return { kind: 'container', top: Math.round(box.scrollTop), height: box.scrollHeight, client: box.clientHeight }
  }
  window.scrollTo({ top: ${Number(offset)}, behavior: 'instant' })
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
 * In-page renderer, for screenshots without the debug port. The app window
 * cannot capture the page (`capturePage()` crashes it on DSH Desktop
 * 0.2.0-rc.2), so the page draws itself: modern-screenshot clones the DOM into
 * an SVG foreignObject and paints that on a canvas. The result uses the
 * browser's own layout and fonts but is not a pixel copy: canvas, video,
 * iframes and images served without CORS can come out blank.
 */
let shotLibrary
const shotLibrarySource = () => (shotLibrary ??= readFileSync(new URL('./vendor/modern-screenshot.js', import.meta.url), 'utf8'))

/** Load the library into the page once, hidden from any AMD or CommonJS loader the page has. */
const installShotJs = () => '(() => { if (window.__dshShot) return true; (function () { var define, module, exports; '
  + shotLibrarySource()
  + '\n}).call(globalThis); window.__dshShot = globalThis.modernScreenshot; return Boolean(window.__dshShot) })()'

/**
 * Render the current viewport to a PNG data URL. Blocks that are fully off
 * screen are kept as empty boxes: cloning them is the slow part, and removing
 * them would shift the layout. Ancestors of fixed or sticky boxes are never
 * emptied, and a box is measured with its overflow because a `height: 100%`
 * wrapper is shorter than what it holds.
 */
const RENDER_SHOT_JS = `(async () => {
  const vh = innerHeight, vw = innerWidth, pad = 200
  const hollow = new WeakSet(), pinned = new WeakSet()
  for (const el of document.querySelectorAll('*')) {
    const position = getComputedStyle(el).position
    if (position === 'fixed' || position === 'sticky') for (let node = el; node; node = node.parentElement) pinned.add(node)
  }
  const filter = node => {
    const parent = node.parentElement
    if (parent && hollow.has(parent)) return false
    if (node.nodeType === 1 && !pinned.has(node)) {
      const r = node.getBoundingClientRect()
      if (r.width > 0 || r.height > 0) {
        const bottom = r.top + Math.max(r.height, node.scrollHeight)
        const right = r.left + Math.max(r.width, node.scrollWidth)
        if (bottom < -pad || r.top > vh + pad || right < -pad || r.left > vw + pad) {
          const display = getComputedStyle(node).display
          if (!display.startsWith('inline') && display !== 'contents' && !display.startsWith('table-')) hollow.add(node)
        }
      }
    }
    return true
  }
  return window.__dshShot.domToPng(document.documentElement, {
    width: vw,
    height: vh,
    scale: Math.min(2, devicePixelRatio || 1),
    filter,
    backgroundColor: getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)' ? '#ffffff' : null,
    style: { transform: 'translate(' + (-scrollX) + 'px,' + (-scrollY) + 'px)' },
    timeout: 1500,
  })
})()`

/**
 * Cookies from any of three shapes, as the vault's own records: a vault written
 * by browser_cookies_export, a JSON array exported from a regular browser
 * (Cookie-Editor / EditThisCookie), or a Netscape cookies.txt.
 * @param text - file contents.
 * @returns cookies with name, value, domain, path, secure, httpOnly, sameSite, expires.
 */
function parseCookieFile (text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cookies) ? parsed.cookies : [])
    const sameSite = value => ({ strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' })[String(value ?? '').toLowerCase()]
    return {
      domain: Array.isArray(parsed) ? null : (parsed.domain ?? null),
      cookies: list.filter(cookie => cookie && cookie.name).map(cookie => ({
        name: cookie.name,
        value: String(cookie.value ?? ''),
        // A browser export marks host-only cookies with a flag; the vault marks domain cookies with a leading dot.
        domain: cookie.hostOnly === false && !String(cookie.domain).startsWith('.') ? `.${cookie.domain}` : String(cookie.domain ?? ''),
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: sameSite(cookie.sameSite),
        expires: typeof cookie.expires === 'number' ? cookie.expires : (typeof cookie.expirationDate === 'number' ? cookie.expirationDate : -1),
        session: cookie.session ?? !(cookie.expires > 0 || cookie.expirationDate > 0),
      })),
    }
  }
  const cookies = []
  for (const raw of trimmed.split(/\r?\n/)) {
    const httpOnly = raw.startsWith('#HttpOnly_')
    const line = httpOnly ? raw.slice('#HttpOnly_'.length) : raw
    if (!line || line.startsWith('#')) continue
    const [domain, subdomains, path, secure, expires, name, value = ''] = line.split('\t')
    if (!name) continue
    cookies.push({
      name,
      value,
      domain: subdomains === 'TRUE' && !domain.startsWith('.') ? `.${domain}` : domain,
      path: path || '/',
      secure: secure === 'TRUE',
      httpOnly,
      sameSite: undefined,
      expires: Number(expires) > 0 ? Number(expires) : -1,
      session: !(Number(expires) > 0),
    })
  }
  return { domain: null, cookies }
}

/**
 * The `document.cookie` line that recreates a cookie from page script. HttpOnly
 * cannot be set this way; the server does not see that attribute, so a login
 * still restores, but the cookie becomes readable by the page's own scripts.
 * @param cookie - a vault record.
 * @param host - host of the page that will set it.
 * @returns the line, or null when this page cannot set the cookie.
 */
function cookieLine (cookie, host) {
  const domain = String(cookie.domain).replace(/^\./, '')
  const hostOnly = !String(cookie.domain).startsWith('.') || cookie.name.startsWith('__Host-')
  if (hostOnly ? domain !== host : !(host === domain || host.endsWith(`.${domain}`))) return null
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.name.startsWith('__Host-') ? '/' : (cookie.path || '/')}`]
  if (!hostOnly) parts.push(`Domain=${domain}`)
  if (cookie.secure || /^__(Secure|Host)-/.test(cookie.name) || cookie.sameSite === 'None') parts.push('Secure')
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`)
  if (!cookie.session && cookie.expires > 0) parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`)
  return parts.join('; ')
}

/** Routes the client half talks to. The app window reaches them as same-origin requests. */
const BRIDGE_PREFIX = '/dsh-sidebar-browser'

/**
 * Command queue between the tools (this process) and the client half that runs
 * in the app window. The window long-polls for one command, runs it against the
 * sidebar `<webview>` with the element's own methods, and posts the result back.
 * Nothing here needs a debug port.
 */
function createBridge () {
  const queue = []
  const parked = []
  const inflight = new Map()
  let lastSeen = 0

  const pump = () => {
    while (queue.length > 0 && parked.length > 0) {
      const waiter = parked.shift()
      if (!waiter.gone) waiter.hand(queue.shift())
    }
  }

  return {
    /** True while a window has polled recently; a closed window ages out. */
    alive: () => parked.some(waiter => !waiter.gone) || Date.now() - lastSeen < 30000,

    request (op, args = {}, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {
          inflight.delete(id)
          const at = queue.findIndex(command => command.id === id)
          if (at >= 0) queue.splice(at, 1)
          reject(new Error('the DSH window did not answer in time. Is the app window open?'))
        }, timeoutMs)
        inflight.set(id, { resolve, reject, timer })
        queue.push({ id, op, args })
        pump()
      })
    },

    /** Park one long-poll: resolves with a command, or null when the wait runs out. */
    poll (waitMs = 20000) {
      lastSeen = Date.now()
      let waiter
      const promise = new Promise(resolve => {
        const timer = setTimeout(() => { waiter.gone = true; resolve(null) }, waitMs)
        waiter = {
          gone: false,
          hand: command => { clearTimeout(timer); waiter.gone = true; resolve(command) },
        }
        parked.push(waiter)
      })
      pump()
      return { promise, cancel: () => { waiter.gone = true } }
    },

    reply ({ id, ok, value, error }) {
      lastSeen = Date.now()
      const slot = inflight.get(id)
      if (!slot) return false
      inflight.delete(id)
      clearTimeout(slot.timer)
      if (ok) slot.resolve(value)
      else slot.reject(new Error(error || 'the window bridge reported a failure'))
      return true
    },
  }
}

const readJson = (req, limit = 16 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', chunk => {
    size += chunk.length
    if (size > limit) {
      reject(new Error('body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
    } catch (error) {
      reject(error)
    }
  })
  req.on('error', reject)
})

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Mount the two bridge routes on the host web server.
 * A JSON POST is required: a web page cannot send one to another origin without
 * a CORS preflight, which these routes never answer.
 * @param ctx - context that provides the `webServer` service.
 * @param bridge - the command queue.
 */
function mountBridge (ctx, bridge) {
  const guard = (req, res) => {
    if (req.method === 'POST' && String(req.headers['content-type'] ?? '').startsWith('application/json')) return true
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  const routes = {
    poll: async (req, res) => {
      if (!guard(req, res)) return
      await readJson(req)
      const { promise, cancel } = bridge.poll()
      res.on('close', cancel)
      const command = await promise
      if (!res.writableEnded && !res.destroyed) sendJson(res, 200, command ?? { idle: true })
    },
    reply: async (req, res) => {
      if (!guard(req, res)) return
      sendJson(res, 200, { ok: bridge.reply(await readJson(req)) })
    },
  }
  for (const [name, handler] of Object.entries(routes)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: `${BRIDGE_PREFIX}/${name}`, handler }),
      `dsh-sidebar-browser: ${name} route`,
    )
  }
}

/**
 * Register the sidebar browser tools.
 * @param ctx - agent-scoped services.
 * @param config - transport choice, debug port and default tab.
 */
function apply (ctx, config) {
  const port = config.port
  const defaultTab = config.tab || ''
  const mode = config.transport || 'auto'

  const bridge = createBridge()
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], web => mountBridge(web, bridge))
  const useBridge = () => mode !== 'cdp' && bridge.alive()

  const connect = async (tab) => {
    const want = tab || defaultTab
    const { target, list } = await pickGuest(port, want)
    return { session: await Session.connect(target), target, list }
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

  /** The page as seen over the debug port. */
  const cdpPage = session => ({
    kind: 'cdp',
    eval: expression => session.eval(expression),
    navigate: url => session.send('Page.navigate', { url }),
    click: async (x, y, clickCount = 1) => {
      const base = { x, y, button: 'left' }
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' })
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount })
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount })
    },
    insertText: text => session.send('Input.insertText', { text }),
    selectAll: async () => {
      const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 }
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll })
    },
    key: async key => {
      const code = KEYCODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined)
      if (code === undefined) throw new Error(`unsupported key: ${key}`)
      const common = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
      if (key.length === 1) await session.send('Input.dispatchKeyEvent', { type: 'char', text: key, ...common })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    },
    history: async action => {
      if (action === 'reload') return reloadPage(session)
      const history = await session.send('Page.getNavigationHistory')
      const index = action === 'back' ? history.currentIndex - 1 : history.currentIndex + 1
      if (index < 0 || index >= history.entries.length) return null
      await session.send('Page.navigateToHistoryEntry', { entryId: history.entries[index].id })
      await sleep(1200)
      return session.eval('location.href')
    },
  })

  const NO_TAB = 'no sidebar Browser tab is open. Call browser_open with a URL, or open one by hand in the right sidebar.'
  const ask = (op, args, timeoutMs) => bridge.request(op, args, timeoutMs).catch(error => {
    throw new Error(error.message === 'no-guest' ? NO_TAB : error.message)
  })

  /** The same page, driven from the app window with the `<webview>` element's own methods. */
  const bridgePage = tab => ({
    kind: 'window',
    eval: expression => ask('eval', { code: expression, tab }),
    navigate: url => ask('navigate', { url, tab }),
    click: (x, y, count = 1) => ask('click', { x, y, count, tab }),
    insertText: text => ask('insertText', { text, tab }),
    selectAll: () => ask('eval', { code: `document.execCommand('selectAll')`, tab }),
    key: key => ask('key', { key, tab }),
    history: action => ask('history', { action, tab }),
  })

  /**
   * Run a tool body against the current page. The app window is preferred: it
   * needs nothing but the installed plugin. The debug port is the fallback and
   * the only transport for the tools that go through `withDebugPort`.
   */
  const withPage = async (tab, body) => {
    if (useBridge()) return body(bridgePage(tab || defaultTab))
    if (mode === 'window') {
      throw new Error('the app window has not connected to the plugin yet. Open a DSH Desktop window, or start a new session after installing the plugin.')
    }
    return withSession(tab, session => body(cdpPage(session))).catch(error => {
      if (/cannot reach the DSH debug port/.test(error.message)) {
        throw new Error('the app window has not connected to the plugin and the debug port is closed. Make sure a DSH Desktop window is open and start a new session; the debug port is only a fallback.')
      }
      throw error
    })
  }

  const portOpen = () => listTargets(port).then(() => true, () => false)

  const rectOf = (page, index) => page.eval(`(() => {
    const el = document.querySelector('[data-dsh-idx="${index}"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 60) }
  })()`)

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  const NOTE = 'Drives the built-in Browser tab of DSH Desktop (the sidebar <webview>) through the app window. If no Browser tab is open, browser_open creates one.'
  const PORT_NOTE = `Needs the app started with --remote-debugging-port=${port}: HttpOnly cookies cannot be read from the app window.`

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: `List the built-in browser's tabs and show which one is controlled. ${NOTE}`,
    parameters: {},
    output: textOutput,
    execute: async () => {
      if (useBridge()) {
        const tabs = await ask('tabs', {})
        if (tabs.length === 0) throw new Error(NO_TAB)
        const current = tabs.find(tab => tab.visible) ?? tabs[0]
        return [
          `${tabs.length} browser tab(s), via the app window; controlling: ${current.title || current.url}`,
          ...tabs.map((tab, index) => `  [${index}] ${tab.visible ? '*' : ' '} ${(tab.title || '').slice(0, 50)}  ${tab.url.slice(0, 90)}`),
        ].join('\n')
      }
      return withSession(undefined, async (session, target) => {
        const { list } = await pickGuest(port, defaultTab)
        return [
          `${list.length} sidebar tab(s), via the debug port; controlling: ${target.title || target.url}`,
          ...list.map((tab, index) => `  [${index}] ${tab.id.slice(0, 8)}  ${(tab.title || '').slice(0, 50)}  ${tab.url.slice(0, 90)}`),
        ].join('\n')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: `Read the built-in browser's page: title, URL, and a numbered inventory of interactive elements. Every other browser tool addresses elements by these numbers. ${NOTE}`,
    parameters: { tab: { type: 'string', description: 'URL or title fragment of the tab; omit for the current tab.' } },
    output: textOutput,
    execute: args => withPage(args.tab, page => page.eval(SNAPSHOT_JS).then(renderSnapshot)),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: `Navigate the built-in browser's tab to a URL. ${NOTE}`,
    parameters: { url: { type: 'string', required: true, description: 'Absolute URL, or a host that becomes https://.' } },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      const url = /^[a-z]+:\/\//i.test(args.url) ? args.url : `https://${args.url}`
      await page.navigate(url)
      for (let i = 0; i < 60; i++) {
        await sleep(200)
        const state = await page.eval('document.readyState').catch(() => 'loading')
        if (state === 'complete' && i > 1) break
      }
      return `${await page.eval('location.href')}\n${await page.eval('document.title')}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: `Click an element in the built-in browser by its snapshot number. ${NOTE}`,
    parameters: {
      index: { type: 'integer', required: true, description: 'Element number from browser_snapshot.' },
      double: { type: 'boolean', description: 'Double click instead of a single click.' },
    },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      const rect = await rectOf(page, args.index)
      if (!rect) throw new Error(`element [${args.index}] is no longer on the page — run browser_snapshot again`)
      await sleep(60)
      await page.click(rect.x, rect.y, args.double ? 2 : 1)
      await sleep(700)
      const after = await page.eval(SNAPSHOT_JS)
      return `clicked [${args.index}] <${rect.tag}> "${rect.text}"\nnow: ${after.url}\n${renderSnapshot(after)}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: `Type text into the built-in browser, optionally focusing an element first. React/Vue compatible. ${NOTE}`,
    parameters: {
      text: { type: 'string', required: true, description: 'Text to insert.' },
      index: { type: 'integer', description: 'Element number to focus before typing; omit to type into the focused element.' },
      replace: { type: 'boolean', description: 'Select all first, so the typed text replaces the existing value.' },
    },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      if (args.index !== undefined) {
        const rect = await rectOf(page, args.index)
        if (!rect) throw new Error(`element [${args.index}] is no longer on the page — run browser_snapshot again`)
        await sleep(60)
        await page.click(rect.x, rect.y)
        await sleep(120)
      }
      if (args.replace) {
        await page.selectAll()
        await sleep(40)
      }
      await page.insertText(args.text)
      await sleep(150)
      return `typed ${args.text.length} char(s) into ${args.index !== undefined ? `element [${args.index}]` : 'the focused element'}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: `Send one key press to the built-in browser (Enter, Tab, Escape, arrows, or a single character). ${NOTE}`,
    parameters: { key: { type: 'string', required: true, description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown; a single character types itself.' } },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      if (KEYCODES[args.key] === undefined && args.key.length !== 1) throw new Error(`unsupported key: ${args.key}`)
      await page.key(args.key)
      await sleep(200)
      return `pressed ${args.key}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: `Scroll the built-in browser's page. ${NOTE}`,
    parameters: {
      direction: { type: 'string', required: true, description: 'up, down, top or bottom.' },
      amount: { type: 'integer', description: 'Pixels for up/down; defaults to 600.' },
    },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      const before = await page.eval(SCROLL_INFO_JS)
      // Sites that scroll an inner container are the common case (SPA
      // shells); window.scrollY stays 0 there, so the target is resolved first
      // and the report names whichever element actually moved.
      const moved = await page.eval(`(() => {
        const doc = document.documentElement
        const wantWindow = doc.scrollHeight > window.innerHeight + 50
        const boxes = [...document.querySelectorAll('div,main,section')]
          .filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)
        const box = document.querySelector('[data-dsh-scroll]') ?? boxes[0]
        if (!wantWindow && !box) return 'none'
        const target = wantWindow ? null : box
        if (target) target.setAttribute('data-dsh-scroll', '1')
        const scroller = target ?? window
        const amount = ${Math.abs(Number(args.amount ?? 600))}
        if ('${args.direction}' === 'top') {
          scroller.scrollTo({ top: 0, behavior: 'instant' })
        } else if ('${args.direction}' === 'bottom') {
          scroller.scrollTo({ top: target ? target.scrollHeight : doc.scrollHeight, behavior: 'instant' })
        } else {
          const delta = '${args.direction}' === 'up' ? -amount : amount
          scroller.scrollBy({ top: delta, behavior: 'instant' })
        }
        return target ? 'container' : 'window'
      })()`)
      if (moved === 'none') throw new Error('the page has nothing to scroll')
      await sleep(400)
      const after = await page.eval(SCROLL_INFO_JS)
      return `${args.direction}: ${describeScroll(before)} -> ${describeScroll(after)}`
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_text',
    description: `Read the visible text of the built-in browser's page. ${NOTE}`,
    parameters: { max: { type: 'integer', description: 'Maximum characters to return; defaults to 4000.' } },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      const text = await page.eval('document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n") : ""')
      const max = args.max ?? 4000
      return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_html',
    description: `Return the outer HTML of one element of the built-in browser's page, by snapshot number. ${NOTE}`,
    parameters: {
      index: { type: 'integer', required: true, description: 'Element number from browser_snapshot.' },
      max: { type: 'integer', description: 'Maximum characters to return; defaults to 1200.' },
    },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      const html = await page.eval(`(() => { const el = document.querySelector('[data-dsh-idx="${args.index}"]'); return el ? el.outerHTML : null })()`)
      if (!html) throw new Error(`element [${args.index}] not found — run browser_snapshot again`)
      const max = args.max ?? 1200
      return html.length > max ? `${html.slice(0, max)}\n… (${html.length - max} more chars)` : html
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_eval',
    description: `Evaluate a JavaScript expression in the built-in browser's page and return its value. Keep it read-only unless the user asked for a change. ${NOTE}`,
    parameters: { expression: { type: 'string', required: true, description: 'Expression evaluated in the page context.' } },
    output: textOutput,
    execute: args => withPage(undefined, async page => JSON.stringify(await page.eval(args.expression), null, 2)),
  }))

  /**
   * Capture over the debug port. A window that is fully covered does not paint,
   * and `Page.captureScreenshot` then never answers, so the wait is bounded.
   */
  const portShot = session => Promise.race([
    session.send('Page.captureScreenshot', { format: 'png' }).then(shot => Buffer.from(shot.data, 'base64')),
    sleep(6000).then(() => { throw new Error('not-painting') }),
  ])

  const pageShot = async page => {
    await page.eval(`Boolean(window.__dshShot)`).then(ready => ready || page.eval(installShotJs()))
    const data = await page.eval(RENDER_SHOT_JS)
    if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) throw new Error('the page could not render itself to an image')
    return Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
  }

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: `Screenshot the built-in browser's page to PNG and return the path(s). Use full=true for a long page: it comes back as viewport-sized slices. Without the debug port the page is rendered in-page from its DOM: layout, text and fonts are the browser's own, but canvas, video, iframes and some cross-origin images can be blank, so use browser_snapshot or browser_text when exact content matters. With the app started with --remote-debugging-port=${port} it is a pixel capture. ${NOTE}`,
    parameters: {
      full: { type: 'boolean', description: 'Capture the whole page as numbered slice files instead of only the viewport.' },
      savePath: { type: 'string', description: 'Target PNG path; defaults to a temp file. With full, slices get -01, -02… suffixes.' },
    },
    output: textOutput,
    execute: async args => {
      const requested = args.savePath ?? join(tmpdir(), 'dsh-sidebar-browser', `shot-${Date.now()}.png`)
      const base = requested.replace(/\.png$/i, '')
      mkdirSync(join(requested, '..'), { recursive: true })

      /** Viewport or slices, with whatever `shoot` captures one viewport. */
      const capture = async (page, shoot) => {
        const grab = async file => {
          writeFileSync(file, await shoot())
          return file
        }
        if (!args.full) return grab(requested)

        const start = await page.eval(SCROLL_INFO_JS)
        if (start.kind === 'none') return grab(requested)
        const step = Math.max(200, start.client - 40)
        const files = []
        let previousTop = -1

        for (let offset = 0, index = 1; offset < start.height && index <= 40; offset += step, index++) {
          const position = await page.eval(scrollTo(offset))
          const atEnd = position.top + position.client >= position.height - 2
          // A target that refuses to move would otherwise yield identical slices.
          if (index > 1 && position.top === previousTop) break
          previousTop = position.top
          await sleep(350)
          files.push(await grab(`${base}-${String(index).padStart(2, '0')}.png`))
          if (atEnd) break
        }

        await page.eval(scrollTo(start.top))
        return `${start.kind} ${start.height}px, viewport ${start.client}px -> ${files.length} slice(s):\n${files.join('\n')}`
      }

      const inPage = () => withPage(undefined, async page => {
        if (page.kind !== 'window') throw new Error('not-window')
        return `${await capture(page, () => pageShot(page))}\n(rendered in-page from the DOM, not a pixel capture)`
      })

      if (mode !== 'window' && await portOpen()) {
        try {
          return await withSession(undefined, session => capture(cdpPage(session), () => portShot(session)))
        } catch (error) {
          // Covered window: fall through to the in-page render when the app window is connected.
          if (error.message !== 'not-painting') throw error
          if (!useBridge()) throw new Error('the DSH window is covered and does not paint, so the capture never finished. Bring the window to the front and retry.')
        }
      }
      if (!useBridge()) {
        throw new Error(`a screenshot needs the app window connected to the plugin, or the app started with --remote-debugging-port=${port}. Neither is available.`)
      }
      return inPage()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_history',
    description: `Move the built-in browser back, forward, or reload its page. ${NOTE}`,
    parameters: { action: { type: 'string', required: true, description: 'back, forward or reload.' } },
    output: textOutput,
    execute: args => withPage(undefined, async page => {
      if (!['back', 'forward', 'reload'].includes(args.action)) throw new Error(`unsupported action: ${args.action}`)
      const landed = await page.history(args.action)
      if (landed === null) return `nothing to go ${args.action} to`
      return `${args.action === 'reload' ? 'reloaded' : args.action}: ${landed}`
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
    description: `Save the built-in browser's cookies into a local vault file so a login survives an app restart — the sidebar browser keeps no storage between runs. Run it while you are logged in, before quitting. The file holds live session tokens: treat it like a password. ${PORT_NOTE} Restoring with browser_cookies_import does not need the port.`,
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
    }).catch(error => {
      if (!/cannot reach the DSH debug port/.test(error.message)) throw error
      throw new Error(
        'saving a login needs the debug port: session cookies are HttpOnly and no page script can read them. Two ways to get a vault: '
        + `start the app once with --remote-debugging-port=${port}, log in and export; or export the site's cookies from your regular browser `
        + `(Cookie-Editor JSON or cookies.txt) into ${vaultDir()}/<site>.json. Restoring a vault with browser_cookies_import does not need the port.`,
      )
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_cookies_import',
    description: `Restore cookies into the built-in browser and reload, so a login comes back after an app restart. Reads a vault saved by browser_cookies_export, or a cookie file exported from a regular browser (Cookie-Editor JSON, cookies.txt). Navigates to the site first when the tab is elsewhere. Works without the debug port. ${NOTE}`,
    parameters: {
      domain: { type: 'string', description: 'Vault to restore, e.g. example.com. Defaults to the current page host.' },
      file: { type: 'string', description: 'Explicit cookie file path instead of a domain name.' },
    },
    output: textOutput,
    execute: async args => {
      const viaPort = mode !== 'window' && await portOpen()
      const run = body => viaPort ? withSession(undefined, session => body(cdpPage(session), session)) : withPage(undefined, page => body(page))

      return run(async (page, session) => {
        const current = await page.eval('location.href')
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
        const vault = parseCookieFile(readFileSync(file, 'utf8'))
        const cookies = vault.cookies
        if (cookies.length === 0) throw new Error(`${file} holds no cookies`)

        // Being on the site is the reliable way to have the browser accept its own
        // cookies, and the only way for a page script to set them at all.
        const alreadyThere = cookies.some(cookie => host && belongsToSite(cookie.domain, host))
        if (!alreadyThere) {
          // Prefer the site the vault was saved from; otherwise the shortest cookie
          // domain in it (`.example.com` outranks `auth.example.com`).
          const shortest = cookies.reduce((best, cookie) => {
            const domain = String(cookie.domain).replace(/^\./, '')
            return !best || domain.length < best.length ? domain : best
          }, '')
          const destination = args.domain ?? vault.domain ?? shortest
          if (destination) {
            await page.navigate(`https://${destination}/`)
            await sleep(2000)
            try { host = new URL(await page.eval('location.href')).hostname } catch {}
          }
        }

        let restored = 0
        const failed = []
        if (session) {
          await session.send('Network.enable')
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
        } else {
          // No debug port: the page sets the cookies itself. A cookie for another
          // host cannot be set from here and is reported instead.
          const lines = []
          for (const cookie of cookies) {
            const line = cookieLine(cookie, host)
            if (line) lines.push([cookie.name, line])
            else failed.push(`${cookie.name} (belongs to ${cookie.domain})`)
          }
          const rejected = await page.eval(`(() => {
            const rejected = []
            for (const [name, line] of ${JSON.stringify(lines)}) {
              try { document.cookie = line } catch (error) { rejected.push(name) }
            }
            return rejected
          })()`)
          restored = lines.length - rejected.length
          failed.push(...rejected)
        }

        await page.history('reload')
        await sleep(800)
        const title = await page.eval('document.title')
        const tail = failed.length ? `\nnot restored: ${failed.slice(0, 8).join(', ')}` : ''
        const how = session ? '' : '\n(set from the page: these cookies are no longer HttpOnly in this tab)'
        return `restored ${restored}/${cookies.length} cookie(s) from ${file}\nnow: ${await page.eval('location.href')}\ntitle: ${title}${tail}${how}`
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_cookies_vaults',
    description: `List the saved cookie vaults on disk, with size and save time.`,
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
   * Debug-port fallback for opening and closing tabs, used only when the app
   * window is not connected. The shell owns the sidebar and creates guests
   * lazily, so these helpers attach to the app window (`dsh-app://`) and press the same controls a person
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
    description: `Open a new Browser tab in DSH Desktop's right sidebar, expanding the sidebar if it is collapsed, and optionally load a URL in it. Use this when no Browser tab is open or when a separate tab is wanted; use browser_navigate to change the page of the current tab. This is the only way to create a tab: the page tools cannot.`,
    parameters: { url: { type: 'string', description: 'Address to load, absolute or a bare host. Omit to open an empty tab.' } },
    output: textOutput,
    execute: async args => {
      const url = args.url ? (/^[a-z]+:\/\//i.test(args.url) ? args.url : `https://${args.url}`) : undefined
      if (useBridge()) {
        const result = await ask('open', { url }, 20000)
        return `${url ? `opened ${result.opened}` : 'opened an empty Browser tab'}\n${renderTabs(result.tabs)}`
      }
      return withShell(async session => {
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
        if (!url) return `opened an empty Browser tab\n${renderTabs(await sidebarTabs(session))}`

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
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: `Close a tab in DSH Desktop's right sidebar, or collapse the sidebar. With no arguments it closes the active tab. Sidebar tabs can also be files or terminals, so pass a title fragment when the active tab may not be the browser. Collapsing keeps the tabs.`,
    parameters: {
      tab: { type: 'string', description: 'Fragment of the tab title to close; omit for the active tab.' },
      sidebar: { type: 'boolean', description: 'Collapse the right sidebar instead of closing a tab.' },
    },
    output: textOutput,
    execute: async args => {
      if (useBridge()) {
        const result = await ask('close', { tab: args.tab, sidebar: Boolean(args.sidebar) })
        if (args.sidebar) return result.collapsed ? 'collapsed the right sidebar; its tabs are kept' : 'the right sidebar is already collapsed'
        if (result.closed === null) {
          return args.tab ? `no sidebar tab matches "${args.tab}"\n${renderTabs(result.tabs)}` : 'no sidebar tab is open (the sidebar may be collapsed)'
        }
        return `closed "${result.closed}"\n${renderTabs(result.tabs)}`
      }
      return withShell(async session => {
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
      })
    },
  }))
}

export { Config, apply, inject, name }
