import puppeteer from 'puppeteer-core'
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
console.log('connected:', browser.connected, '| version:', await browser.version())
const pages = await browser.pages()
console.log('puppeteer pages():', pages.length)
for (const p of pages) console.log('  -', p.url(), '|', (await p.title()).slice(0, 60))
const targets = browser.targets().map(t => `${t.type()} :: ${t.url().slice(0, 70)}`)
console.log('all targets:'); targets.forEach(t => console.log('  ', t))
const guest = pages.find(p => !p.url().startsWith('dsh-app://'))
if (guest) {
  console.log('guest read:', await guest.evaluate(() => ({ title: document.title, links: document.querySelectorAll('a').length })))
} else console.log('!! puppeteer cannot see the webview as a page')
await browser.disconnect()
