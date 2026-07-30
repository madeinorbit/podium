import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodePtyBackend } from '../../src/pty/index'
import { spawnAgent } from '../../src/session'

// biome-ignore lint/suspicious/noControlCharactersInRegex: needed to strip ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Real `claude` is opt-in: present on PATH, authed (HOME), and not explicitly skipped.
 *  HOME must also already be TRUSTED in ~/.claude.json — on a fresh machine claude
 *  renders the folder-trust prompt instead of the composer, and this test must skip,
 *  not fail. Accept the prompt once (run `claude` in $HOME) to enable the smoke. */
function claudeReady(): boolean {
  if (process.env.PODIUM_SKIP_CLAUDE_SMOKE) return false
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    const home = process.env.HOME ?? homedir()
    if (!home) return false
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
    return cfg.projects?.[home]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

const ready = claudeReady()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A real, heavy, alt-screen agent TUI booting and reacting under our PtyBackend — the
// end-to-end proof that complements the deterministic keyecho/fixture matrix. cwd=HOME
// is a trusted dir so claude renders its composer instead of a trust prompt. We type a
// char but never submit it, so no model call is made.
describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !ready)('real claude smoke (node-pty backend)', () => {
  it('boots, renders a substantial frame, and echoes a keystroke', async () => {
    const s = spawnAgent(
      { cmd: 'claude', args: [], cols: 100, rows: 30, cwd: process.env.HOME ?? homedir() },
      nodePtyBackend(),
    )
    let buf = ''
    s.onFrame((f) => {
      buf += Buffer.from(f.data, 'base64').toString('utf8')
    })
    try {
      for (let i = 0; i < 300 && buf.length < 500; i++) await wait(50)
      expect(buf.length).toBeGreaterThan(500) // a real TUI rendered
      const beforeKey = buf.length
      s.write(Buffer.from('hello', 'utf8').toString('base64')) // typed, not submitted
      for (let i = 0; i < 60 && buf.length <= beforeKey; i++) await wait(50)
      expect(buf.length).toBeGreaterThan(beforeKey) // the keystroke caused a repaint
      expect(buf.replace(ANSI, '')).toContain('hello') // and echoed into the composer
    } finally {
      s.dispose()
    }
  }, 30000)
})
