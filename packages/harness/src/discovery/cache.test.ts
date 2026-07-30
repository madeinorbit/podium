import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { ConversationDiscoveryCache } from './cache.js'
import type { AgentConversationSummary } from './types.js'

async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-discovery-cache-'))
  return join(root, 'discovery.db')
}

async function writeSession(root: string, name = 'session.jsonl'): Promise<string> {
  const file = join(root, name)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '{"ok":true}\n')
  await utimes(file, new Date('2026-06-01T10:00:00.000Z'), new Date('2026-06-01T10:00:00.000Z'))
  return file
}

function summary(path: string, id = 'conv-1'): AgentConversationSummary {
  return {
    id,
    agentKind: 'codex',
    title: 'Cached discovery',
    titleSource: 'native',
    projectPath: '/repo/app',
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    updatedAt: new Date('2026-06-01T10:01:00.000Z'),
    resume: { kind: 'codex-thread', value: id },
    source: { providerId: 'codex-jsonl', root: '/root', path },
  }
}

describe('ConversationDiscoveryCache', () => {
  test('returns a cached summary only when mtime and size are unchanged', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const file = await writeSession(root)
    const cache = new ConversationDiscoveryCache(db, { schemaVersion: 7 })
    const firstStat = await stat(file)
    cache.upsert(file, firstStat, summary(file), 'codex')

    expect(cache.getFresh(file, firstStat, 'codex')).toEqual(summary(file))

    await writeFile(file, '{"ok":false}\n')
    await utimes(file, new Date('2026-06-01T10:02:00.000Z'), new Date('2026-06-01T10:02:00.000Z'))
    const changedStat = await stat(file)
    expect(cache.getFresh(file, changedStat, 'codex')).toBeUndefined()
    cache.close()
  })

  test('drops cache rows for files that no longer exist', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const file = await writeSession(root)
    const cache = new ConversationDiscoveryCache(db)
    const fileStat = await stat(file)
    cache.upsert(file, fileStat, summary(file), 'codex')

    await rm(file)
    cache.deleteMissing(new Set())

    expect(cache.listSummaries()).toEqual([])
    cache.close()
  })

  test('only prunes rows whose agent_kind is in the requested scope', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const codexFile = await writeSession(root, 'codex.jsonl')
    const claudeFile = await writeSession(root, 'claude.jsonl')
    const cache = new ConversationDiscoveryCache(db)
    cache.upsert(codexFile, await stat(codexFile), summary(codexFile, 'codex-1'), 'codex')
    cache.upsert(claudeFile, await stat(claudeFile), summary(claudeFile, 'claude-1'), 'claude-code')

    // Scope the prune to codex only, with no codex paths seen. The claude row
    // must survive even though it is also absent from the seen-set.
    const result = cache.deleteMissing(new Set(), ['codex'])
    expect(result.deleted).toBe(1)

    const remaining = cache.listSummaries().map((s) => s.source.path)
    expect(remaining).toEqual([claudeFile])
    cache.close()
  })

  test('still prunes a genuinely vanished file even after a no-op tick', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const file = await writeSession(root)
    const cache = new ConversationDiscoveryCache(db)
    cache.upsert(file, await stat(file), summary(file), 'codex')

    // Steady state: the file is present and seen.
    const firstSeen = new Set([file])
    const tick1 = cache.deleteMissing(firstSeen, ['codex'])
    expect(tick1.deleted).toBe(0)

    // Identical no-op tick: short-circuits, deletes nothing, leaves the row.
    const tick2 = cache.deleteMissing(new Set([file]), ['codex'])
    expect(tick2.skipped).toBe(true)
    expect(tick2.deleted).toBe(0)
    expect(cache.listSummaries()).toHaveLength(1)

    // File vanishes: the seen-set changes, so the prune must run and remove it.
    const tick3 = cache.deleteMissing(new Set(), ['codex'])
    expect(tick3.skipped).toBe(false)
    expect(tick3.deleted).toBe(1)
    expect(cache.listSummaries()).toEqual([])
    cache.close()
  })

  test('short-circuits the no-op steady-state tick without scanning the table', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const file = await writeSession(root)
    const cache = new ConversationDiscoveryCache(db)
    cache.upsert(file, await stat(file), summary(file), 'codex')

    const seen = new Set([file])
    // First tick establishes the prior seen-set / scope baseline.
    const first = cache.deleteMissing(seen, ['codex'])
    expect(first.skipped).toBe(false)

    // Spy on prepare so we can prove the steady-state tick issues no SQL at all
    // (no full-table SELECT, no DELETE) when nothing changed.
    const innerDb = (cache as unknown as { db: { prepare: (sql: string) => unknown } }).db
    const prepareSpy = vi.spyOn(innerDb, 'prepare')

    const second = cache.deleteMissing(new Set([file]), ['codex'])
    expect(second.skipped).toBe(true)
    expect(second.deleted).toBe(0)
    expect(prepareSpy).not.toHaveBeenCalled()

    prepareSpy.mockRestore()
    cache.close()
  })

  test('persists summaries across cache instances', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const file = await writeSession(root)
    const first = new ConversationDiscoveryCache(db)
    const fileStat = await stat(file)
    first.upsert(file, fileStat, summary(file), 'codex')
    first.close()

    const reopened = new ConversationDiscoveryCache(db)
    expect(reopened.getFresh(file, fileStat, 'codex')).toEqual(summary(file))
    reopened.close()
  })

  test('schema version changes make existing rows stale', async () => {
    const db = await tempDb()
    const root = await mkdtemp(join(tmpdir(), 'podium-cache-root-'))
    const file = await writeSession(root)
    const fileStat = await stat(file)
    const v1 = new ConversationDiscoveryCache(db, { schemaVersion: 1 })
    v1.upsert(file, fileStat, summary(file), 'codex')
    v1.close()

    const v2 = new ConversationDiscoveryCache(db, { schemaVersion: 2 })
    expect(v2.getFresh(file, fileStat, 'codex')).toBeUndefined()
    v2.close()
  })
})
