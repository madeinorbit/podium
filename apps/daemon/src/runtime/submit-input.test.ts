import { agentStateProviderFor } from '@podium/harness'
import { asSessionId } from '@podium/model'
import { createHeadlessScreen } from '@podium/process/screen'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context.js'
import { createSessionObservers } from '../session-observers.js'
import { daemonRuntimeHost } from './host.js'

describe('submit recovery input evidence', () => {
  it('reads the current shared screen through observers and the daemon host, even while busy', async () => {
    const sessionId = asSessionId('submit-recovery')
    const screen = createHeadlessScreen(80, 24)
    const observers = createSessionObservers({
      send() {},
      onTranscriptDirty() {},
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      sharedScreenFor: () => screen,
    })
    const provider = agentStateProviderFor('claude-code')
    if (!provider) throw new Error('Claude provider missing')
    const ctx = { observers } as unknown as DaemonContext
    const host = daemonRuntimeHost(ctx, () => {})
    const paint = (draft: string) => screen.write(Buffer.from(
      `\x1b[2J\x1b[H✽ Thinking…\r\n${'─'.repeat(80)}\r\n❯ ${draft}\r\n${'─'.repeat(80)}\r\n  esc to interrupt`,
    ))
    try {
      observers.initSessionObservers({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/tmp',
        geometry: { cols: 80, rows: 24 }, durableLabel: 'submit-recovery' },
      { onFrame: () => () => {} } as never, provider, { seedOnFrame: false })
      paint('retained text')
      await expect(host.readInput?.(sessionId)).resolves.toBe('retained text')
      paint('')
      await expect(host.readInput?.(sessionId)).resolves.toBe('')
      observers.clearSession(sessionId)
      await expect(host.readInput?.(sessionId)).resolves.toBeUndefined()
    } finally { observers.disposeObservers(); screen.dispose() }
  })
})
