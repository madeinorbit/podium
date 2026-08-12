/**
 * THE SIXTY-EIGHT ISSUE CONTRACTS, CHECKED AGAINST THE THINGS THAT DECIDE.
 *
 * Not against a restatement of them. Three of this run's issues shipped suites that
 * could not say NO, so every claim below is paired with an instrument that is
 * observed refusing something before its silence is read as agreement.
 */

import { OWNERSHIP_MATRIX, visibilityClassOf } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AnyCommandContract, ContractConflictClass } from '../contract'
import { classificationErrors, registryClassificationErrors } from '../contract'
import { PER_USER_VISIBILITY, SERVED_EVERYWHERE, SERVED_ON_WIRE } from './cells'
import type { IssueContractName } from './contracts'
import {
  eventsInput,
  ISSUE_COMMAND_NAMES,
  ISSUE_CONTRACT_LIST,
  ISSUE_CONTRACTS,
} from './contracts'

/** The ADR 1 rows an issue command can write. Named literals, so a row that is
 *  renamed or removed from the matrix fails the guard below rather than silently
 *  resolving to `personal` through `visibilityClassOf`'s default-closed arm. */
const ISSUE_ROWS = [
  'issue-core',
  'issue-document-fields',
  'needs-human-group',
  'issue-graph',
  'issue-comments',
  'issue-messages',
  'artifacts',
] as const

const PER_USER_ROW = 'issue-message-read-at'

const rowExists = (row: string): boolean => OWNERSHIP_MATRIX.some((r) => (r.id as string) === row)

describe('the issue contract table', () => {
  it('is populated, is keyed by its own names, and every name is dotted `issues.*`', () => {
    expect(ISSUE_CONTRACT_LIST).toHaveLength(71)
    expect(ISSUE_COMMAND_NAMES).toHaveLength(71)
    expect([...ISSUE_COMMAND_NAMES]).toEqual([...ISSUE_COMMAND_NAMES].sort())
    for (const key of ISSUE_COMMAND_NAMES) {
      expect(ISSUE_CONTRACTS[key].name, key).toBe(`issues.${key}`)
      expect(ISSUE_CONTRACTS[key].version, key).toBe(1)
    }
  })

  it('passes the classification lint — and the lint is capable of failing', () => {
    expect(registryClassificationErrors(ISSUE_CONTRACT_LIST)).toEqual([])
    // NON-VACUITY: the same function, on a contract with three planted defects.
    const broken = {
      ...ISSUE_CONTRACTS.close,
      name: 'nodot',
      version: 0,
      redaction: { ...ISSUE_CONTRACTS.close.redaction, note: '  ' },
    }
    const errs = classificationErrors(broken)
    expect(errs.join('\n')).toContain('dotted wire name')
    expect(errs.join('\n')).toContain('positive integer')
    expect(errs.join('\n')).toContain('redaction.note')
    // And a duplicate name is caught at the TABLE level, not the contract level.
    expect(
      registryClassificationErrors([ISSUE_CONTRACTS.close, ISSUE_CONTRACTS.close]).join('\n'),
    ).toContain('duplicate contract name')
  })
})

/**
 * VISIBILITY IS MEASURED OFF ADR 1, NOT CHOSEN HERE.
 *
 * `visibilityClassOf` is TOTAL and default-closed: an id that is not on the matrix
 * at all resolves to `personal`. That makes it useless as an oracle unless the row
 * is separately proven to EXIST — otherwise "every issue command is personal" would
 * pass just as well against a matrix with no issue rows on it. So existence is
 * asserted first, and the default arm is exercised so its behaviour is visible.
 */
describe('contract visibility against the ownership matrix', () => {
  it('every row an issue command writes is really on the matrix', () => {
    for (const row of ISSUE_ROWS) expect(rowExists(row), row).toBe(true)
    expect(rowExists(PER_USER_ROW), PER_USER_ROW).toBe(true)
    expect(rowExists('issue-does-not-exist')).toBe(false)
  })

  it('the sixty-four non-per-user contracts match their rows exactly', () => {
    for (const row of ISSUE_ROWS) expect([row, visibilityClassOf(row)]).toEqual([row, 'personal'])
    const perUser = ['markRead', 'markUnread', 'setTucked', 'mailInbox'] as const
    for (const key of ISSUE_COMMAND_NAMES) {
      const expected = (perUser as readonly string[]).includes(key) ? 'per-user-state' : 'personal'
      expect([key, ISSUE_CONTRACTS[key].visibility]).toEqual([key, expected])
    }
  })

  /**
   * The four that are `per-user-state` are so because ADR 1 says the row they write
   * is. If POD-1071 ever reclassifies `issue-message-read-at`, this goes red rather
   * than leaving four contracts quietly disagreeing with the row they mirror.
   */
  it('the per-user four mirror `issue-message-read-at`, not a local opinion', () => {
    expect(visibilityClassOf(PER_USER_ROW)).toBe(PER_USER_VISIBILITY)
    expect(PER_USER_VISIBILITY).toBe('per-user-state')
    // The default-closed arm, exercised so the assertion above is known not to be
    // resting on it: an unknown row would have answered `personal` and passed the
    // sixty-four but NOT this one.
    expect(visibilityClassOf('issue-message-read-at-typo')).toBe('personal')
  })
})

/**
 * EXPOSURE IS DEFAULT-CLOSED AND MATCHES WHAT SHIPS. The declaration↔reality check
 * against the CLI table's actual reach lives in `scripts/audit-issue-commands.ts`,
 * which can read that table; here the shape and the partition are pinned.
 */
describe('transport exposure', () => {
  const NOT_ON_CLI_OR_MCP = [
    'applySuggestion',
    'closeEligibleEpics',
    'dismissSuggestion',
    'linearSearch',
    'markRead',
    'markUnread',
    'refreshAssistant',
    'setTucked',
    'subscriptionSetEnabled',
  ]

  it('tRPC and relay serve all seventy-one; CLI and MCP serve sixty-two', () => {
    const onCli = ISSUE_COMMAND_NAMES.filter((n) => ISSUE_CONTRACTS[n].exposure.includes('cli'))
    const onMcp = ISSUE_COMMAND_NAMES.filter((n) => ISSUE_CONTRACTS[n].exposure.includes('mcp'))
    expect(onCli).toHaveLength(62)
    // CLI and MCP are the SAME table (issue-mcp.ts derives its tools from
    // ISSUE_COMMANDS), so they must be the same set — not merely the same size.
    expect(onCli).toEqual(onMcp)
    for (const key of ISSUE_COMMAND_NAMES) {
      expect(ISSUE_CONTRACTS[key].exposure, key).toContain('trpc')
      expect(ISSUE_CONTRACTS[key].exposure, key).toContain('relay')
    }
    expect(ISSUE_COMMAND_NAMES.filter((n) => !onCli.includes(n)).sort()).toEqual(NOT_ON_CLI_OR_MCP)
  })

  it('nothing is exposed on `outbox`, and the two exposure cells are distinct', () => {
    // ADR 3 D3: a transport is served because a contract NAMES it. The write class
    // is offline-eligible, which PERMITS the outbox tag; permission is not wiring,
    // and no client outbox path exists for issues.
    for (const key of ISSUE_COMMAND_NAMES) {
      expect(ISSUE_CONTRACTS[key].exposure, key).not.toContain('outbox')
      expect(ISSUE_CONTRACTS[key].exposure, key).not.toContain('peer')
    }
    expect(SERVED_EVERYWHERE).not.toEqual(SERVED_ON_WIRE)
  })
})

/**
 * REDACTION IS REVIEWED-AND-EMPTY, and that claim is checked rather than asserted.
 * "Nothing on this surface is a credential" is a statement about seventy input
 * schemas, so the schemas are walked for credential-shaped key names — and the
 * walker is shown finding one in a planted schema first, because a key scan that
 * silently matches nothing would pass over any input at all.
 */
describe('redaction', () => {
  const CREDENTIAL_ISH = /token|secret|password|passwd|apikey|api_key|credential|privatekey/i

  const keysOf = (schema: unknown): string[] => {
    // biome-ignore lint/suspicious/noExplicitAny: reading zod internals is the point
    const s = schema as any
    const shape = s?._def?.shape?.() ?? s?._def?.innerType?._def?.shape?.()
    return shape ? Object.keys(shape) : []
  }

  it('no issue command input carries a credential-shaped field', () => {
    let inspected = 0
    for (const key of ISSUE_COMMAND_NAMES) {
      for (const field of keysOf(ISSUE_CONTRACTS[key].input)) {
        inspected += 1
        expect(CREDENTIAL_ISH.test(field), `${key}.${field}`).toBe(false)
      }
    }
    // The scan looked at real fields, not at nothing.
    expect(inspected).toBeGreaterThan(100)
    // And it can say YES: the same predicate on the names it exists to catch.
    for (const planted of ['apiToken', 'password', 'linearApiKey', 'privateKey']) {
      expect(CREDENTIAL_ISH.test(planted), planted).toBe(true)
    }
  })

  it('every contract records that redaction was reviewed, with a reason', () => {
    for (const key of ISSUE_COMMAND_NAMES) {
      expect(ISSUE_CONTRACTS[key].redaction.reviewed, key).toBe(true)
      expect(ISSUE_CONTRACTS[key].redaction.note.trim().length, key).toBeGreaterThan(0)
    }
  })

  it('every exp-rev command carries `expectedRevision`, and no other command does', () => {
    // THE SCHEMA AND THE CLASS ARE ONE DECISION [ADR 3 D13.1]. Main asserted the
    // same agreement in its registry test, and the failure it exists to catch is
    // a contract that declares expected-revision concurrency while omitting the
    // field a caller would have to send — a precondition nobody can supply, which
    // degrades to last-write-wins with the declaration still reading as enforced.
    let expRev = 0
    for (const key of ISSUE_COMMAND_NAMES) {
      // Widened to the erased contract type on purpose: the table's members are
      // `as const`, so a READ contract's literal type has no `conflict` key at
      // all and a direct property read is a compile error rather than the
      // `undefined` this check is about.
      const contract: AnyCommandContract = ISSUE_CONTRACTS[key]
      const carries = keysOf(contract.input).includes('expectedRevision')
      const declares = contract.conflict === 'exp-rev'
      expect(carries, `${key}: input/conflict disagree`).toBe(declares)
      if (declares) expRev += 1
    }
    // Non-vacuity: the loop met the 23 rows §2e extracted from main, not zero.
    expect(expRev).toBe(24)
  })

  it('every `cmd` command states its rule, because the engine refuses one without', () => {
    // `packages/sync/src/authority/arbitration.ts` REQUIRES a rule for cmd rows and
    // throws rather than waving one through. The compile-time half is
    // `ConflictDeclaration`; this is the runtime half, and it counts the rows so a
    // vocabulary change that empties the class cannot pass as agreement.
    let cmd = 0
    for (const key of ISSUE_COMMAND_NAMES) {
      const contract: AnyCommandContract = ISSUE_CONTRACTS[key]
      if (contract.conflict !== 'cmd') continue
      cmd += 1
      expect(contract.conflictRule?.trim().length ?? 0, key).toBeGreaterThan(0)
    }
    expect(cmd).toBe(17)
  })

  it('every command declares a class, mutations a real one and reads `n/a`', () => {
    // REWRITTEN BY POD-1250, which made `conflict` required on
    // `CommandContractBase`. What this used to assert was that the 25 non-mutating
    // members declare NOTHING — an absence that is no longer expressible, and whose
    // inexpressibility is the entire point of that change: an absent field cannot
    // distinguish "has no ADR 1 row" from "nobody classified it".
    //
    // The subtraction it was measuring is unchanged and still measured: 45
    // mutations, 25 non-mutating members (24 reads + `linearSearch`, which is
    // write-grade authority over an EXTERNAL system with no ADR 1 row). Only the
    // spelling of the second group moved, from absence to a written `'n/a'`.
    const classOf = (k: IssueContractName): ContractConflictClass | undefined =>
      (ISSUE_CONTRACTS[k] as AnyCommandContract).conflict

    // FIRST, the property the required field buys: nobody is silent.
    const undeclared = ISSUE_COMMAND_NAMES.filter((k) => classOf(k) === undefined)
    expect(undeclared).toEqual([])

    const mutations = ISSUE_COMMAND_NAMES.filter((k) => classOf(k) !== 'n/a')
    const nonMutating = ISSUE_COMMAND_NAMES.filter((k) => classOf(k) === 'n/a')
    expect(mutations.length).toBe(46)
    expect(nonMutating.length).toBe(25)
    // The named case, kept from the original: write-grade authority, no row.
    expect(classOf('linearSearch')).toBe('n/a')
  })
})

/**
 * POD-532: the per-issue activity feed used to page the whole repo's event log
 * and filter on `subject` in the browser. The narrowing moved into the input, so
 * the input is where it has to hold — including the half that is easy to break
 * silently, that OMITTING it still parses to the repo-wide read every existing
 * caller sends.
 */
describe('the events input', () => {
  it('accepts a subject, still parses without one, and refuses an empty one', () => {
    const narrowed = eventsInput.parse({ since: 0, repoPath: '/r', subject: 'iss_a', limit: 200 })
    expect(narrowed.subject).toBe('iss_a')

    const repoWide = eventsInput.parse({ repoPath: '/r', limit: 200 })
    expect(repoWide.subject).toBeUndefined()
    expect(repoWide).toMatchObject({ since: 0, repoPath: '/r', limit: 200 })

    // The paired denial: an empty subject would narrow to nothing while reading
    // like "no filter", so the schema rejects it rather than serving an empty feed.
    expect(eventsInput.safeParse({ since: 0, subject: '' }).success).toBe(false)
  })
})
