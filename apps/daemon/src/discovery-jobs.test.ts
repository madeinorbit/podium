import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationDiscoveryCache } from '@podium/agent-bridge'
import { describe, expect, it } from 'vitest'
import { runIndexRefreshJob, runMemoryBreakdownJob } from './discovery-jobs.js'

function fakeProc(
  root: string,
  pid: number,
  ppid: number,
  comm: string,
  cmdline: string,
  rssPages: number,
) {
  const d = join(root, String(pid))
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`)
  writeFileSync(join(d, 'statm'), `1000 ${rssPages} 0 0 0 0 0`)
  writeFileSync(join(d, 'cmdline'), cmdline.replaceAll(' ', '\0'))
}

describe('runMemoryBreakdownJob', () => {
  it('attributes a labelled process subtree to its session', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-'))
    fakeProc(root, 100, 1, 'abduco', 'abduco -n podium-S1 claude', 50)
    fakeProc(root, 101, 100, 'claude', 'claude --foo', 200)
    const out = runMemoryBreakdownJob({
      sessions: [{ sessionId: 'S1', label: 'podium-S1', pid: 100 }],
      roots: [],
      selfPid: 999,
      procRoot: root,
    })
    const agent = out.agents.find((a) => a.sessionId === 'S1')
    expect(agent).toBeTruthy()
    expect(agent!.processCount).toBe(2)
  })
})

describe('runIndexRefreshJob', () => {
  // Scans the real HOME with an in-memory cache; a large conversation history can
  // take longer than vitest's 5s default, so give the real-filesystem pass room.
  it('returns wire-shaped changed conversations', async () => {
    // The job now takes a caller-owned cache (the long-lived worker holds one
    // across ticks instead of opening one per call); the test owns this :memory: one.
    const cache = new ConversationDiscoveryCache(':memory:')
    try {
      const { changed, removed, diagnostics } = await runIndexRefreshJob(
        { homeDir: process.env.HOME },
        cache,
      )
      expect(Array.isArray(changed)).toBe(true)
      expect(Array.isArray(removed)).toBe(true)
      expect(Array.isArray(diagnostics)).toBe(true)
      if (changed[0]) expect(typeof changed[0].id).toBe('string')
    } finally {
      cache.close()
    }
  }, 60_000)
})
