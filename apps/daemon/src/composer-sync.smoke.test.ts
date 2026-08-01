import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
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
const PTY_EVENT_DEADLINE_MS = 60_000
let pty: typeof import('node-pty') | null = null
try {
  const m = nodeRequire('node-pty') as typeof import('node-pty')
  // Requiring node-pty loads the native addon; a throw here skips cleanly. Do not
  // spawn a second probe process: every real PTY child must be reaped by its PID.
  pty = m
} catch {
  pty = null
}

describe.skipIf(!pty)('composer-sync real PTY smoke', () => {
  it('scrapes a claude-style composer emitted over a real PTY and publishes it', async () => {
    const nodePty = pty as NonNullable<typeof pty>
    const published: string[] = []
    let resolveFirstPublish: (text: string) => void = () => {}
    const firstPublish = new Promise<string>((resolve) => {
      resolveFirstPublish = resolve
    })
    const engine = new ComposerSyncEngine((_sessionId, text) => {
      published.push(text)
      resolveFirstPublish(text)
    })
    engine.attach(asSessionId('s1'), 'claude-code', 48, 8)

    // A collaborator relays a Claude composer box through a real PTY, rendering it
    // through the same emulator path the daemon uses.
    const box = [
      '',
      '╭──────────────╮',
      '│ > hello from a real pty │',
      '╰──────────────╯',
      '  ? for shortcuts',
      '',
    ].join('\r\n')
    const fixtureDir = mkdtempSync(join(tmpdir(), 'podium-composer-pty-'))
    const fifoPath = join(fixtureDir, 'box.fifo')
    execFileSync('mkfifo', [fifoPath])
    // `cat` blocks opening the FIFO until the parent writes after registering onData.
    const child = nodePty.spawn('cat', [fifoPath], { cols: 48, rows: 8 })
    const childPid = child.pid
    let output = ''
    let resolveOutput: () => void = () => {}
    const outputReady = new Promise<void>((resolve) => {
      resolveOutput = resolve
    })
    child.onData((d) => {
      output += d
      engine.onData(asSessionId('s1'), d)
      if (output.includes('? for shortcuts')) resolveOutput()
    })
    let didExit = false
    const exited = new Promise<void>((resolve) =>
      child.onExit(() => {
        didExit = true
        resolve()
      }),
    )
    let deadline: ReturnType<typeof setTimeout> | undefined
    const failedDeadline = new Promise<never>((_resolve, reject) => {
      // The deadline only rejects a wedged PTY. Successful completion is driven
      // exclusively by the output and publication events above; keep enough headroom
      // for this process-backed test to run alongside the rest of the integration lane.
      deadline = setTimeout(
        () => reject(new Error('real PTY did not publish composer')),
        PTY_EVENT_DEADLINE_MS,
      )
    })
    try {
      // FIFO rendezvous closes forkpty's unobservable spawn-to-listener gap without
      // sleeping: no payload byte exists until both data and exit listeners are live.
      writeFileSync(fifoPath, box)
      // Bun/node-pty may deliver onExit before queued onData. The data signal, not
      // callback order, establishes that the PTY frame was consumed.
      await Promise.race([outputReady, failedDeadline])
      const first = await Promise.race([firstPublish, failedDeadline])
      expect(first).toContain('hello from a real pty')
      expect(published).toContain(first)
    } finally {
      if (deadline) clearTimeout(deadline)
      if (!didExit) {
        try {
          process.kill(childPid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      await exited
      engine.disposeAll()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 75_000)
})
