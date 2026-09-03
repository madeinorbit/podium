/**
 * THE CENSUS GATE, RUN WHERE CI WILL SEE IT — POD-3360.
 *
 * `docs/internal/pod-3244-store-coverage-census.md` is the inventory Stage A of
 * the POD-3221 conversion is planned from, and it was hand-maintained: seven
 * members added after it was measured had no row, so a brief generated from it
 * would have skipped them silently. The fix is not the seven rows — it is that
 * the inventory is derived and the derivation is checked, here, in the lane CI
 * already runs.
 *
 * The probe cases below are what the repo check cannot express on its own: they
 * put the defect back (a member with no row) and assert the gate reports it,
 * rather than trusting a green run over a document nobody has changed.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  blockingDrift,
  censusDrift,
  enumerateMembers,
  memberKey,
  membersOfSource,
  parseCommittedRows,
} from './store-coverage-census'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const censusMarkdown = () =>
  readFileSync(join(repoRoot, 'docs/internal/pod-3244-store-coverage-census.md'), 'utf8')

describe('the committed census describes the tree', () => {
  it('has a row for every public repository member, and none for a member that is gone', () => {
    const drift = censusDrift(censusMarkdown())
    expect(drift.added.map((m) => `${m.file} ${m.className}.${m.member}`)).toEqual([])
    expect(drift.removed.map((r) => `${r.file} ${r.className}.${r.member}`)).toEqual([])
    expect(drift.newFiles).toEqual([])
    expect(drift.goneFiles).toEqual([])
  })

  it('names no test that has stopped naming the member', () => {
    // The asymmetric half: gaining a naming test only makes the census
    // pessimistic, but LOSING the last one makes it claim visible evidence a
    // reviewer will not find.
    expect(
      censusDrift(censusMarkdown()).namingLost.map((r) => `${r.className}.${r.member}`),
    ).toEqual([])
  })

  it('records a measured verdict for every member', () => {
    const rows = parseCommittedRows(censusMarkdown())
    const derived = new Set(enumerateMembers().map(memberKey))
    expect(rows.length).toBe(derived.size)
    for (const row of rows)
      expect(derived.has(memberKey(row)), `${row.className}.${row.member}`).toBe(true)
  })
})

describe('the gate reports the drift POD-3360 found, when it is put back', () => {
  it('names a member whose row was never written', () => {
    const withoutRow = censusMarkdown()
      .split('\n')
      .filter((line) => !line.includes('| `existingMessageIds` |'))
      .join('\n')
    const drift = censusDrift(withoutRow)
    expect(drift.added.map((m) => `${m.className}.${m.member}`)).toEqual([
      'MessagesRepository.existingMessageIds',
    ])
    expect(blockingDrift(drift)).toBeGreaterThan(0)
  })

  it('names a row whose member is gone', () => {
    const withGhost = censusMarkdown().replace(
      '<!-- /census:full-table -->',
      '| `apps/server/src/store/messages.ts` | MessagesRepository | `methodThatWasDeleted` | 1 | yes | server:store | — |\n<!-- /census:full-table -->',
    )
    const drift = censusDrift(withGhost)
    expect(drift.removed.map((r) => `${r.className}.${r.member}`)).toEqual([
      'MessagesRepository.methodThatWasDeleted',
    ])
    expect(blockingDrift(drift)).toBeGreaterThan(0)
  })

  it('does not block on a line number that moved', () => {
    const shifted = censusMarkdown().replace(
      /^(\| `apps\/server\/src\/store\/table-writes\.ts` \| TableWrites \| `subscribe` \| )\d+/m,
      '$19999',
    )
    const drift = censusDrift(shifted)
    expect(drift.moved.some((m) => m.member.member === 'subscribe')).toBe(true)
    expect(blockingDrift(drift)).toBe(0)
  })
})

describe('the enumeration follows the rules the census states', () => {
  const source = `
    export class Repo {
      constructor(readonly db: unknown) {}
      private hidden(): void {}
      protected alsoHidden(): void {}
      #reallyHidden(): void {}
      readonly notAFunction = 41
      method(): void {}
      get accessor(): number { return 1 }
      set accessor(value: number) {}
      arrow = (): void => {}
    }
    class NotExported {
      method(): void {}
    }
  `

  it('takes methods, accessors and arrow properties, and nothing else', () => {
    expect(membersOfSource('fixture.ts', source).map((m) => m.member)).toEqual([
      'method',
      'accessor',
      'accessor',
      'arrow',
    ])
  })

  it('ignores a class the module does not export', () => {
    expect(membersOfSource('fixture.ts', source).every((m) => m.className === 'Repo')).toBe(true)
  })
})
