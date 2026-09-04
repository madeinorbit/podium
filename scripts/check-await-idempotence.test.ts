/**
 * THE REFUSAL SET IS ONLY USEFUL IF IT SAYS WHY.
 *
 * `scripts/awaitify-keep-sync.txt` is what makes the await pass a fixed point: it
 * names the functions the compiler proved cannot become async. POD-3262 derived
 * that set and kept it in a scratch file, so the property could not be checked by
 * anyone, and two reviewers have since re-run the pass without it, seen its
 * refusals as missing work, and filed it as a defect (POD-3294, POD-3369).
 *
 * The whole-program half of the property — "the pass proposes zero edits" — lives
 * in `check-await-idempotence.ts` and takes ~40s because it builds the entire
 * apps/server program. It is a gate run against a still tip, not a unit test.
 *
 * What is here is the half that CAN be a unit test, and it is not the cheap half:
 * a coordinate with no reason is worthless at the flip, where each of these
 * becomes a decision and "why was this skipped" is the question asked at every
 * one. So every entry must carry a category from a closed vocabulary and the
 * compiler error that proved it, and must still point at a real place in a real
 * file. An entry that has quietly become prose, or that names a file nobody has
 * had for weeks, is a stale set pretending to be a derived one.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { categorize, readKeepSync, renderReport } from './awaitify'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP_SYNC = join(ROOT, 'scripts/awaitify-keep-sync.txt')
const REPORT = join(ROOT, 'docs/internal/pod-3221-await-refusals.md')

/** The categories the derivation may write. Anything else is a typo, not a fact. */
const DERIVED_CATEGORIES = new Set([
  'pass-emits-invalid-syntax',
  'promise-reaches-a-member-read',
  'caller-type-cannot-absorb-a-promise',
  'compiler-refused',
])

interface Entry {
  key: string
  file: string
  offset: number
  category: string
  evidence: string
}

function entries(): Entry[] {
  const out: Entry[] = []
  for (const raw of readFileSync(KEEP_SYNC, 'utf8').split('\n')) {
    const hash = raw.indexOf('#')
    const key = (hash === -1 ? raw : raw.slice(0, hash)).trim()
    if (key.length === 0) continue
    const comment = hash === -1 ? '' : raw.slice(hash + 1).trim()
    const [file, offset] = key.split('|')
    const colon = comment.indexOf(':')
    out.push({
      key,
      file: file ?? '',
      offset: Number(offset),
      category: colon === -1 ? '' : comment.slice(0, colon).trim(),
      evidence: colon === -1 ? '' : comment.slice(colon + 1).trim(),
    })
  }
  return out
}

describe('the checked-in refusal set', () => {
  it('is not empty — an empty --keep-sync run looks exactly like a clean one', () => {
    expect(entries().length).toBeGreaterThan(0)
  })

  it('addresses a real place in a file that still exists', () => {
    // A byte offset past the end of its file is the shape a stale entry takes
    // once the tree has moved under it. The whole-program check reports the same
    // condition as an UNUSED entry; this catches the crude version without
    // building a program.
    const bad = entries().filter((e) => {
      const path = join(ROOT, e.file)
      if (!existsSync(path)) return true
      return !Number.isInteger(e.offset) || e.offset < 0 || e.offset >= statSync(path).size
    })
    expect(bad.map((e) => e.key)).toEqual([])
  })

  it('carries a category from the derivation vocabulary on every entry', () => {
    const bad = entries().filter((e) => !DERIVED_CATEGORIES.has(e.category))
    expect(bad.map((e) => `${e.key} -> ${JSON.stringify(e.category)}`)).toEqual([])
  })

  it('carries the compiler error that proved it, not just an assertion that one exists', () => {
    // The evidence is what makes this a derived set rather than someone's list.
    const bad = entries().filter((e) => !/^TS\d+\s+\S/.test(e.evidence))
    expect(bad.map((e) => `${e.key} -> ${JSON.stringify(e.evidence)}`)).toEqual([])
  })

  it('reads back through the consumer with every entry intact', () => {
    // `readKeepSync` is what the pass itself calls. If the annotations ever stop
    // being stripped, the pass silently refuses nothing and reports a fixed point
    // it did not reach.
    const parsed = readKeepSync(KEEP_SYNC)
    expect([...parsed].sort()).toEqual(
      entries()
        .map((e) => e.key)
        .sort(),
    )
  })
})

describe('readKeepSync', () => {
  it('keeps the key and drops everything from the first #', () => {
    const path = join(ROOT, 'scripts/awaitify-keep-sync.txt')
    const parsed = readKeepSync(path)
    for (const key of parsed) {
      expect(key).not.toContain('#')
      expect(key).toMatch(/^[^|]+\|\d+$/)
    }
  })
})

describe('categorize', () => {
  // The four reasons the pass records, verbatim. A refusal whose reason stops
  // matching one of these falls into `would-change-what-the-caller-reads` by
  // default, which is the wrong answer given quietly — so the mapping is pinned
  // at the exact prefixes the pass writes.
  it('names the illegal-await case', () => {
    expect(categorize('no await possible here (parameter default, accessor or constructor)')).toBe(
      'illegal-await-context',
    )
  })

  it('names the flip work list', () => {
    expect(
      categorize(
        'reached from a synchronous-only context; at the flip this call becomes a promise ' +
          'and the assertion around it has to change',
      ),
    ).toBe('assertion-must-change-at-the-flip')
  })

  it('names the compiler-derived refusals — these are the keep-sync entries', () => {
    expect(categorize('a caller reads this synchronously — the compiler said so')).toBe(
      'caller-type-cannot-absorb-a-promise',
    )
  })

  it('names the assertion-changing case', () => {
    expect(
      categorize('argument of expect() — awaiting would turn .toThrow into a rejection assertion'),
    ).toBe('would-change-what-the-caller-reads')
    expect(categorize('argument of .map() — the caller consumes the value synchronously')).toBe(
      'would-change-what-the-caller-reads',
    )
  })
})

describe('the checked-in refusal report', () => {
  const report = (): string => readFileSync(REPORT, 'utf8')

  it('groups by category, because at the flip the KIND of decision comes first', () => {
    const headings = [...report().matchAll(/^## (.+?) \(\d+\)$/gm)].map((m) => m[1])
    expect(headings.length).toBeGreaterThan(0)
    for (const h of headings) {
      expect([
        'illegal-await-context',
        'would-change-what-the-caller-reads',
        'caller-type-cannot-absorb-a-promise',
        'assertion-must-change-at-the-flip',
      ]).toContain(h)
    }
  })

  it('accounts for exactly the entries in the keep-sync set', () => {
    // Every keep-sync hit becomes one refusal reading "a caller reads this
    // synchronously". They are deduped by (file, line, reason), so a mismatch
    // means either the set has gone stale against the report or two entries have
    // collapsed onto one line — both worth looking at rather than tolerating.
    const m = report().match(/^## caller-type-cannot-absorb-a-promise \((\d+)\)$/m)
    expect(m).not.toBeNull()
    expect(Number(m?.[1])).toBe(readKeepSync(KEEP_SYNC).size)
  })

  it('gives every site a reason and a snippet', () => {
    const sites = [...report().matchAll(/^- L\d+ — (.+)$/gm)]
    expect(sites.length).toBeGreaterThan(0)
    for (const s of sites) expect((s[1] ?? '').length).toBeGreaterThan(10)
  })
})

describe('renderReport', () => {
  it('puts a refusal under the category its reason maps to', () => {
    const out = renderReport([
      {
        file: 'a.test.ts',
        line: 7,
        reason: 'no await possible here (parameter default, accessor or constructor)',
        snippet: 'f(store.get())',
      },
    ])
    expect(out).toContain('## illegal-await-context (1)')
    expect(out).toContain('### a.test.ts (1)')
    expect(out).toContain('- L7 — no await possible here')
  })
})
