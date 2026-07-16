import { fileURLToPath } from 'node:url'
import { type AgentSession, resolveNodeExecutable, spawnAgent } from '@podium/agent-bridge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// keyecho is a fake agent CLI; spawn it the same way the daemon spawns claude/codex,
// and assert agent-bridge forwards keystroke bytes through the PTY to the agent.
const CLI = fileURLToPath(new URL('../keyecho/src/cli.tsx', import.meta.url))
const PKG = fileURLToPath(new URL('../keyecho', import.meta.url))

// biome-ignore lint/suspicious/noControlCharactersInRegex: needed to strip ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

const toB64 = (s: string): string => Buffer.from(s, 'latin1').toString('base64')

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

const FIDELITY = [
  { bytes: '\x03', label: 'Ctrl+C' },
  { bytes: '\x1b[Z', label: 'Shift+Tab' },
  { bytes: '\x1b\x1b', label: 'Escape' },
  { bytes: '\r', label: 'Enter' },
  { bytes: '\x1b[<64;5;5M', label: 'wheelUp' },
]

describe('agent-bridge forwards keystrokes to the agent (keyecho)', () => {
  let session: AgentSession
  let buf = ''
  const text = () => buf.replace(ANSI, '')

  beforeAll(async () => {
    // keyecho is a Node/tsx Ink app. Under `bun --bun vitest`, bare `node` is a Bun
    // shim — use resolveNodeExecutable() for a real Node (README test prerequisite).
    session = spawnAgent({
      cmd: resolveNodeExecutable(),
      args: ['--import', 'tsx', CLI, '--mode', 'raw'],
      cols: 100,
      rows: 30,
      cwd: PKG,
    })
    session.onFrame((f) => {
      buf += Buffer.from(f.data, 'base64').toString('utf8')
    })
    await waitFor(() => text().includes('keyecho') && text().includes('mode='), 15000)
  }, 20000)

  afterAll(() => session?.dispose())

  for (const f of FIDELITY) {
    it(`forwards ${f.label}`, async () => {
      session.write(toB64(f.bytes))
      await waitFor(() => text().includes(f.label), 8000)
      expect(text()).toContain(f.label)
    }, 10000)
  }
})
