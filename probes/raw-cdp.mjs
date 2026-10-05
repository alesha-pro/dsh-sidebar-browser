// Raw CDP probe against the DSH sidebar <webview> guest target.
// No dependencies: Node's built-in WebSocket + fetch.
import { writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT ?? '9222'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const guest = list.find(t => t.type === 'webview')
if (!guest) {
  console.log('no webview target — open the Browser tab in the right sidebar first')
  process.exit(0)
}
console.log('target:', guest.id, '|', guest.url)
console.log('title :', guest.title)

const ws = new WebSocket(guest.webSocketDebuggerUrl)
const pending = new Map()
let id = 0
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

await send('Runtime.enable')
const evalJs = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

console.log('\n--- read ---')
console.log(JSON.stringify(await evalJs(`({
  readyState: document.readyState,
  title: document.title,
  href: location.href,
  links: document.querySelectorAll('a[href]').length,
  buttons: document.querySelectorAll('button,[role=button]').length,
  inputs: document.querySelectorAll('input,textarea,select').length,
  scrollY: window.scrollY,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight
})`), null, 1))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(new URL('./webview-shot.png', import.meta.url), Buffer.from(shot.data, 'base64'))
console.log('screenshot bytes:', Buffer.from(shot.data, 'base64').length)

console.log('\n--- control (reversible) ---')
const before = await evalJs('window.scrollY')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300, button: 'none' })
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 60 })
await new Promise(r => setTimeout(r, 400))
const during = await evalJs('window.scrollY')
await evalJs(`window.scrollTo(0, ${before})`)
await new Promise(r => setTimeout(r, 300))
const after = await evalJs('window.scrollY')
console.log(`scrollY ${before} -> ${during} -> restored ${after}`)

const hover = await evalJs(`(() => {
  const el = document.querySelector('a[href],button,[role=button]')
  if (!el) return 'no interactive element'
  const r = el.getBoundingClientRect()
  return { tag: el.tagName, text: (el.innerText || '').trim().slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
console.log('first interactive element:', JSON.stringify(hover))

ws.close()
console.log('\nRESULT: raw CDP works — read, screenshot, DOM inventory, input dispatch')
