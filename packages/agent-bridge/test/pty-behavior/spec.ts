import { fileURLToPath } from 'node:url'
import type { PtyBackend } from '../../src/pty/index'
import { type AgentSession, spawnAgent } from '../../src/session'

const FIX = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
const KEYECHO_DIR = fileURLToPath(new URL('../../../../tests/keyecho', import.meta.url))
const KEYECHO_CLI = fileURLToPath(new URL('../../../../tests/keyecho/src/cli.tsx', import.meta.url))
// biome-ignore lint/suspicious/noControlCharactersInRegex: needed to strip ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export interface TestPrimitives {
  describe: (name: string, fn: () => void) => void
  // biome-ignore lint/suspicious/noExplicitAny: runner-neutral primitives
  it: (name: string, fn: () => Promise<void> | void, timeout?: number) => void
  // biome-ignore lint/suspicious/noExplicitAny: runner-neutral primitives
  expect: (actual: unknown) => any
}

function textOf(s: AgentSession): { raw: () => string; stripped: () => string } {
  let buf = ''
  s.onFrame((f) => {
    buf += Buffer.from(f.data, 'base64').toString('utf8')
  })
  return { raw: () => buf, stripped: () => buf.replace(ANSI, '') }
}
function bytesOf(s: AgentSession): () => Buffer {
  const chunks: Buffer[] = []
  s.onFrame((f) => {
    chunks.push(Buffer.from(f.data, 'base64'))
  })
  return () => Buffer.concat(chunks)
}
async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const b64bytes = (bytes: number[]): string => Buffer.from(bytes).toString('base64')
const paints = (t: string): number[] => (t.match(/paint=(\d+)/g) ?? []).map((m) => Number(m.slice(6)))

export function ptyBehaviorSpec(t: TestPrimitives, makeBackend: () => PtyBackend): void {
  const { describe, it, expect } = t
  const spawn = (cmd: string, args: string[], cols = 80, rows = 24): AgentSession =>
    spawnAgent({ cmd, args, cols, rows }, makeBackend())

  describe(`pty behavior [${makeBackend().name}]`, () => {
    it('1: emits an initial frame with the PTY geometry', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('cols=80 rows=24'))
        expect(c.raw()).toContain('PODIUM-FIXTURE')
        expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
      } finally {
        s.dispose()
      }
    }, 15000)

    it('2a: write byte-fidelity round-trips arbitrary bytes', async () => {
      const s = spawn('node', [FIX('stdin-hex.mjs')])
      try {
        const c = textOf(s)
        const cases: number[][] = [
          [0x61],
          [0x03],
          [0x0d],
          [0x1b, 0x5b, 0x41],
          [0xff],
          [0xc3, 0xa9],
          [0xf0, 0x9f, 0xa4, 0x96],
        ]
        for (const bytes of cases) {
          s.write(b64bytes(bytes))
          const hex = bytes.map((x) => x.toString(16).padStart(2, '0')).join('')
          await waitFor(() => c.raw().includes(`<${hex}>`))
          expect(c.raw()).toContain(`<${hex}>`)
        }
      } finally {
        s.dispose()
      }
    }, 15000)

    it('2b: keyecho decodes real keystrokes under this backend', async () => {
      // cwd = keyecho's package dir so tsx picks up its React-runtime tsconfig.
      const s = spawnAgent(
        { cmd: 'node', args: ['--import', 'tsx', KEYECHO_CLI, '--mode', 'raw'], cols: 100, rows: 30, cwd: KEYECHO_DIR },
        makeBackend(),
      )
      try {
        const c = textOf(s)
        await waitFor(() => c.stripped().includes('mode='), 20000)
        s.write(b64bytes([0x1b, 0x5b, 0x41])) // up arrow → keyecho raw-decodes to the 'Up' label
        await waitFor(() => c.stripped().includes('Up'))
        expect(c.stripped()).toContain('Up')
      } finally {
        s.dispose()
      }
    }, 25000)

    it('3: output is byte-exact across chunking (large blob)', async () => {
      const s = spawn('node', [FIX('fixture-blob.mjs')])
      try {
        const all = bytesOf(s)
        const START = Buffer.from('BLOB-START|')
        const END = Buffer.from('|BLOB-END')
        await waitFor(() => {
          const b = all()
          const i = b.indexOf(START)
          return i >= 0 && b.indexOf(END, i) > i
        }, 15000)
        const b = all()
        const from = b.indexOf(START) + START.length
        const to = b.indexOf(END, from)
        const body = b.subarray(from, to)
        const tmpl: number[] = []
        for (let x = 0; x < 256; x++) if (x !== 0x0a && x !== 0x0d) tmpl.push(x)
        const expected = Buffer.concat(Array.from({ length: 600 }, () => Buffer.from(tmpl)))
        expect(body.length).toBe(expected.length)
        expect(body.equals(expected)).toBe(true)
      } finally {
        s.dispose()
      }
    }, 20000)

    it('4: reassembles a multi-byte OSC title split across reads', async () => {
      const s = spawn('node', [FIX('fixture-title-split.mjs')])
      try {
        let got: string | undefined
        s.onTitle((tt) => {
          got = tt
        })
        await waitFor(() => got !== undefined)
        expect(got).toBe('🤖 Robot Agent ✓')
      } finally {
        s.dispose()
      }
    }, 15000)

    it('5: parses an OSC title (BEL form) and dedups repeats', async () => {
      const s = spawn('node', [FIX('echo-title.mjs')])
      try {
        const titles: string[] = []
        s.onTitle((tt) => titles.push(tt))
        await waitFor(() => titles.includes('FIXTURE-TITLE'))
        expect(titles.filter((x) => x === 'FIXTURE-TITLE').length).toBe(1)
      } finally {
        s.dispose()
      }
    }, 15000)

    it('6: resize delivers new geometry to the child', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('cols=80 rows=24'))
        s.resize(100, 30)
        await waitFor(() => c.raw().includes('cols=100 rows=30'))
        expect(s.geometry()).toEqual({ cols: 100, rows: 30 })
      } finally {
        s.dispose()
      }
    }, 15000)

    it('7: redraw() forces a repaint at unchanged geometry', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('last-input='))
        const before = Math.max(0, ...paints(c.raw()))
        s.redraw()
        await waitFor(() => Math.max(0, ...paints(c.raw())) > before)
        expect(Math.max(0, ...paints(c.raw()))).toBeGreaterThan(before)
        expect(s.geometry()).toEqual({ cols: 80, rows: 24 })
      } finally {
        s.dispose()
      }
    }, 15000)

    it('8: emits exit code 0 on clean child exit', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        let code: number | undefined
        s.onExit((cc) => {
          code = cc
        })
        const c = textOf(s)
        await waitFor(() => c.raw().includes('PODIUM-FIXTURE'))
        s.write(b64('\x03')) // fixture exits 0 on Ctrl-C
        await waitFor(() => code !== undefined)
        expect(code).toBe(0)
      } finally {
        s.dispose()
      }
    }, 15000)

    it('9: advertises TERM + COLORTERM to the child', async () => {
      const s = spawn('node', [
        '-e',
        'process.stdout.write(`T=${process.env.TERM};C=${process.env.COLORTERM}`)',
      ])
      try {
        const c = textOf(s)
        await waitFor(() => c.raw().includes('C='))
        expect(c.raw()).toContain('T=xterm-256color')
        expect(c.raw()).toContain('C=truecolor')
      } finally {
        s.dispose()
      }
    }, 15000)

    it('10: assigns monotonically increasing frame seq', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      try {
        const seqs: number[] = []
        s.onFrame((f) => seqs.push(f.seq))
        s.write(b64('x'))
        await waitFor(() => seqs.length >= 2)
        expect(seqs[0]).toBe(0)
        for (let i = 1; i < seqs.length; i++)
          expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number)
      } finally {
        s.dispose()
      }
    }, 15000)

    it('11: dispose stops frames and kills the child', async () => {
      const s = spawn('node', [FIX('fixture-tui.mjs')])
      const c = textOf(s)
      await waitFor(() => c.raw().includes('PODIUM-FIXTURE'))
      const pid = s.pid
      s.dispose()
      const len = c.raw().length
      await waitFor(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }, 5000)
      await new Promise((r) => setTimeout(r, 100))
      expect(c.raw().length).toBe(len) // no frames after dispose
    }, 15000)
  })
}
