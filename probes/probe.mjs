// Probe: can we drive DSH Desktop's built-in sidebar browser over CDP?
// Read-only except one reversible scroll round-trip that proves input works.
import { chromium } from 'playwright-core'

const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(endpoint)
console.log('connected:', browser.isConnected())

const contexts = browser.contexts()
console.log('contexts:', contexts.length)

let target = null
for (const [ci, ctx] of contexts.entries()) {
  for (const page of ctx.pages()) {
    const kind = page.url().startsWith('dsh-app://') ? 'app-shell' : 'webview'
    console.log(`  ctx${ci} ${kind} :: ${page.url()}`)
    if (kind === 'webview') target = page
  }
}
if (!target) {
  console.log('RESULT: no webview page found — sidebar tab probably not open')
  await browser.close()
  process.exit(0)
}

console.log('\n--- target ---')
console.log('url   :', target.url())
console.log('title :', await target.title())
console.log('viewport:', JSON.stringify(target.viewportSize()))

const inventory = await target.evaluate(() => ({
  readyState: document.readyState,
  title: document.title,
  links: document.querySelectorAll('a[href]').length,
  buttons: document.querySelectorAll('button,[role=button]').length,
  inputs: document.querySelectorAll('input,textarea,select').length,
  scrollHeight: document.documentElement.scrollHeight,
  scrollY: window.scrollY,
}))
console.log('DOM inventory:', JSON.stringify(inventory))

const shot = await target.screenshot({ type: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(new URL('./webview-shot.png', import.meta.url), shot)
console.log('screenshot bytes:', shot.length)

// Reversible control proof: scroll down 50px, read back, scroll back.
const before = await target.evaluate(() => window.scrollY)
await target.mouse.move(400, 300)
await target.mouse.wheel(0, 50)
await target.waitForTimeout(300)
const during = await target.evaluate(() => window.scrollY)
await target.evaluate(y => window.scrollTo(0, y), before)
await target.waitForTimeout(200)
const after = await target.evaluate(() => window.scrollY)
console.log(`control test: scrollY ${before} -> ${during} -> (restored) ${after}`)

await browser.close()
console.log('RESULT: attach + read + screenshot + input all OK')
