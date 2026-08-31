import { describe, expect, it } from 'vitest'
import { entryBadge, entryStatus, parseDiff, parseStatus, untrackedDiff } from './git-review'

describe('mobile Git review model', () => {
  it('parses the branch and changed files from the read-only status contract', () => {
    const parsed = parseStatus(
      '## issue/1835...origin/main [ahead 2, behind 1]\nM  src/a.ts\n M src/b.ts\n?? notes.md',
    )
    expect(parsed.header).toEqual({
      branch: 'issue/1835',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    })
    expect(parsed.entries.map((entry) => [entryBadge(entry), entryStatus(entry), entry.path])).toEqual([
      ['M', 'modified (staged)', 'src/a.ts'],
      ['M', 'modified', 'src/b.ts'],
      ['??', 'untracked', 'notes.md'],
    ])
  })

  it('drops Git preamble, counts changes, and states the mobile render cap', () => {
    const diff = parseDiff(
      ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join(
        '\n',
      ),
      2,
    )
    expect(diff.rows.map((row) => row.kind)).toEqual(['hunk', 'del'])
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.truncated).toBe(1)
  })

  it('turns a new text file into an all-added diff', () => {
    expect(untrackedDiff('one\ntwo\n')).toBe('@@ -0,0 +1,2 @@\n+one\n+two')
  })
})
