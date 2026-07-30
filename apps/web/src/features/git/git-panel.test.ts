import { describe, expect, it } from 'vitest'
import {
  diffLineKind,
  entryBadge,
  entryTitle,
  parseLog,
  parseStatus,
  untrackedDiff,
} from './git-panel'

describe('parseStatus', () => {
  it('parses the branch header with upstream and counters', () => {
    const { header } = parseStatus('## main...origin/main [ahead 2, behind 1]\n')
    expect(header).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
  })
  it('parses a plain local branch and detached HEAD', () => {
    expect(parseStatus('## issue/1-x\n').header).toEqual({
      branch: 'issue/1-x',
      upstream: null,
      ahead: 0,
      behind: 0,
    })
    expect(parseStatus('## HEAD (no branch)\n').header.branch).toBe('HEAD (detached)')
    expect(parseStatus('## No commits yet on main\n').header.branch).toBe('main')
  })
  it('parses entries: staged, unstaged, untracked, renames — untracked sort last', () => {
    const out = [
      '## main',
      '?? z-untracked.ts',
      ' M b/unstaged.ts',
      'M  a/staged.ts',
      'MM c/both.ts',
      'R  old.ts -> new.ts',
    ].join('\n')
    const { entries } = parseStatus(out)
    expect(entries.map((e) => e.path)).toEqual([
      'a/staged.ts',
      'b/unstaged.ts',
      'c/both.ts',
      'new.ts',
      'z-untracked.ts',
    ])
    expect(entries[3]).toMatchObject({ x: 'R', renamedFrom: 'old.ts' })
    expect(entries[4]).toMatchObject({ untracked: true })
  })
  it('unquotes C-quoted paths', () => {
    const { entries } = parseStatus('## main\n?? "sp ace\\t\\"q\\".ts"\n')
    expect(entries[0]?.path).toBe('sp ace\t"q".ts')
  })
})

describe('parseLog', () => {
  it('parses tab-separated rows, subject keeps embedded tabs', () => {
    const row = 'abc1234\tabc1234ffff\t2026-07-21T10:00:00+02:00\tAda\tfix: a\tweird subject'
    expect(parseLog(`${row}\n`)).toEqual([
      {
        shortSha: 'abc1234',
        sha: 'abc1234ffff',
        date: '2026-07-21T10:00:00+02:00',
        author: 'Ada',
        subject: 'fix: a\tweird subject',
      },
    ])
  })
  it('skips malformed lines and blanks', () => {
    expect(parseLog('\nnot a log line\n')).toEqual([])
  })
})

describe('diffLineKind', () => {
  it('classifies unified diff lines', () => {
    expect(diffLineKind('+added')).toBe('add')
    expect(diffLineKind('-removed')).toBe('del')
    expect(diffLineKind('+++ b/a.ts')).toBe('meta')
    expect(diffLineKind('--- a/a.ts')).toBe('meta')
    expect(diffLineKind('@@ -1,2 +1,3 @@')).toBe('hunk')
    expect(diffLineKind('diff --git a/a b/a')).toBe('meta')
    expect(diffLineKind('index 000..111 100644')).toBe('meta')
    expect(diffLineKind(' context')).toBe('ctx')
    expect(diffLineKind('\\ No newline at end of file')).toBe('meta')
  })
})

describe('untrackedDiff', () => {
  it('prefixes every line with + and drops the trailing newline', () => {
    expect(untrackedDiff('a\nb\n')).toBe('+a\n+b')
    expect(untrackedDiff('')).toBe('')
  })
})

describe('badges and titles', () => {
  it('badges: untracked ??, staged-only trimmed', () => {
    const { entries } = parseStatus('## m\nM  s.ts\n?? u.ts\n M w.ts\n')
    expect(entries.map(entryBadge)).toEqual(['M', 'M', '??'])
  })
  it('titles name both axes', () => {
    const { entries } = parseStatus('## m\nMM both.ts\n')
    expect(entryTitle(entries[0]!)).toBe('modified (staged) + modified — both.ts')
  })
})
