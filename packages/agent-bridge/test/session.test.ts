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
    const c = collect(s)
    await waitFor(() => c.text.includes('cols=80 rows=24'))
    expect(c.text).toContain('PODIUM-FIXTURE')
    expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
    s.dispose()
  })

  it('round-trips input to the PTY', async () => {
    const s = start()
    const c = collect(s)
    await waitFor(() => c.text.includes('paint='))
    s.write(toB64('a')) // 'a' === 0x61
    await waitFor(() => c.text.includes('last-input=61'))
    expect(c.text).toContain('last-input=61')
    s.dispose()
  })

  it('resizes the PTY and the TUI repaints at the new geometry', async () => {
    const s = start()
    const c = collect(s)
    await waitFor(() => c.text.includes('cols=80 rows=24'))
    s.resize(100, 30)
    await waitFor(() => c.text.includes('cols=100 rows=30'))
    expect(s.geometry()).toEqual({ cols: 100, rows: 30 })
    s.dispose()
  })

  it('assigns monotonically increasing frame seq', async () => {
    const s = start()
    const c = collect(s)
    s.write(toB64('x')) // force at least one extra repaint
    await waitFor(() => c.seqs.length >= 2)
    const seqs = c.seqs
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number)
    }
    s.dispose()
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
      await waitFor(() => c.maxPaint() >= 1)
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
