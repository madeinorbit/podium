import type { StatTick } from '@podium/transcript'
import { describe, expect, it, vi } from 'vitest'
import { createSessionObservers } from './session-observers'

class ManualStatTick implements StatTick {
  readonly watchers = new Set<() => void>()

  subscribe(watcher: () => void): () => void {
    this.watchers.add(watcher)
    return () => this.watchers.delete(watcher)
  }
}

describe('session observer stat polling', () => {
  it('shares one daemon tick between a session transcript tail and agent-state observer', () => {
    const statTick = new ManualStatTick()
    const observers = createSessionObservers({
      statTick,
      send: vi.fn(),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })

    observers.bindHeadlessSession('podium-session', 'cursor', '/repo', 'cursor-chat')
    expect(statTick.watchers.size).toBe(2)

    observers.clearSession('podium-session')
    expect(statTick.watchers.size).toBe(0)
  })
})
