import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAgent } from '../src/index'
import { collect, waitFor } from './helpers'

const FIXTURE = fileURLToPath(new URL('./fixtures/fixture-tui.mjs', import.meta.url))

function toB64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function start() {
  return spawnAgent({ cmd: process.execPath, args: [FIXTURE], cols: 80, rows: 24 })
}

describe('spawnAgent core', () => {
  it('emits an initial frame with the PTY geometry', async () => {
    const s = start()
    try {
      const c = collect(s)
      await waitFor(() => c.text.includes('cols=80 rows=24'))
      expect(c.text).toContain('PODIUM-FIXTURE')
      expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
    } finally {
      s.dispose()
    }
  })

  it('round-trips input to the PTY', async () => {
    const s = start()
    try {
      const c = collect(s)
      await waitFor(() => c.text.includes('paint='))
      s.write(toB64('a')) // 'a' === 0x61
      await waitFor(() => c.text.includes('last-input=61'))
      expect(c.text).toContain('last-input=61')
    } finally {
      s.dispose()
    }
  })

  it('resizes the PTY and the TUI repaints at the new geometry', async () => {
    const s = start()
    try {
      const c = collect(s)
      await waitFor(() => c.text.includes('cols=80 rows=24'))
      s.resize(100, 30)
      await waitFor(() => c.text.includes('cols=100 rows=30'))
      expect(s.geometry()).toEqual({ cols: 100, rows: 30 })
    } finally {
      s.dispose()
    }
  })

  it('assigns monotonically increasing frame seq', async () => {
    const s = start()
    try {
      const c = collect(s)
      s.write(toB64('x')) // force at least one extra repaint
      await waitFor(() => c.seqs.length >= 2)
      const seqs = c.seqs
      expect(seqs[0]).toBe(0)
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number)
      }
    } finally {
      s.dispose()
    }
  })

  it('advertises a color-capable terminal (TERM + COLORTERM) to the agent', async () => {
    // The frontend is xterm.js (24-bit color). The agent must see TERM=xterm-256color
    // and COLORTERM=truecolor or supports-color/chalk-based CLIs emit muted or no color.
    const s = spawnAgent({
      cmd: process.execPath,
      args: [
        '-e',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal node -e source code, not a JS template
        'process.stdout.write(`TERM=${process.env.TERM};COLORTERM=${process.env.COLORTERM}\\n`)',
      ],
      cols: 80,
      rows: 24,
    })
    try {
      const c = collect(s)
      await waitFor(() => c.text.includes('COLORTERM='))
      expect(c.text).toContain('TERM=xterm-256color')
      expect(c.text).toContain('COLORTERM=truecolor')
    } finally {
      s.dispose()
    }
  })

  it('emits exit when the agent process ends', async () => {
    const s = start()
    try {
      let code: number | undefined
      s.onExit((c) => {
        code = c
      })
      const c = collect(s)
      await waitFor(() => c.text.includes('paint='))
      s.write(toB64('\x03')) // Ctrl-C → fixture exits 0
      await waitFor(() => code !== undefined)
      expect(code).toBe(0)
    } finally {
      s.dispose()
    }
  })

  it('redraw() forces a fresh repaint even when geometry is unchanged', async () => {
    const s = start()
    try {
      const c = collect(s)
      await waitFor(() => c.text.includes('last-input=')) // initial render fully drained
      const before = c.maxPaint()
      s.redraw()
      await waitFor(() => c.maxPaint() > before)
      expect(c.maxPaint()).toBeGreaterThan(before)
      expect(s.geometry()).toEqual({ cols: 80, rows: 24 }) // geometry restored
    } finally {
      s.dispose()
    }
  })
})
