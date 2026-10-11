import { describe, expect, it, vi } from 'vitest'
import { clackIO, isCancel, onInterrupt, scriptedIO } from './setup-ui'

describe('scriptedIO (the test double every setup flow is driven through)', () => {
  it('serves ONE ordered queue across mixed widget kinds', async () => {
    // The whole point of a single queue: a flow's answers can be written in the order the
    // operator would give them, without the test author tracking which widget each belongs to.
    const { io } = scriptedIO(['all-in-one', 'https://a.test', true])
    expect(
      await io.select({
        message: 'mode',
        options: [
          { value: 'all-in-one', label: 'a' },
          { value: 'server', label: 'b' },
        ],
      }),
    ).toBe('all-in-one')
    expect(await io.text({ message: 'url' })).toBe('https://a.test')
    expect(await io.confirm({ message: 'systemd?' })).toBe(true)
  })

  it('returns CANCEL once the queue is exhausted, so a flow cannot spin on EOF', async () => {
    // readline resolved '' forever at EOF, which is why every loop needed a MAX_ATTEMPTS
    // counter. An exhausted queue is that same condition, and it must terminate the flow.
    const { io } = scriptedIO([])
    expect(isCancel(await io.text({ message: 'url' }))).toBe(true)
    expect(isCancel(await io.confirm({ message: 'ok?' }))).toBe(true)
  })

  it('applies validate and consumes another answer when one is rejected', async () => {
    const { io } = scriptedIO(['nope', 'https://a.test'])
    const validate = (s: string) => (s.startsWith('https://') ? undefined : 'must be https')
    expect(await io.text({ message: 'url', validate })).toBe('https://a.test')
  })

  it('gives CANCEL rather than looping when every remaining answer fails validate', async () => {
    const { io } = scriptedIO(['no', 'still-no'])
    const validate = (s: string) => (s.startsWith('https://') ? undefined : 'must be https')
    expect(isCancel(await io.text({ message: 'url', validate }))).toBe(true)
  })

  it('falls back to defaultValue for an empty text answer', async () => {
    const { io } = scriptedIO([''])
    expect(await io.text({ message: 'port', defaultValue: '18787' })).toBe('18787')
  })

  it('uses initialValue when a confirm answer is empty', async () => {
    const { io } = scriptedIO([undefined])
    expect(await io.confirm({ message: 'systemd?', initialValue: true })).toBe(true)
  })

  it('records printed output for assertions', () => {
    const { io, output } = scriptedIO([])
    io.step('Downloading')
    io.success('Signature verified')
    io.warn('No systemd service')
    expect(output).toEqual(['Downloading', 'Signature verified', 'No systemd service'])
  })

  it('renders command() with the command ALONE on its own line [R9]', () => {
    // This is the copy-paste contract: whatever an operator drag-selects on that line is
    // exactly what they should run — no sigil, no caption, no box glyph sharing the line.
    const { io, output } = scriptedIO([])
    io.command('tailscale funnel 18787', 'Run this, then come back:')
    expect(output.some((l) => l.trim() === 'tailscale funnel 18787')).toBe(true)
    expect(output.join('\n')).toContain('Run this, then come back:')
  })

  it('keeps a multi-line command block one command per line [R9]', () => {
    const { io, output } = scriptedIO([])
    io.command('podium status\npodium stop')
    const lines = output
      .join('\n')
      .split('\n')
      .map((l) => l.trim())
    expect(lines).toContain('podium status')
    expect(lines).toContain('podium stop')
  })
})

describe('clackIO spinner and Ctrl-C (POD-3274)', () => {
  // clack's spinner answers Ctrl-C in raw mode with process.exit(0), which no SIGINT handler
  // sees. The wrapper hands Ctrl-C back as SIGINT; these call the listeners it adds directly,
  // so the test runner never receives a real signal.
  const sigintAddedBy = (start: () => void): (() => void)[] => {
    const before = new Set(process.listeners('SIGINT'))
    start()
    return process.listeners('SIGINT').filter((l) => !before.has(l)) as (() => void)[]
  }
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

  it('exits 130 on Ctrl-C during a spinner when nothing else handles it', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const spin = clackIO().spinner()
    const added = sigintAddedBy(() => spin.start('waiting'))
    try {
      for (const listener of added) listener()
      await nextTurn()
      expect(exit).toHaveBeenCalledWith(130)
    } finally {
      spin.stop()
      exit.mockRestore()
    }
    expect(process.listeners('SIGINT').filter((l) => added.includes(l as () => void))).toEqual([])
  })

  it('leaves the exit to a setup interrupt handler, which runs first', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const taken: string[] = []
    const unregister = onInterrupt(() => taken.push('undo'))
    const spin = clackIO().spinner()
    const owner = process.listeners('SIGINT').at(-1) as () => void
    const added = sigintAddedBy(() => spin.start('waiting'))
    try {
      owner()
      for (const listener of added) listener()
      await nextTurn()
      expect(taken).toEqual(['undo'])
      expect(exit).not.toHaveBeenCalled()
    } finally {
      spin.stop()
      unregister()
      exit.mockRestore()
    }
  })
})
