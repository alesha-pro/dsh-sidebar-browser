/**
 * dsh-sidebar-browser-cdp — client half.
 *
 * Runs in the DSH Desktop app window, next to the right sidebar. It long-polls
 * the host half for one command at a time and runs it against the sidebar
 * Browser tab with the `<webview>` element's own methods (`executeJavaScript`,
 * `sendInputEvent`, `insertText`, `loadURL`, `goBack`) and the sidebar service
 * (`ctx.sidebarRight`). No debug port is involved.
 *
 * `capturePage()` is deliberately never called: on DSH Desktop 0.2.0-rc.2 it
 * crashes the window's renderer process. Screenshots stay on the debug port.
 *
 * The shell fetches this file from /plugins/dsh-sidebar-browser-cdp/client.js
 * and runs it through window.__ModuleLoader__; it uses no other plugin module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-browser-cdp',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const PREFIX = '/dsh-sidebar-browser'
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const safe = (read, fallback) => { try { return read() } catch (error) { return fallback } }
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }

    /** Sidebar Browser guests of this window; the shell tags them itself. */
    const guests = () => [...document.querySelectorAll('webview[data-sidebar-browser-frame]')]
    const urlOf = guest => safe(() => guest.getURL(), '')
    const titleOf = guest => safe(() => guest.getTitle(), '')

    /** The guest a command addresses: a URL/title fragment, else the visible tab. */
    function pick (want) {
      const all = guests().filter(guest => /^https?:/.test(urlOf(guest)))
      if (all.length === 0) throw new Error('no-guest')
      if (want) {
        const needle = String(want).toLowerCase()
        const hit = all.find(guest => urlOf(guest).toLowerCase().includes(needle) || titleOf(guest).toLowerCase().includes(needle))
        if (hit) return hit
      }
      return all.find(visible) ?? all[0]
    }

    /** Dock tabs as the shell draws them; hidden duplicates and the start page are skipped. */
    const dockTabs = () => [...document.querySelectorAll('[data-dockkit-tab]')]
      .filter(el => visible(el) && !el.hasAttribute('data-dockkit-tab-quiet'))
      .map(el => ({ id: el.getAttribute('data-dockkit-tab'), title: el.innerText.trim(), active: el.getAttribute('aria-selected') === 'true' }))

    /** `sendInputEvent` key names (Electron accelerator codes) for the keys the tools accept. */
    const KEYS = {
      Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
    }

    /**
     * Evaluate in the guest. A thrown error surfaces from `executeJavaScript` as
     * one generic message, so a failure is retried through `eval` to recover the
     * real text; a page whose CSP forbids `eval` keeps the generic one.
     */
    async function evaluate (guest, code) {
      try {
        return await guest.executeJavaScript(code)
      } catch (error) {
        const probe = `(async () => { try { await (0, eval)(${JSON.stringify(code)}); return null } catch (e) { return String(e && (e.stack || e.message) || e) } })()`
        const detail = await guest.executeJavaScript(probe).catch(() => null)
        throw new Error(detail || String(error && error.message || error))
      }
    }

    function operations (ctx) {
      const sidebar = () => {
        const service = ctx.get('sidebarRight')
        if (!service) throw new Error('the right sidebar service is not available in this window')
        return service
      }
      return {
        tabs: async () => guests()
          .filter(guest => /^https?:/.test(urlOf(guest)))
          .map(guest => ({ url: urlOf(guest), title: titleOf(guest), visible: visible(guest) })),

        eval: ({ code, tab }) => evaluate(pick(tab), code),

        navigate: async ({ url, tab }) => {
          // Resolves on load and rejects on a redirect or an aborted load; the
          // caller polls readyState, so neither outcome is awaited here.
          Promise.resolve(pick(tab).loadURL(url)).catch(() => {})
          return true
        },

        click: async ({ x, y, count, tab }) => {
          const guest = pick(tab)
          const base = { x, y, button: 'left', clickCount: count || 1 }
          await guest.sendInputEvent({ type: 'mouseMove', x, y })
          await guest.sendInputEvent({ type: 'mouseDown', ...base })
          await guest.sendInputEvent({ type: 'mouseUp', ...base })
          return true
        },

        insertText: async ({ text, tab }) => {
          await pick(tab).insertText(text)
          return true
        },

        key: async ({ key, tab }) => {
          const guest = pick(tab)
          const keyCode = KEYS[key] ?? (String(key).length === 1 ? key : undefined)
          if (keyCode === undefined) throw new Error(`unsupported key: ${key}`)
          await guest.sendInputEvent({ type: 'keyDown', keyCode })
          await guest.sendInputEvent({ type: 'char', keyCode })
          await guest.sendInputEvent({ type: 'keyUp', keyCode })
          return true
        },

        history: async ({ action, tab }) => {
          const guest = pick(tab)
          if (action === 'reload') guest.reload()
          else if (action === 'back') { if (!guest.canGoBack()) return null; guest.goBack() }
          else if (action === 'forward') { if (!guest.canGoForward()) return null; guest.goForward() }
          else throw new Error(`unsupported action: ${action}`)
          await sleep(1200)
          return urlOf(guest)
        },

        open: async ({ url }) => {
          const known = new Map(guests().map(guest => [guest, urlOf(guest)]))
          sidebar().openTab('browser', url ? { params: { url } } : {})
          if (!url) {
            await sleep(500)
            return { opened: null, tabs: dockTabs() }
          }
          for (let i = 0; i < 50; i++) {
            await sleep(200)
            const fresh = guests().find(guest => /^https?:/.test(urlOf(guest)) && known.get(guest) !== urlOf(guest))
            if (fresh) return { opened: urlOf(fresh), tabs: dockTabs() }
          }
          throw new Error(`the tab opened but no page appeared for ${url} within 10 s`)
        },

        close: async ({ tab, sidebar: collapse }) => {
          const service = sidebar()
          if (collapse) {
            if (!service.isExpanded()) return { collapsed: false }
            service.toggleExpanded()
            return { collapsed: true }
          }
          const tabs = dockTabs()
          let hit
          if (tab) {
            const needle = String(tab).toLowerCase()
            hit = tabs.find(entry => entry.title.toLowerCase().includes(needle))
          } else {
            const active = safe(() => service.active(), undefined)
            hit = (active && tabs.find(entry => entry.id === active.id)) ?? tabs.find(entry => entry.active)
          }
          if (!hit) return { closed: null, tabs }
          service.close(hit.id)
          await sleep(400)
          return { closed: hit.title, tabs: dockTabs() }
        },
      }
    }

    /**
     * Serve commands from the host half until this plugin is unloaded.
     * @param ctx - the client plugin context.
     */
    function apply (ctx) {
      let stopped = false
      let controller

      const post = async (path, body) => {
        controller = new AbortController()
        const response = await fetch(`${PREFIX}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`bridge ${path}: HTTP ${response.status}`)
        return response.json()
      }

      const serve = async () => {
        const run = operations(ctx)
        while (!stopped) {
          let command
          try {
            command = await post('poll', {})
          } catch (error) {
            if (stopped) return
            await sleep(1500)
            continue
          }
          if (!command || command.idle || !command.id) continue
          let reply
          try {
            const operation = run[command.op]
            if (!operation) throw new Error(`unknown operation: ${command.op}`)
            const value = await operation(command.args || {})
            reply = { id: command.id, ok: true, value: value === undefined ? null : value }
          } catch (error) {
            reply = { id: command.id, ok: false, error: String(error && error.message || error) }
          }
          try {
            await post('reply', reply)
          } catch (error) {
            // The value could not be serialised or the host went away; say so
            // rather than leaving the tool call to time out.
            await post('reply', { id: command.id, ok: false, error: `could not return the result: ${String(error && error.message || error)}` }).catch(() => {})
          }
        }
      }

      ctx.effect(
        () => {
          serve()
          return () => {
            stopped = true
            if (controller) controller.abort()
          }
        },
        'dsh-sidebar-browser: window bridge',
      )
    }

    exports.apply = apply
    return module.exports
  },
})
