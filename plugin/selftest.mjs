// Pre-flight test: run the plugin's own code with a stub ctx against the live
// debug port, so a restart is not the first time it executes.
//
//   node selftest.mjs [port]
import { apply, Config, inject, name } from './lib/index.js'

const port = Number(process.argv[2] ?? 9222)
const tools = new Map()
const ctx = { tools: { register: definition => tools.set(definition.name, definition) } }

const config = { port, tab: '', vaultDir: process.env.VAULT_DIR ?? '/tmp/dsh-vault-selftest' }
apply(ctx, config)

console.log(`plugin: ${name} | inject: ${inject.join(', ')} | config keys: ${Object.keys(Config.dict ?? Config).join(',')}`)
console.log(`registered ${tools.size} tools:`)
for (const key of tools.keys()) console.log('  -', key)

const call = async (toolName, args = {}) => {
  const tool = tools.get(toolName)
  if (!tool) throw new Error(`no such tool: ${toolName}`)
  const value = await tool.execute(args, { signal: AbortSignal.timeout(20000) })
  const rendered = tool.output.render(args, value)
  return { value, text: rendered.map(part => part.text ?? '').join('') }
}

for (const probe of [
  ['browser_tabs', {}],
  ['browser_snapshot', {}],
  ['browser_text', { max: 200 }],
  ['browser_scroll', { direction: 'down', amount: 900 }],
  ['browser_scroll', { direction: 'top' }],
  ['browser_snapshot', {}],
  ['browser_screenshot', { savePath: '/tmp/dsh-selftest-slice.png' }],
  ['browser_screenshot', { full: true, savePath: '/tmp/dsh-selftest-full.png' }],
  ['browser_cookies_export', {}],
  ['browser_cookies_vaults', {}],
  ['browser_cookies_import', {}],
]) {
  try {
    const { text } = await call(probe[0], probe[1])
    const head = probe[0] === 'browser_snapshot' ? text.split('\n').slice(0, 3) : text.split('\n').slice(0, 12)
    console.log(`\n### ${probe[0]}\n${head.join('\n')}`)
  } catch (error) {
    console.log(`\n### ${probe[0]} FAILED: ${error.message}`)
  }
}

// Error path: a missing debug port must produce an actionable message.
const deadCtx = { tools: { register: definition => tools.set('dead:' + definition.name, definition) } }
apply(deadCtx, { port: 9299, tab: '' })
try {
  await call('browser_tabs')
} catch {}
try {
  const tool = tools.get('dead:browser_tabs')
  await tool.execute({}, { signal: AbortSignal.timeout(6000) })
  console.log('\nerror path: UNEXPECTED SUCCESS')
} catch (error) {
  console.log(`\nerror path (port 9299): ${error.message.split('\n')[0].slice(0, 140)}`)
}
