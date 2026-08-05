/**
 * What the composer's @-file menu promises, made executable (POD-412).
 *
 * The scoring weights are only interesting as ORDER, so this asserts order —
 * "typing this puts that file first" — rather than pinning the numbers, which
 * would turn every tuning pass into a test rewrite.
 */

import { describe, expect, it } from 'vitest'
import { PathIndex, parseLsFiles, rankPaths, scorePath } from './path-search'

const PATHS = [
  'apps/web/src/features/chat/ChatComposer.tsx',
  'apps/web/src/features/chat/ChatView.tsx',
  'apps/web/src/features/chat/composer/notes.md',
  'apps/web/src/features/superagent/SuperagentView.tsx',
  'apps/server/src/modules/files/queries.ts',
  'README.md',
]

const top = (query: string, limit = 3): string[] =>
  rankPaths(PATHS, query, limit).map((hit) => hit.path)

describe('scorePath', () => {
  it('refuses a path whose characters are not in the typed order', () => {
    expect(scorePath('apps/web/README.md', 'daer')).toBeNull()
  })

  it('accepts an acronym typed at word starts', () => {
    expect(scorePath('apps/chat/surface.ts', 'acs')).not.toBeNull()
    expect(scorePath('apps/web/src/lib/at-mention/useAtMention.ts', 'atmention')).not.toBeNull()
  })

  it('refuses a scattered match that only LOOKS like a subsequence', () => {
    // One letter here and one there inside a long name is how an unrestricted
    // matcher fills the menu with noise for a query nothing really answers.
    expect(scorePath('docs/plans/2026-06-12-agent-state-instrumentation.md', 'atmention')).toBeNull()
  })


  it('prefers the basename over the same characters in a directory', () => {
    const inName = scorePath('apps/web/src/features/chat/composer/notes.md', 'notes') as number
    const inDir = scorePath('apps/web/src/features/notes/index.ts', 'notes') as number
    expect(inName).toBeGreaterThan(inDir)
  })
})

describe('rankPaths', () => {
  it('puts the file you named first', () => {
    expect(top('chatcomposer')[0]).toBe('apps/web/src/features/chat/ChatComposer.tsx')
    expect(top('superagentview')[0]).toBe('apps/web/src/features/superagent/SuperagentView.tsx')
  })

  it('is case-insensitive in both directions', () => {
    expect(top('CHATVIEW')[0]).toBe('apps/web/src/features/chat/ChatView.tsx')
    expect(top('readme')[0]).toBe('README.md')
  })

  it('matches on the directory part too, so a path prefix narrows', () => {
    expect(top('modules/files', 5)).toContain('apps/server/src/modules/files/queries.ts')
  })

  it('caps the result count — the wire carries the menu, not the tree', () => {
    expect(rankPaths(PATHS, 'a', 2)).toHaveLength(2)
  })

  it('opens on the shallowest paths rather than index order', () => {
    expect(top('', 2)[0]).toBe('README.md')
  })

  it('answers nothing when nothing matches', () => {
    expect(top('zzzz')).toEqual([])
  })
})

describe('parseLsFiles', () => {
  it('splits on NUL and drops the trailing empty record', () => {
    expect(parseLsFiles('a.ts\0b/c.ts\0')).toEqual(['a.ts', 'b/c.ts'])
  })

  it('keeps a path containing a newline in one piece — the reason for -z', () => {
    expect(parseLsFiles('od\nd.ts\0b.ts\0')).toEqual(['od\nd.ts', 'b.ts'])
  })
})

describe('PathIndex', () => {
  it('reads the checkout once for a burst of typing, then again after the TTL', async () => {
    let now = 1_000
    let calls = 0
    const index = new PathIndex(30_000, 5_000, () => now)
    const load = async () => {
      calls++
      return { ok: true, output: 'a.ts\0' }
    }
    const key = { root: '/w' }

    expect(await index.paths(key, load)).toEqual(['a.ts'])
    await index.paths(key, load)
    expect(calls).toBe(1)

    now += 30_001
    await index.paths(key, load)
    expect(calls).toBe(2)
  })

  it('separates the same absolute path on two machines', async () => {
    let calls = 0
    const index = new PathIndex()
    const load = async () => {
      calls++
      return { ok: true, output: 'a.ts\0' }
    }
    await index.paths({ machineId: 'm1', root: '/w' }, load)
    await index.paths({ machineId: 'm2', root: '/w' }, load)
    expect(calls).toBe(2)
  })

  it('caches a failure too, so a doomed checkout is not re-forked per keystroke', async () => {
    let now = 1_000
    let calls = 0
    const index = new PathIndex(30_000, 5_000, () => now)
    const load = async () => {
      calls++
      return { ok: false, output: 'not a git repository' }
    }
    const key = { root: '/w' }

    expect(await index.paths(key, load)).toEqual([])
    await index.paths(key, load)
    expect(calls).toBe(1)

    // …but it retries far sooner than a success, so a machine that comes back
    // online is not stale for the whole success window.
    now += 5_001
    await index.paths(key, load)
    expect(calls).toBe(2)
  })
})
