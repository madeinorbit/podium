import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PtyProcess } from '../src/backends/types'
import { spawnAgent } from '../src/session'
import { wrapPty } from '../src/session'
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
      // A direct pty cannot read its size back, so it states none (POD-4723).
      expect(s.size).toBeUndefined()
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
})

/** A fake PtyProcess, so the exact bytes/resizes are observable without a real child. */
function fakePty(): {
  proc: PtyProcess
  writes: Uint8Array[]
  resizes: Array<[number, number]>
  emit: (b: Uint8Array) => void
} {
  const dataCbs: Array<(b: Uint8Array) => void> = []
  const writes: Uint8Array[] = []
  const resizes: Array<[number, number]> = []
  const proc: PtyProcess = {
    pid: 4242,
    onData: (cb) => {
      dataCbs.push(cb)
    },
    onExit: () => {},
    write: (d) => {
      writes.push(d)
    },
    resize: (c, r) => {
      resizes.push([c, r])
    },
    kill: () => {},
  }
  return {
    proc,
    writes,
    resizes,
    emit: (b) => {
      for (const cb of dataCbs) cb(b)
    },
  }
}

describe('wrapPty raw output', () => {
  it('emits arbitrary bytes without text or base64 conversion', () => {
    const { proc, emit } = fakePty()
    const session = wrapPty(proc)
    const frames: Uint8Array[] = []
    session.onFrame((frame) => frames.push(frame.data))
    emit(Uint8Array.of(0x00, 0xff, 0xc3, 0x28, 0x1b))
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0] ?? [])).toEqual([0x00, 0xff, 0xc3, 0x28, 0x1b])
    session.dispose()
  })
})

describe('wrapPty has no repaint of its own (POD-4723)', () => {
  it('a resize is exactly one resize: no shrink-and-restore nudge, no Ctrl-L', () => {
    const { proc, writes, resizes, emit } = fakePty()
    const s = wrapPty(proc)
    s.resize(120, 40)
    emit(Buffer.from('repaint'))
    expect(resizes).toEqual([[120, 40]])
    expect(writes).toEqual([])
    expect('redraw' in s).toBe(false)
  })
})

