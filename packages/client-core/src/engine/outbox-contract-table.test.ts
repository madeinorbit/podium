/**
 * THE DRIFT GUARD for the client's outbox contract table (POD-316).
 *
 * `OUTBOX_COMMANDS` in `@podium/client-core/engine` carries each queued kind's
 * contract name, version AND its `policy.confirmation` rule, because the
 * dead-letter recovery surface has to know whether an inline confirmation can
 * possibly satisfy a `confirmation-required` refusal — and it must know that
 * without importing the whole command registry into the browser bundle
 * (`audit:browser-reach`).
 *
 * A copied value needs a guard or it is drift waiting to happen. This test is
 * that guard, and it lives HERE — on the client side — rather than in
 * `packages/commands`, because commands is L1 and client-core depends on IT. A
 * first draft put it in commands and imported `@podium/client-core/engine`,
 * which is a dependency CYCLE: the import resolved to `undefined` at module
 * init and the suite failed with "Object.entries requires that input parameter
 * not be null" rather than with anything about contracts. The direction of the
 * dependency decides where a cross-package guard can live. It asserts equality with `toBe` against the
 * contract's own field, so a contract that changes its confirmation rule reddens
 * this test rather than silently leaving the client offering a confirm
 * affordance the command no longer has — or, worse, withholding one it does.
 *
 * It also asserts the offline class of every queued kind, which is the property
 * ADR 3 D4 rule 3 makes structural: a kind the client queues whose contract is
 * `online-only` or `online-sensitive` is a secret or a live-daemon operation
 * that must never have entered the queue at all.
 *
 * ---------------------------------------------------------------------------
 * AND, SINCE PDM-416, THE EXPOSURE TAG — IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * `delivery.class` says a command MAY be queued. `exposure` says it IS — ADR 3 D3's
 * whole content is that a transport serves a command because the contract NAMES it,
 * and `outbox` is a transport tag exactly like `cli` and `mcp`. Nothing compared the
 * tag to this table, and the two had come apart on TWELVE commands: `issues.close`,
 * `issues.update`, `issues.archive`, `issues.delete`, `issues.restore`,
 * `issues.defer`, `issues.undefer`, `issues.setLabels`, `issues.setPlacement`,
 * `issues.markRead`, `issues.markUnread` and `issues.setTucked` were all queued here
 * while their contracts named only `trpc`/`relay`(/`cli`/`mcp`). Every one of them
 * already declared `delivery.class: 'offline-eligible'`, so this was a FORGOTTEN
 * DECLARATION rather than a disagreement about intent — but "the neighbouring field
 * implies it" is precisely the reasoning D3 exists to refuse.
 *
 * The equivalent comparison for `cli`/`mcp` has existed since POD-1314, in
 * `scripts/audit-issue-commands.ts`, and it checks BOTH directions. This one does
 * too, and for the same reason that file gives: the two failures are different bugs.
 * A queued kind whose contract omits `outbox` is a transport served without a
 * declaration — default-closed defeated. A contract declaring `outbox` that this
 * table never queues is a declaration that opens nothing — the field decaying into
 * decoration. Checking one direction would have left the other free to rot, and
 * before PDM-416 neither was checked at all.
 *
 * WHAT THIS CANNOT SEE, said out loud: the eleven kinds in {@link UNGUARDED}. They
 * are presence-class `CommandDef`s, whose `CommandTransport` union does not even
 * CONTAIN `'outbox'` — the mismatch is not merely undeclared there, it is
 * unspellable. That is a gap in the vocabulary, not in this guard, and the exact
 * assertion of the UNGUARDED list below is what stops it being forgotten: a
 * presence command gaining a full contract reddens this file and joins the check.
 */

import type { CommandContract } from '@podium/commands'
import { ISSUE_CONTRACTS, LAYOUT_CONTRACTS, SETTINGS_CONTRACTS } from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { OUTBOX_COMMANDS } from './wiring'

/** Every contract a queued kind may name, by dotted name. The presence class
 *  (sessions.*, snoozes.*) has its own by-name lookup; issues.* is a plain
 *  registry. Both are consulted so no queued kind is excluded by silence. */
const byName = new Map<string, CommandContract>()
for (const contract of [
  ...Object.values(ISSUE_CONTRACTS),
  ...Object.values(SETTINGS_CONTRACTS),
  ...Object.values(LAYOUT_CONTRACTS),
]) {
  byName.set((contract as CommandContract).name, contract as CommandContract)
}
/**
 * Only a FULL contract can be compared: `sessionStateCommand` returns the leaf
 * `CommandDef` (action + scope), which has no `policy` and no `delivery`. A
 * first draft cast it to `CommandContract` anyway and every presence row failed
 * with "expected 'none' to be undefined" — the cast silenced the type system
 * about a difference that was real.
 *
 * So the lookup returns a contract or nothing, and the kinds with no full
 * contract are listed EXPLICITLY below rather than filtered away, because an
 * unguarded row that nobody can see is how the copy drifts.
 */
const lookup = (name: string): CommandContract | undefined => {
  const contract = byName.get(name)
  if (contract?.policy !== undefined) return contract
  return undefined
}

/**
 * Queued kinds whose contract this guard CANNOT check yet, with the reason.
 *
 * `sessions.*` and `snoozes.*` are the presence class (POD-380): they are
 * `CommandDef`s today, not full `CommandContract`s, so they carry no
 * `policy.confirmation` to compare against. `sessions.resumeAndSend` is
 * command-plane (POD-381) and lives in a registry this module does not reach.
 *
 * The three `issues.*` kinds are NOT here: they have full contracts and are
 * really compared, which is what stops this list from being a way to opt out.
 *
 * The list is asserted EXACTLY, so a presence command gaining a full contract
 * reddens this test and the row moves under the guard instead of staying
 * quietly unchecked.
 */
const UNGUARDED = [
  'dismissOffer',
  'pinSet',
  'rename',
  'tabSetOrder',
  'resumeAndSend',
  'sessionMarkRead',
  'sessionMarkUnread',
  'setArchived',
  'setWorkState',
  'snoozeClear',
  'snoozeSet',
].sort()

describe('the client outbox contract table matches the contracts', () => {
  const entries = Object.entries(OUTBOX_COMMANDS)

  it('names contracts that exist — a kind pointing at nothing would replay under a guess', () => {
    // Reported as a LIST rather than per-entry so a rename shows every casualty
    // at once instead of one per re-run.
    const unguarded = entries
      .filter(([, c]) => lookup(c.name) === undefined)
      .map(([kind]) => kind)
      .sort()
    expect(unguarded).toEqual(UNGUARDED)
  })

  it.each(
    entries.filter(([, c]) => lookup(c.name) !== undefined),
  )('%s: confirmation rule, offline class and outbox exposure match the contract', (_kind, command) => {
    const contract = lookup(command.name)
    if (!contract) throw new Error(`no contract for ${command.name}`)
    // `toBe`, not a shape check: the whole point is that the copied VALUE is
    // the contract's value.
    expect(command.confirmation).toBe(contract.policy.confirmation)
    // D4 rule 3: only an offline-eligible contract may be in this table at all.
    expect(contract.delivery.class).toBe('offline-eligible')
    // D3: and being queued here IS being served on the `outbox` transport, so the
    // contract has to say so. `delivery.class` above is permission, not declaration.
    expect(contract.exposure).toContain('outbox')
  })

  /**
   * THE OTHER DIRECTION, as one assertion over LISTS rather than per-entry, so a
   * cell edit that moves several contracts at once shows every casualty in one run
   * instead of one per re-run — the same reporting shape the `names contracts that
   * exist` case above uses.
   */
  it('no contract declares `outbox` that this table does not queue', () => {
    const queued = new Set(entries.map(([, command]) => command.name))
    const declaredElsewhere = [...byName.values()]
      .filter((contract) => contract.policy !== undefined && contract.exposure.includes('outbox'))
      .map((contract) => contract.name)
      .filter((name) => !queued.has(name))
      .sort()
    expect(declaredElsewhere).toEqual([])
  })
})
