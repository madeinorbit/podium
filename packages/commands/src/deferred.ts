/**
 * DEFERRED CAPABILITIES — the features v1 does not have, named so their absence
 * is enforced rather than merely true (A3/PDM-129).
 *
 * ---------------------------------------------------------------------------
 * WHY AN ABSENCE NEEDS A DECLARATION
 * ---------------------------------------------------------------------------
 *
 * The execution charter lists what this product deliberately does not do:
 *
 *     No multi-human execution environment, machine handover, member
 *     offboarding/resource redistribution, automation sharing/transfer,
 *     provider credential revocation/installed-copy recall, public task access
 *     or new cloud identity stack.
 *
 * Most of those were already unrepresentable — no command exists — and two were
 * not. `machines.share` / `machines.unshare` were live on tRPC, and
 * `machines.share` with `verb: 'use'` is a second person placing code execution
 * on someone else's machine, which is the first item on that list. So was
 * `machines.transferOwnership`, which is the second: the accounts-and-machines
 * addendum says "there is no machine-handover workflow" and accepted D12 adds
 * the instruction — "disable corresponding public mutations rather than only
 * hiding menus".
 *
 * That is the difference this file exists to remove. "No command does X" is a
 * property of today's table, and nothing was watching it. A scope decision that
 * only holds while everyone remembers it is not a scope decision; it is a
 * coincidence with a good track record. The census found three commands where
 * the coincidence had already lapsed.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS ENFORCED
 * ---------------------------------------------------------------------------
 *
 * `deferred.test.ts` walks every contract in the package and fails
 * if one whose name matches a deferred capability declares ANY transport. It is
 * a name-shaped check on purpose: the thing being guarded is that nobody adds
 * `machines.handover` or `accounts.recall` without the decision being reopened,
 * and a reviewer who has to delete a line from THIS list to do it has been told
 * what they are doing.
 *
 * This is a v1 EXPOSURE decision, not a judgement that any of these features is
 * wrong. D-series decisions belong to the human (charter §13), and a task whose
 * schema or behaviour needs one not on that list files a blocker rather than
 * choosing a default.
 */

/** One capability v1 does not ship, with the command names that would implement it. */
export interface DeferredCapability {
  readonly capability: string
  /** Exact contract names, and name PREFIXES ending in `.`, that belong to it. */
  readonly commandNames: readonly string[]
  /** The charter clause that defers it, quoted closely enough to check. */
  readonly charterClause: string
}

export const DEFERRED_CAPABILITIES: readonly DeferredCapability[] = [
  {
    capability: 'multi-human execution environment / machine sharing',
    commandNames: ['machines.share', 'machines.unshare'],
    charterClause:
      'Exactly one human may execute through Podium on a machine; ownership comes from authenticated enrollment/bootstrap. No multi-human execution environment.',
  },
  {
    capability: 'machine handover',
    commandNames: [
      // LIVE AND SERVED before A3, like `machines.share`. Owner-only and
      // carefully designed — and a well-designed command for a feature v1 does
      // not have. The addendum: "there is no machine-handover workflow", and
      // "Enrollment of a machine for someone else, handover and alternate-owner
      // re-pairing are not v1 features."
      'machines.transferOwnership',
      'machines.handover',
      'machines.transfer',
      'machines.reassign',
    ],
    charterClause:
      'No machine handover; there is no machine-handover workflow, and reassignment never transfers machine/credential/session rights. Accepted D12: disable corresponding public mutations rather than only hiding menus.',
  },
  {
    capability: 'member offboarding and resource redistribution',
    commandNames: ['accounts.offboard', 'users.offboard', 'members.offboard', 'members.redistribute'],
    charterClause:
      'No member offboarding/resource redistribution. A disabled member keeps their rows and their ownership (D12).',
  },
  {
    capability: 'automation sharing and transfer',
    commandNames: [
      'automations.share',
      'automations.unshare',
      'automations.transfer',
      'issues.subscriptionTransfer',
    ],
    charterClause:
      'No automation sharing/transfer. Personal automation configuration and memory stay private; automations are private and singly owned.',
  },
  {
    capability: 'provider credential revocation and installed-copy recall',
    commandNames: ['accounts.recall', 'accounts.revokeInstalled', 'accounts.revokeRemote'],
    charterClause:
      'No provider credential revocation/installed-copy recall. Existing different or unknown logins are preserved and cannot become silent fallback payers.',
  },
  {
    capability: 'public task access',
    commandNames: ['issues.publish', 'issues.makePublic', 'issues.sharePublic'],
    charterClause:
      'No public task access. Invite-only is the only admission mode (D8), and there is no viewer role (D13).',
  },
  {
    capability: 'session handover, view and control',
    commandNames: [
      'sessions.handover',
      'sessions.takeover',
      'sessions.attachTo',
      'sessions.control',
      'sessions.view',
    ],
    charterClause:
      'No presence or shared/private-session handover/view/control. Admins cannot view or drive another member\'s session (D7).',
  },
] as const

/** Every deferred command name, flattened. */
export const DEFERRED_COMMAND_NAMES: readonly string[] = DEFERRED_CAPABILITIES.flatMap(
  (entry) => entry.commandNames,
)

/**
 * Is this contract name one v1 defers? Exact match only.
 *
 * DELIBERATELY NOT A PREFIX OR FUZZY MATCH. `issues.share` is task sharing — the
 * existing owner-or-grant model the charter KEEPS — and a check that matched
 * `*.share` would have refused it, which would either have broken the product or
 * taught the next person to add an exception list. A capability is deferred by
 * NAME, and a new name that implements one is caught by the reviewer who has to
 * add it to {@link DEFERRED_CAPABILITIES} or argue why it does not belong there.
 */
export function isDeferredCapability(contractName: string): boolean {
  return DEFERRED_COMMAND_NAMES.includes(contractName)
}
