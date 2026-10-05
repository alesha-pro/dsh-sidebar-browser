// Prove input dispatch reaches the sidebar guest, with no side effect on the page:
// a one-off capture listener swallows the event before the site sees it.
import { writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT ?? '9222'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const guest = list.find(t => t.type === 'webview')
if (!guest) { console.log('no webview target'); process.exit(0) }

const ws = new WebSocket(guest.webSocketDebuggerUrl)
const pending = new Map(); let id = 0
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
})
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}
await send('Runtime.enable')

const target = await evalJs(`(() => {
  window.__probe = []
  window.__probeHandler = e => { window.__probe.push(e.type); e.preventDefault(); e.stopImmediatePropagation() }
  window.addEventListener('mousedown', window.__probeHandler, true)
  window.addEventListener('click', window.__probeHandler, true)
  const candidates = [...document.querySelectorAll('a[href],button')]
  const el = candidates.find(n => { const r = n.getBoundingClientRect(); return r.width > 20 && r.height > 10 && r.x > 0 && r.y > 60 })
  if (!el) return { ok: false }
  const r = el.getBoundingClientRect()
  return { ok: true, tag: el.tagName, text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40),
           x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
if (!target.ok) { console.log('no suitable element'); ws.close(); process.exit(0) }
console.log('clicking:', JSON.stringify(target))

const at = { x: target.x, y: target.y, button: 'left', clickCount: 1 }
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none' })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
await new Promise(r => setTimeout(r, 300))

const events = await evalJs('window.__probe')
const urlUnchanged = await evalJs('location.href')
await evalJs(`window.removeEventListener('mousedown', window.__probeHandler, true);
              window.removeEventListener('click', window.__probeHandler, true);
              delete window.__probeHandler; delete window.__probe; 'cleaned'`)

console.log('events received by page:', JSON.stringify(events))
console.log('location after click  :', urlUnchanged)
console.log(events.includes('mousedown') && events.includes('click')
  ? '\nRESULT: input dispatch confirmed — clicks reach the built-in browser'
  : '\nRESULT: click did NOT arrive')
ws.close()
