/*
 * In-page control API for the WebGL warm-set benchmark.
 *
 * Mirrors Podium's terminal-view.ts as closely as a standalone page can:
 *   - @xterm/xterm Terminal with scrollback:5000, fontSize:13, the Podium mono stack
 *   - @xterm/addon-fit loaded
 *   - @xterm/addon-webgl (WebglAddon) loaded AFTER open(), with onContextLoss → dispose
 *     (exactly the fallback Podium uses)
 *
 * Everything is driven from Playwright via window.__bench.* — no server/daemon.
 */
(() => {
  // UMD bundles attach to globals, but the addon bundles export a namespace object
  // (e.window.FitAddon = { FitAddon: class }). Unwrap to the constructor either way.
  const Terminal = window.Terminal && (window.Terminal.Terminal || window.Terminal)
  const FitAddon = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)
  const WebglAddon = window.WebglAddon && (window.WebglAddon.WebglAddon || window.WebglAddon)

  const MONO_STACK =
    "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, 'Cascadia Code', 'DejaVu Sans Mono', Consolas, monospace"

  const DEFAULT_THEME = {
    background: '#0e0e12',
    foreground: '#d7d7e0',
    cursor: '#f59e0b',
    cursorAccent: '#0e0e12',
    selectionBackground: 'rgba(245, 158, 11, 0.30)',
    selectionForeground: '#f3f3f8',
    black: '#16161c',
    brightBlack: '#3a3a46',
    red: '#f87171',
    brightRed: '#fca5a5',
    green: '#34d399',
    brightGreen: '#6ee7b7',
    yellow: '#fbbf24',
    brightYellow: '#fcd34d',
    blue: '#60a5fa',
    brightBlue: '#93c5fd',
    magenta: '#c084fc',
    brightMagenta: '#d8b4fe',
    cyan: '#22d3ee',
    brightCyan: '#67e8f9',
    white: '#d7d7e0',
    brightWhite: '#f3f3f8',
  }

  const stage = document.getElementById('stage')

  /** @type {Array<{id:number,term:any,webgl:any,box:HTMLElement,fit:any}>} */
  const terms = []
  let nextId = 0

  // ~5000 lines of realistic, colored scrollback at 120 cols. Pre-built once so
  // repeated fills are deterministic and don't dominate timing with string work.
  let SCROLLBACK = null
  function buildScrollback(lines, cols) {
    const out = []
    const sgr = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96]
    for (let i = 0; i < lines; i++) {
      const color = sgr[i % sgr.length]
      // A mix: a colored prefix + a path-ish + a long-ish payload, padded toward `cols`.
      const stamp = (1000000 + i).toString()
      let body = `[${color}m[${stamp}][0m src/pkg/module_${i % 97}.ts:${i % 400} ` +
        `[2mtrace[0m value=${(i * 2654435761) % 1000000} ` +
        `payload=${'x'.repeat(40 + (i % 30))}`
      if (body.length > cols + 20) body = body.slice(0, cols + 20)
      out.push(body)
    }
    return out.join('\r\n') + '\r\n'
  }

  function makeTerminal(opts) {
    opts = opts || {}
    const cols = opts.cols || 120
    const rows = opts.rows || 40
    const useWebgl = opts.webgl !== false

    const box = document.createElement('div')
    box.className = 'term-box'
    box.style.zIndex = String(nextId)
    stage.appendChild(box)

    const term = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      convertEol: false,
      cursorBlink: false, // off during bench to avoid rAF noise; not a renderer factor
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: MONO_STACK,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.15,
      letterSpacing: 0,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: false,
      scrollSensitivity: 3,
      theme: DEFAULT_THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(box)

    let webgl = null
    let contextLost = false
    if (useWebgl) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          contextLost = true
          rec.contextLost = true
          try {
            webgl.dispose()
          } catch {}
        })
        term.loadAddon(webgl)
      } catch (e) {
        webgl = null
        rec && (rec.webglThrew = String((e && e.message) || e))
      }
    }

    const rec = {
      id: nextId++,
      term,
      webgl,
      box,
      fit,
      contextLost: false,
      webglThrew: null,
    }
    terms.push(rec)
    return rec
  }

  function fill(rec, lines, cols) {
    if (!SCROLLBACK || SCROLLBACK._lines !== lines || SCROLLBACK._cols !== cols) {
      SCROLLBACK = buildScrollback(lines, cols)
      SCROLLBACK._lines = lines
      SCROLLBACK._cols = cols
    }
    return new Promise((resolve) => {
      rec.term.write(SCROLLBACK, () => resolve())
    })
  }

  function rafTwice() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  function heap() {
    return (performance && performance.memory && performance.memory.usedJSHeapSize) || 0
  }

  // ---- WebGL capability probe -------------------------------------------------
  function webglProbe() {
    const c = document.createElement('canvas')
    let gl = null
    try {
      gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')
    } catch {}
    if (!gl) return { ok: false, reason: 'no context' }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    const version = gl.getParameter(gl.VERSION)
    const software = /swiftshader|software|llvmpipe/i.test(String(renderer)) || /swiftshader/i.test(String(vendor))
    return { ok: true, vendor: String(vendor), renderer: String(renderer), version: String(version), software }
  }

  window.__bench = {
    webglProbe,
    heap,
    count: () => terms.length,

    // (A) context cap: add one webgl-backed terminal, fill it, return state.
    async addWebglTerm() {
      const rec = makeTerminal({ cols: 120, rows: 40, webgl: true })
      await fill(rec, 5000, 120)
      await rafTwice()
      // report whether THIS one threw, and whether ANY earlier term lost its context.
      const anyLost = terms.some((t) => t.contextLost)
      return {
        id: rec.id,
        total: terms.length,
        webglThrew: rec.webglThrew,
        hasWebgl: !!rec.webgl && !rec.contextLost,
        anyContextLost: anyLost,
        lostIds: terms.filter((t) => t.contextLost).map((t) => t.id),
      }
    },

    // (B) memory: add a terminal of a given renderer mode, fill, settle, report heap.
    // mode: 'webgl' | 'dom' | 'disposed'  (disposed = webgl loaded then disposed, term kept)
    async addMemTerm(mode) {
      const rec = makeTerminal({ cols: 120, rows: 40, webgl: mode === 'webgl' || mode === 'disposed' })
      await fill(rec, 5000, 120)
      if (mode === 'disposed' && rec.webgl) {
        rec.webgl.dispose()
        rec.webgl = null
      }
      await rafTwice()
      return { id: rec.id, total: terms.length }
    },

    // (C) latency: build ONE terminal, fill it, then time hide/show cycles.
    // strategy: 'retain' | 'drop' | 'dom'
    async latencyRun(strategy, iterations) {
      iterations = iterations || 8
      // fresh terminal for the run
      const rec = makeTerminal({ cols: 120, rows: 40, webgl: strategy !== 'dom' })
      await fill(rec, 5000, 120)
      await rafTwice()
      const samples = []
      for (let i = 0; i < iterations; i++) {
        // hide
        if (strategy === 'drop' && rec.webgl) {
          rec.webgl.dispose()
          rec.webgl = null
        }
        rec.box.style.display = 'none'
        await rafTwice()
        // show + measure time-to-first-painted-frame
        const t0 = performance.now()
        rec.box.style.display = ''
        if (strategy === 'drop') {
          try {
            const w = new WebglAddon()
            w.onContextLoss(() => {
              try {
                w.dispose()
              } catch {}
            })
            rec.term.loadAddon(w)
            rec.webgl = w
          } catch (e) {
            // could not re-acquire a context; record as NaN-ish large
          }
        }
        // a write + refresh forces the renderer to repaint, like Podium does on show.
        rec.term.write('[s[u') // save/restore cursor: a no-op repaint nudge
        rec.term.refresh(0, rec.term.rows - 1)
        await new Promise((resolve) => requestAnimationFrame(() => resolve()))
        const dt = performance.now() - t0
        samples.push(dt)
      }
      samples.sort((a, b) => a - b)
      const sum = samples.reduce((a, b) => a + b, 0)
      return {
        strategy,
        iterations,
        samples: samples.map((s) => +s.toFixed(3)),
        mean: +(sum / samples.length).toFixed(3),
        median: +samples[Math.floor(samples.length / 2)].toFixed(3),
        min: +samples[0].toFixed(3),
        max: +samples[samples.length - 1].toFixed(3),
      }
    },

    reset() {
      for (const t of terms) {
        try {
          t.term.dispose()
        } catch {}
        try {
          t.box.remove()
        } catch {}
      }
      terms.length = 0
    },
  }

  window.__benchReady = true
})()
