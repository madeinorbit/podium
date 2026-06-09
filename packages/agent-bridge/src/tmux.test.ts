import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attachTmuxAgent,
  isTmuxAvailable,
  killTmuxServer,
  newSessionArgs,
  shellQuote,
  spawnTmuxAgent,
  tmuxConfigCommands,
  tmuxHasSession,
} from './tmux'

describe('tmux command builders', () => {
  it('shell-quotes args safely', () => {
    expect(shellQuote(`a b`)).toBe(`'a b'`)
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('builds a new-session arg vector with geometry + cwd + inner command', () => {
    expect(newSessionArgs('podium-x', 80, 24, '/p', 'claude --resume t9')).toEqual([
      '-L',
      'podium-x',
      'new-session',
      '-d',
      '-s',
      'main',
      '-x',
      '80',
      '-y',
      '24',
      '-c',
      '/p',
      'claude --resume t9',
    ])
  })

  it('config commands include the input-fidelity + title settings', () => {
    const cmds = tmuxConfigCommands('podium-x')
    const flat = cmds.map((c) => c.join(' '))
    expect(flat).toContain('-L podium-x set -g prefix None')
    expect(flat).toContain('-L podium-x set -sg escape-time 0')
    expect(flat).toContain(`-L podium-x set -g set-titles-string #{pane_title}`)
    expect(flat).toContain('-L podium-x set -g extended-keys on')
  })

  it('isTmuxAvailable returns a boolean', () => {
    expect(typeof isTmuxAvailable()).toBe('boolean')
  })
})

const hasTmux = isTmuxAvailable()
const FIXTURE = fileURLToPath(new URL('../test/fixtures/echo-title.mjs', import.meta.url))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasTmux)('tmux integration', () => {
  it('streams frames, surfaces the OSC title, round-trips input, survives detach, reattaches, kills', async () => {
    const label = `podium-itest-${process.pid}`
    killTmuxServer(label)
    const session = spawnTmuxAgent({
      label,
      cmd: 'node',
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    let out = ''
    let title = ''
    session.onFrame((f) => {
      out += Buffer.from(f.data, 'base64').toString('utf8')
    })
    session.onTitle((t) => {
      title = t
    })
    await wait(700)
    expect(out).toContain('READY') // byte-transparency
    expect(title).toContain('FIXTURE-TITLE') // OSC title re-emit via set-titles

    session.write(Buffer.from('hi\r', 'utf8').toString('base64'))
    await wait(500)
    expect(out).toContain('6869') // input reached the agent (hex of 'hi')

    // dispose() detaches the client; the agent (tmux server) survives.
    session.dispose()
    await wait(300)
    expect(tmuxHasSession(label)).toBe(true)

    // reattach gets a repaint.
    const re = attachTmuxAgent({ label, cols: 80, rows: 24 })
    let out2 = ''
    re.onFrame((f) => {
      out2 += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await wait(500)
    expect(out2.length).toBeGreaterThan(0)
    re.dispose()

    // explicit kill terminates the agent.
    killTmuxServer(label)
    await wait(200)
    expect(tmuxHasSession(label)).toBe(false)
  }, 15000)
})
