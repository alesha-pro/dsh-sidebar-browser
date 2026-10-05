#!/usr/bin/env node
/**
 * Drive DSH Desktop's built-in sidebar browser (the <webview> tab) over raw CDP.
 *
 * Why raw CDP: Playwright and Puppeteer only expose targets of type `page`, and
 * Electron reports sidebar guests as type `webview`, so both ignore the tab the
 * user actually sees. Talking to the guest's own websocket endpoint works.
 *
 * Requires: DSH Desktop started with `--remote-debugging-port=<port>`.
 * No dependencies: Node's global fetch + WebSocket.
 *
 * Usage: node browser.mjs <command> [args] [--tab N] [--port N] [--json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORT = process.env.DSH_CDP_PORT ?? '9222'
const STATE_FILE = fileURLToPath(new URL('./.browser-state.json', import.meta.url))

// ---------------------------------------------------------------- cli parsing
const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ }
    else flags[key] = true
  } else positional.push(a)
}
const [command, ...rest] = positional
const port = String(flags.port ?? DEFAULT_PORT)
const wantJson = Boolean(flags.json)
const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {})
const writeState = s => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))

// -------------------------------------------------------------- cdp plumbing
async function listTargets () {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`)
  return res.json()
}

/** Sidebar guests first-class; the app shell (`dsh-app://`) is never a candidate. */
function guests (all) {
  return all.filter(t => t.type === 'webview' && !String(t.url).startsWith('dsh-app://'))
}

async function pickGuest () {
  const all = await listTargets()
  const list = guests(all)
  if (!list.length) {
    throw new Error(
      'no sidebar browser tab is open. Open one in DSH Desktop (right sidebar → Browser) '
      + 'and make sure the app was started with --remote-debugging-port=' + port
    )
  }
  const want = flags.tab ?? readState().tab
  let target = list[0]
  if (want !== undefined) {
    target = /^\d+$/.test(String(want))
      ? (list[Number(want)] ?? list[0])
      : (list.find(t => t.id === want || t.url.includes(String(want))) ?? list[0])
  }
  writeState({ ...readState(), tab: target.id })
  return { target, list }
}

class Session {
  static async connect (target) {
    const s = new Session(target)
    await s.#open()
    return s
  }

  constructor (target) { this.target = target; this.pending = new Map(); this.id = 0 }

  async #open () {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl)
    this.ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      const slot = m.id && this.pending.get(m.id)
      if (!slot) return
      this.pending.delete(m.id)
      m.error ? slot.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : slot.resolve(m.result)
    })
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('websocket failed: ' + this.target.webSocketDebuggerUrl)), { once: true })
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  send (method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  close () { try { this.ws.close() } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ------------------------------------------------------------------- helpers
const SNAPSHOT_JS = `(() => {
  const seen = new Set()
  const out = []
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[contenteditable=true]'
  let i = 0
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (r.width < 4 || r.height < 4) continue
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    if (r.bottom < -2000 || r.top > document.documentElement.scrollHeight + 2000) continue
    if (seen.has(el)) continue
    seen.add(el)
    i++
    el.setAttribute('data-dsh-idx', String(i))
    const tag = el.tagName.toLowerCase()
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 90)
    out.push({ i, tag, type: el.getAttribute('type') || undefined, role: el.getAttribute('role') || undefined,
               label: label || undefined, href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : undefined,
               value: tag === 'input' || tag === 'textarea' ? String(el.value ?? '').slice(0, 60) : undefined,
               x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  }
  return { title: document.title, url: location.href, readyState: document.readyState,
           scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight,
           viewport: { w: window.innerWidth, h: window.innerHeight }, elements: out }
})()`

async function snapshot (s) {
  const snap = await s.eval(SNAPSHOT_JS)
  writeState({ ...readState(), tab: s.target.id, url: snap.url, elements: snap.elements })
  return snap
}

async function rectOf (s, index) {
  return s.eval(`(() => {
    const el = document.querySelector('[data-dsh-idx="${index}"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 60) }
  })()`)
}

async function requireRect (s, index) {
  const rect = await rectOf(s, index)
  if (!rect) throw new Error(`element [${index}] is not on the page — run \`snapshot\` again`)
  await sleep(60)
  return rect
}

const KEYCODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40,
  ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32
}

async function clickRect (s, rect, { button = 'left', clickCount = 1 } = {}) {
  const base = { x: rect.x, y: rect.y, button }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' })
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount })
}

async function click (s, index, opts = {}) {
  const rect = await requireRect(s, index)
  await clickRect(s, rect, opts)
  await sleep(opts.settle ?? 700)
  return { clicked: index, ...rect }
}

async function typeText (s, index, text) {
  if (index !== undefined && index !== '') {
    const rect = await requireRect(s, index)
    await clickRect(s, rect)
    await sleep(120)
  }
  if (flags.replace) {
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    await sleep(40)
  }
  await s.send('Input.insertText', { text })
  await sleep(150)
  return { typed: text.length, into: index ?? 'focused element' }
}

async function pressKey (s, key) {
  const code = KEYCODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined)
  if (code === undefined) throw new Error(`unsupported key: ${key}`)
  const common = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (key.length === 1) await s.send('Input.dispatchKeyEvent', { type: 'char', text: key, ...common })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(200)
  return { pressed: key }
}

async function scroll (s, direction = 'down', amount) {
  const step = Number(amount ?? (flags.amount ?? 600))
  const before = await s.eval('window.scrollY')
  if (direction === 'top' || direction === 'bottom') {
    await s.eval(direction === 'top' ? 'window.scrollTo(0,0)' : 'window.scrollTo(0, document.documentElement.scrollHeight)')
  } else {
    const dy = direction === 'up' ? -Math.abs(step) : Math.abs(step)
    const inner = await s.eval('(() => { const c = [...document.querySelectorAll("div,main,section")].find(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200); return c ? true : false })()')
    if (inner) {
      await s.eval(`(() => { const c = [...document.querySelectorAll("div,main,section")].find(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200); c.scrollBy(0, ${dy}); })()`)
    } else {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: Math.round((await s.eval('window.innerHeight')) / 2), deltaX: 0, deltaY: dy })
    }
  }
  await sleep(400)
  const after = await s.eval('window.scrollY')
  return { scrollY: [before, after], mode: direction }
}

async function navigate (s, url) {
  const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`
  await s.send('Page.navigate', { url: full })
  for (let i = 0; i < 60; i++) {
    await sleep(200)
    const ready = await s.eval('document.readyState')
    if (ready === 'complete' && i > 1) break
  }
  return { url: await s.eval('location.href'), title: await s.eval('document.title') }
}

async function history (s, direction) {
  const h = await s.send('Page.getNavigationHistory')
  const idx = direction === 'back' ? h.currentIndex - 1 : h.currentIndex + 1
  if (idx < 0 || idx >= h.entries.length) return { moved: false, reason: 'no history entry' }
  await s.send('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id })
  await sleep(1200)
  return { moved: true, url: await s.eval('location.href') }
}

async function screenshot (s, path, fullPage) {
  const shot = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(fullPage) })
  const out = path && path !== true ? path : fileURLToPath(new URL('./shot.png', import.meta.url))
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  return { file: out, bytes: Buffer.from(shot.data, 'base64').length }
}

// --------------------------------------------------------------------- output
const line = (...a) => console.log(...a)

async function main () {
  if (!command || command === 'help' || flags.help) {
    line(`usage: node browser.mjs <command> [args] [--tab N] [--port N] [--json]

  tabs                     list sidebar browser tabs
  snapshot                 page meta + numbered interactive elements
  click <n>                click element n
  type <n> <text>          click element n and type text  (--replace to clear first)
  press <key>              send one key (Enter, Tab, Escape, arrows, single chars)
  scroll <dir> [px]        dir: up|down|top|bottom
  text [--max N]           visible page text
  eval <js>                evaluate JS in the page (read-only by convention)
  screenshot [path]        save PNG  (--full for the whole page)
  navigate <url>           go to url in the current tab
  back | forward | reload  history and reload
  html <n>                 outerHTML of element n (trimmed)`)
    return
  }

  if (command === 'tabs') {
    const { target, list } = await pickGuest()
    if (wantJson) return line(JSON.stringify(list.map(t => ({ id: t.id, url: t.url, title: t.title })), null, 2))
    line(`${list.length} sidebar tab(s), attached to: ${target.title || target.url}`)
    list.forEach((t, i) => line(`  [${i}] ${t.id.slice(0, 8)}  ${(t.title || '').slice(0, 50)}  ${t.url.slice(0, 80)}`))
    return
  }

  const { target } = await pickGuest()
  const s = await Session.connect(target)
  try {
    switch (command) {
      case 'snapshot': {
        const snap = await snapshot(s)
        if (wantJson) return line(JSON.stringify(snap, null, 2))
        line(`title : ${snap.title}`)
        line(`url   : ${snap.url}   [${snap.readyState}]  scrollY=${snap.scrollY}/${snap.scrollHeight}  viewport=${snap.viewport.w}x${snap.viewport.h}`)
        line(`elements: ${snap.elements.length}`)
        for (const e of snap.elements) {
          const bits = [e.tag + (e.type ? `[${e.type}]` : ''), e.label ? `"${e.label}"` : '', e.href ? `-> ${e.href}` : '', e.value ? `= "${e.value}"` : '']
          line(`  [${e.i}] ${bits.filter(Boolean).join(' ')}`)
        }
        break
      }
      case 'click': case 'dblclick': {
        const n = Number(rest[0])
        if (!Number.isFinite(n)) throw new Error('click needs an element number (run snapshot first)')
        const r = await click(s, n, command === 'dblclick' ? { clickCount: 2 } : {})
        line(`clicked [${n}] <${r.tag}> "${r.text}" at ${r.x},${r.y}`)
        const after = await snapshot(s)
        line(`now: ${after.url}  |  ${after.title}`)
        break
      }
      case 'type': {
        const first = rest[0]
        const numeric = /^\d+$/.test(first ?? '')
        const idx = numeric ? first : ''
        const text = numeric ? rest.slice(1).join(' ') : rest.join(' ')
        if (!text) throw new Error('type needs text')
        const r = await typeText(s, idx, text)
        line(`typed into ${r.into}: "${text}"`)
        break
      }
      case 'press': {
        const r = await pressKey(s, rest[0] ?? 'Enter')
        line(`pressed ${r.pressed}`)
        break
      }
      case 'scroll': {
        const r = await scroll(s, rest[0] ?? 'down', rest[1])
        line(`scrolled ${rest[0] ?? 'down'}: scrollY ${r.scrollY[0]} -> ${r.scrollY[1]}  (${r.mode})`)
        break
      }
      case 'text': {
        const max = Number(flags.max ?? 4000)
        const t = await s.eval('document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n") : ""')
        line(t.slice(0, max))
        if (t.length > max) line(`\n… (${t.length - max} more chars)`)
        break
      }
      case 'html': {
        const n = Number(rest[0])
        const h = await s.eval(`(() => { const el = document.querySelector('[data-dsh-idx="${n}"]'); return el ? el.outerHTML : null })()`)
        line(h ? h.slice(0, Number(flags.max ?? 1200)) : `element [${n}] not found`)
        break
      }
      case 'eval': {
        const expr = rest.join(' ')
        if (!expr) throw new Error('eval needs an expression')
        line(JSON.stringify(await s.eval(expr), null, 2))
        break
      }
      case 'screenshot': {
        const r = await screenshot(s, rest[0], flags.full)
        line(`saved ${r.file} (${r.bytes} bytes)`)
        break
      }
      case 'navigate': {
        const r = await navigate(s, rest[0])
        line(`navigated: ${r.url}  |  ${r.title}`)
        break
      }
      case 'back': case 'forward': {
        const r = await history(s, command)
        line(r.moved ? `${command}: ${r.url}` : `${command}: ${r.reason}`)
        break
      }
      case 'reload': {
        await s.send('Page.reload', {})
        await sleep(1500)
        line(`reloaded: ${await s.eval('location.href')}`)
        break
      }
      default:
        throw new Error(`unknown command: ${command} (try: node browser.mjs help)`)
    }
  } finally {
    s.close()
  }
}

await main().catch(err => {
  console.error('error:', err.message)
  process.exit(1)
})
