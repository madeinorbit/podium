import { describe, expect, it } from 'vitest'
import {
  diffRowAccessibilityLabel,
  entryBadge,
  entryStatus,
  GIT_DIFF_PARSE_CAP,
  parseDiff,
  parseStatus,
  untrackedDiff,
} from './git-review'

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
    expect(
      parsed.entries.map((entry) => [entryBadge(entry), entryStatus(entry), entry.path]),
    ).toEqual([
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

  it('opens the destination path for a worktree-only rename', () => {
    const parsed = parseStatus('## main\n R old-name.ts -> new-name.ts')
    expect(parsed.entries).toEqual([
      {
        x: ' ',
        y: 'R',
        path: 'new-name.ts',
        renamedFrom: 'old-name.ts',
        untracked: false,
      },
    ])
  })

  it('retains a bounded window for a deterministic generated diff', () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `+generated ${index}`)
    const diff = parseDiff(['@@ -0,0 +1,10000 @@', ...lines].join('\n'))
    expect(diff.rows).toHaveLength(GIT_DIFF_PARSE_CAP)
    expect(diff.added).toBe(10_000)
    expect(diff.truncated).toBe(10_001 - GIT_DIFF_PARSE_CAP)
  })

  it('names change meaning for VoiceOver without relying on diff color', () => {
    expect(diffRowAccessibilityLabel({ kind: 'add', text: 'const ready = true' })).toBe(
      'Added line: const ready = true',
    )
    expect(diffRowAccessibilityLabel({ kind: 'del', text: '' })).toBe('Deleted line: blank line')
  })
})
