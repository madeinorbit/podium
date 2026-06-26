import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// Build a tmp HOME containing a few real Claude Code conversation files so the
// real default providers (not a fake provider) discover them, matching the way
// runIndexRefreshJob actually scans.
function writeClaudeSession(home: string, relativePath: string, id: string, title: string): void {
  const file = join(home, relativePath)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: title, sessionId: id }),
      JSON.stringify({
        type: 'user',
        uuid: `${id}-user-1`,
        timestamp: '2026-06-01T11:00:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'user', content: 'scan conversations' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: `${id}-assistant-1`,
        timestamp: '2026-06-01T11:01:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'text', text: 'found conversations' }] },
      }),
    ].join('\n'),
  )
}

describe('runIndexRefreshJob', () => {
  // Regression guard for the cold-server-index bug: with a WARM discovery cache the
  // delta scan reports `changed: []` (nothing moved on disk), which would write
  // nothing and leave a fresh/reset server index permanently empty. `full: true`
  // must instead return the ENTIRE current conversation list so a snapshot can
  // repopulate the cold index.
  it('with full:true returns ALL conversations off a warm cache (not just the delta)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-full-snapshot-'))
    // The Claude provider's default root is <home>/.claude, so place the session
    // files under .claude/projects/... for the real provider to discover them.
    writeClaudeSession(
      home,
      '.claude/projects/-repo-project/conv-a.jsonl',
      'conv-a',
      'Conversation A',
    )
    writeClaudeSession(
      home,
      '.claude/projects/-repo-project/conv-b.jsonl',
      'conv-b',
      'Conversation B',
    )
    const cache = new ConversationDiscoveryCache(':memory:')
    try {
      // First scan WARMS the cache and records the full list as the delta.
      const first = await runIndexRefreshJob({ homeDir: home }, cache)
      const fullCount = first.changed.length
      expect(fullCount).toBeGreaterThanOrEqual(2)

      // Second delta scan off the now-warm cache: nothing changed on disk, so the
      // delta is empty — this is exactly the situation that starved a cold index.
      const delta = await runIndexRefreshJob({ homeDir: home }, cache)
      expect(delta.changed.length).toBe(0)

      // Second FULL scan off the SAME warm cache must return the entire list again,
      // proving the snapshot path can repopulate a cold server index.
      const snapshot = await runIndexRefreshJob({ homeDir: home, full: true }, cache)
      expect(snapshot.changed.length).toBe(fullCount)
      const ids = snapshot.changed.map((c) => c.id)
      expect(ids).toContain('conv-a')
      expect(ids).toContain('conv-b')
    } finally {
      cache.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)

  // Task 11: a targeted refresh via `paths` re-summarizes ONLY the named file(s) and
  // returns just those in `changed`, never pruning (`removed: []`). This is what the
  // daemon's event-driven active refresh fires when a LOADED session's transcript
  // tail moves — it must not depend on the slower periodic full scan.
  it('with paths returns ONLY the named file as changed and never prunes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-paths-refresh-'))
    const relA = '.claude/projects/-repo-project/conv-a.jsonl'
    const relB = '.claude/projects/-repo-project/conv-b.jsonl'
    const pathA = join(home, relA)
    const pathB = join(home, relB)
    writeClaudeSession(home, relA, 'conv-a', 'Conv A')
    writeClaudeSession(home, relB, 'conv-b', 'Conv B')
    const cache = new ConversationDiscoveryCache(':memory:')
    try {
      // Warm the cache so a plain delta scan would report nothing changed.
      await runIndexRefreshJob({ homeDir: home }, cache)

      // Append to BOTH transcripts (mtime/size move → both warm rows miss). A plain
      // delta scan would report BOTH as changed; the paths-filter below must scope the
      // result to ONLY conv-a, which is what isolates the `paths` honoring.
      writeClaudeSession(home, relA, 'conv-a', 'Conv A renamed')
      writeClaudeSession(home, relB, 'conv-b', 'Conv B renamed')

      // Targeted refresh of ONLY conv-a by its exact transcript path. conv-b is filtered
      // out of the listing entirely and never re-summarized, even though it is dirty.
      const refreshed = await runIndexRefreshJob({ homeDir: home, paths: [pathA] }, cache)

      const ids = refreshed.changed.map((c) => c.id)
      expect(ids).toContain('conv-a')
      expect(ids).not.toContain('conv-b')
      // A targeted refresh never prunes, even though conv-b is "missing" from paths.
      expect(refreshed.removed).toEqual([])
      // conv-b's warm row is left STALE by the targeted refresh — it was never visited,
      // proving the paths filter scoped the work (a full scan would have refreshed it).
      expect(cache.getFresh(pathB, statSync(pathB), 'claude-code')).toBeUndefined()
    } finally {
      cache.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})
