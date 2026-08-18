import { describe, expect, it } from 'vitest'
import {
  entryBadge,
  entryStatus,
  entryTitle,
  entryTone,
  parseCommitFiles,
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

describe('parseCommitFiles', () => {
  it('parses name-status rows, pairing a rename and dropping its score', () => {
    const out = ['M\tsrc/b.ts', 'A\tsrc/a.ts', 'R100\tdocs/old.md\tdocs/new.md', 'D\tgone.ts'].join(
      '\n',
    )
    const entries = parseCommitFiles(`${out}\n`)
    expect(entries.map((e) => e.path)).toEqual(['docs/new.md', 'gone.ts', 'src/a.ts', 'src/b.ts'])
    expect(entries[0]).toMatchObject({ x: 'R', renamedFrom: 'docs/old.md', committed: true })
    expect(entries.every((e) => e.untracked === false)).toBe(true)
  })
  it('unquotes paths and skips blanks and half-rows', () => {
    expect(parseCommitFiles('\nM\n M\t"sp ace.ts"\n')[0]?.path).toBe('sp ace.ts')
    expect(parseCommitFiles('')).toEqual([])
  })
  it('a commit has ONE axis: dim tone, bare letter, no staged vocabulary', () => {
    // Everything in a commit is committed. Reporting "modified (staged)" would
    // name an index that has nothing left to say about a file already in
    // history — and the badge must not borrow the colour that means staged.
    const [entry] = parseCommitFiles('M\tsrc/a.ts\n')
    expect(entryTone(entry!)).toBe('committed')
    expect(entryBadge(entry!)).toBe('M')
    expect(entryStatus(entry!)).toBe('modified')
    expect(entryTitle(entry!)).toBe('modified — src/a.ts')
  })
})

describe('untrackedDiff', () => {
  it('prefixes every line with + under a hunk header, dropping the trailing newline', () => {
    // The header is what lets an untracked file render — and be numbered —
    // through the same parser as a tracked one.
    expect(untrackedDiff('a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(untrackedDiff('')).toBe('')
  })
})

describe('badges, tones and titles', () => {
  it('badges: untracked ??, staged-only trimmed', () => {
    const { entries } = parseStatus('## m\nM  s.ts\n?? u.ts\n M w.ts\n')
    expect(entries.map(entryBadge)).toEqual(['M', 'M', '??'])
  })
  it('tones split the three axes', () => {
    const { entries } = parseStatus('## m\nM  s.ts\n M w.ts\nMM b.ts\n?? u.ts\n')
    expect(entries.map(entryTone)).toEqual(['unstaged', 'staged', 'unstaged', 'untracked'])
  })
  it('titles name both axes; status is the same sentence without the path', () => {
    const { entries } = parseStatus('## m\nMM both.ts\n')
    expect(entryStatus(entries[0]!)).toBe('modified (staged) + modified')
    expect(entryTitle(entries[0]!)).toBe('modified (staged) + modified — both.ts')
    const { entries: untracked } = parseStatus('## m\n?? new.ts\n')
    expect(entryTitle(untracked[0]!)).toBe('untracked — new.ts')
  })
})
