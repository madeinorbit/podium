import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { ComposerSyncEngine } from './composer-sync'

// Real-PTY smoke: drive the composer engine end-to-end over an actual PTY (node-pty)
// — bytes → engine.onData → @xterm/headless screen → ComposerDriver.extract →
// native-draft publish. Gated on node-pty being loadable (skips cleanly otherwise).
//
// The real-HARNESS injection/doubling smoke (spawn codex, inject a multiline draft,
// assert zero duplication) needs a codex binary and lives as a CI/reviewer follow-up;
// the doubling logic itself is covered deterministically by the scripted-PTY unit
// test in composer-sync.test.ts.
const nodeRequire = createRequire(import.meta.url)
let pty: typeof import('node-pty') | null = null
try {
  const m = nodeRequire('node-pty') as typeof import('node-pty')
  // Touch the native addon so an unbuilt node-pty skips instead of throwing mid-test.
  m.spawn('true', [], { cols: 10, rows: 2 }).kill()
  pty = m
} catch {
  pty = null
}

describe.skipIf(!pty)('composer-sync real PTY smoke', () => {
  it('scrapes a claude-style composer emitted over a real PTY and publishes it', async () => {
    const nodePty = pty as NonNullable<typeof pty>
    const published: string[] = []
    const engine = new ComposerSyncEngine((_sessionId, text) => published.push(text))
    engine.attach('s1', 'claude-code', 48, 8)

    // A shell that prints a Claude composer box (then idles briefly) — a real PTY
    // renders it through the same emulator path the daemon uses.
    const box = [
      '',
      '╭──────────────╮',
      '│ > hello from a real pty │',
      '╰──────────────╯',
      '  ? for shortcuts',
      '',
    ].join('\r\n')
    const child = nodePty.spawn('bash', ['-c', `printf '%s' "$0"; sleep 0.4`, box], {
      cols: 48,
      rows: 8,
    })
    child.onData((d) => engine.onData('s1', d))
    await new Promise<void>((resolve) => child.onExit(() => resolve()))
    // Let the coalesced scrape (60ms) fire after the last frame.
    await new Promise((r) => setTimeout(r, 200))
    engine.disposeAll()

    expect(published.some((t) => t.includes('hello from a real pty'))).toBe(true)
  }, 15_000)
})
