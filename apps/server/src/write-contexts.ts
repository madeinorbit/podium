/**
 * THE WRITE CONTEXTS (ADR 12 D9, POD-6592).
 *
 * A synced write needs a scope (`@podium/sync`'s `WriteScope`), and a scope comes
 * from one place: the mint the Ledger hands out once, which the composition root
 * gives to {@link WriteContexts}. What can write therefore follows from what a
 * piece of code was handed:
 *
 *  - a SYNC handler gets a `SyncWriteContext` from the sync write entry point,
 *    whose writer is bound to the command's own scope ({@link WriteContexts.sync});
 *  - a PLAIN handler gets a {@link PlainContext}: who is asking, and no writer;
 *  - a SERVER-ORIGINATED write gets a {@link SystemWriteContext} for one of the
 *    origins declared in {@link SYSTEM_WRITE_ORIGINS}.
 *
 * THE ORIGIN TABLE IS THE CENSUS OF EXCEPTIONS. Every writer that is not a sync
 * handler's is named there, with what it is and what kind of origin it is. A new
 * one is a line in this file, visible in review. An origin of kind `client` is a
 * service that also serves sync commands but still writes through a writer it
 * was given at composition rather than the command's context; each carries the
 * date and the issue that removes it.
 *
 * WHAT IS CHECKED AT RUNTIME. A cast can forge any type, so the contexts also
 * check where they are used:
 *
 *  - a system write inside a plain command is refused (`plain-command-scope.ts`,
 *    through the Ledger's provenance port, as before);
 *  - a `server` origin writing inside an open sync command is refused: work done
 *    for a client command is that command's write, under its scope, never the
 *    server's own.
 */

import type { MutationId } from '@podium/model'
import type { Ledger, LedgerWriter, WriteScopeMint } from '@podium/sync'
import type { CommandPrincipal } from './command-principal'
import { currentWriteProvenance } from './write-provenance'

/**
 * What a server-originated writer is:
 *
 *  - `server`: the server's own account (boot truth). Never inside a command.
 *  - `mirror`: a feed projection of rows another write made. It runs inside
 *    whichever unit made them, a sync command's included, and carries that
 *    command's provenance.
 *  - `client`: a service that also serves sync commands but writes through a
 *    composition-time writer. Allowed inside a command until its owner issue
 *    passes the command's context per call.
 */
export type SystemWriteKind = 'server' | 'mirror' | 'client'

export interface SystemWriteOriginSpec {
  readonly what: string
  readonly kind: SystemWriteKind
  /** For a `client` origin: when it goes, and which issue removes it. */
  readonly legacy?: { readonly removeAfter: string; readonly owner: string }
}

export const SYSTEM_WRITE_ORIGINS = {
  'boot.reconcile': {
    what: 'boot truth for kinds whose rows can change while the server is down (machines, the order plane, layout)',
    kind: 'server',
  },
  'automations.schedule': {
    what: "the automation scheduler: each occurrence's run row and the re-arm, from its timer and the maintenance re-check, and the boot reconcile",
    kind: 'server',
  },
  'approvals.execute': {
    what: 'an approved server op (a one-off automation), run by the approval.execute effect after its decision commits',
    kind: 'server',
  },
  'conversations.discovery': {
    what: "a daemon's conversation discovery report and the list reconcile that follows (the memory service)",
    kind: 'server',
  },
  'effects.runner': {
    what: "the effect runner: claiming a record, its stage and settlement, the deadline and retention sweeps, under the record's own causation",
    kind: 'server',
  },
  'effects.system': {
    what: 'an effect record the server itself asks for, with no caller (the janitor connect scan)',
    kind: 'server',
  },
  'shipping.lanes': {
    what: "the order plane's lane machine: train claims, attempts, transitions, effects, holds, repairs and the boot reconcile",
    kind: 'server',
  },
  'settings.preferences': {
    what: "a personal preference the server writes for a person, outside any command of theirs (the Telegram chat binding, the superagent default it picks): the person's userPreferences record",
    kind: 'server',
  },
  steward: {
    what: "the steward's issue notices: an unblocked dependent, a parent's nudge",
    kind: 'server',
  },
  'machines.projection': {
    what: "a machine's display projection, republished whenever its row changes",
    kind: 'mirror',
  },
  'feed.issueEvents': {
    what: 'the curated issue-event feed, from every orchestrator event append',
    kind: 'mirror',
  },
  'feed.messages': {
    what: 'chat messages and their delivery status, from every write to the messages table',
    kind: 'mirror',
  },
  'feed.effects': {
    what: 'effect records, from every write to the effects table',
    kind: 'mirror',
  },
  'feed.interactions': {
    what: 'pending agent questions, from session state changes and exits',
    kind: 'mirror',
  },
  'issues.server': {
    what: "the issues service's own work: worktree moves, landing, cleanup, git state, auto-archive, integration runs, boot reconciles, and an issue effect record's run after its commit (start, sessions, stop, cleanup, ship, the assistant, an answer)",
    kind: 'server',
  },
  'sessions.daemon': {
    what: "a daemon's reports about its sessions: state and exits, titles, cwd moves, git activity, runtime events, binding receipts, the machine reconcile on attach",
    kind: 'server',
  },
  'sessions.lifecycle': {
    what: 'the server acting on a session after a commit: the lifecycle controller, starts, teardown, revival, and the launch, interrupt, configure and handoff executors',
    kind: 'server',
  },
  'superagent.turns': {
    what: "the superagent's turn runner, after the send that queued a turn commits: the headless session a turn's preparation (re)creates (the queue pump, a harness switch) and the resume ref a turn's result binds",
    kind: 'server',
  },
  'superagent.bridge': {
    what: "the messaging bridge's superagent sends (a Telegram chat message becomes a turn), which no client command carries: the headless session the send creates",
    kind: 'server',
  },
  'superagent.tools': {
    what: "the superagent's own session writes: its tool calls on its human's sessions (a name, a snooze, a work state, a kill, a message it sends), made from its own turn, and the kill a reset makes after it commits",
    kind: 'server',
  },
  'messages.daemon': {
    what: "a machine's reports about the messages it was handed: a queue row typed, taken, settled, withdrawn, lost track of or refused, a drain that gave up, a transcript echo, the history entry and program ids a message became",
    kind: 'server',
  },
  'messages.delivery': {
    what: "the server's own delivery work: a send's hand-on after its commit, the eligibility retries, the boot walk and the slow sweep, a retract's request to the machine after its commit, a failure notice's delivery, the janitor's observed expiry",
    kind: 'server',
  },
  'messages.server': {
    what: "a message a server job sends on its own account: lock grants and steals, the approval broker's and machine diagnostics' notices, the workflow engine's coordinator notice, and an answer an effect run types as text",
    kind: 'server',
  },
  'sessions.refs': {
    what: "session rows whose birth ref changed because an issue repair renumbered or re-keyed their issue, captured inside that repair's write",
    kind: 'mirror',
  },
  'sessions.live': {
    what: "a session's live fields (activity, terminal state, the composer's draft tag) captured to the feed, inside whichever unit flushes them",
    kind: 'mirror',
  },
} as const satisfies Record<string, SystemWriteOriginSpec>

export type SystemWriteOrigin = keyof typeof SYSTEM_WRITE_ORIGINS

/** The writes a sync handler's unit of work may make, bound to its command. */
export type SyncCommandWriter = Pick<LedgerWriter, 'commit' | 'capture'>

/** A server-originated writer, for one declared origin. */
export interface SystemWriteContext extends LedgerWriter {
  readonly origin: SystemWriteOrigin
}

/**
 * What a plain handler gets (ADR 12 D8): who is asking and which command this is.
 * No scope and no writer, so a plain handler has nothing to write synced data with.
 */
export interface PlainContext {
  readonly principal: CommandPrincipal
  readonly command: string
}

/** A `server` origin wrote inside a client command. */
export class SystemWriteInsideCommand extends Error {
  constructor(readonly origin: SystemWriteOrigin) {
    super(
      `write context: '${origin}' is the server's own account and wrote inside a client command; ` +
        'that write belongs to the command, under its scope',
    )
    this.name = 'SystemWriteInsideCommand'
  }
}

export class WriteContexts {
  constructor(
    private readonly ledger: Ledger,
    private readonly mint: WriteScopeMint,
  ) {}

  /** The writer of one sync command. For the sync write entry point only. */
  sync(mutationId: MutationId): SyncCommandWriter {
    const writer = this.ledger.writer(this.mint.sync(mutationId))
    return { commit: writer.commit, capture: writer.capture }
  }

  /** A writer for one declared server origin. */
  system(origin: SystemWriteOrigin): SystemWriteContext {
    const writer = this.ledger.writer(this.mint.system(origin))
    const guard = (): void => {
      // A client command's scope names its mutationId; a server job's own
      // provenance (an effect run's causationId) names none.
      if (
        SYSTEM_WRITE_ORIGINS[origin].kind === 'server' &&
        currentWriteProvenance()?.mutationId !== undefined
      ) {
        throw new SystemWriteInsideCommand(origin)
      }
    }
    return {
      origin,
      commit: async (op) => {
        guard()
        return await writer.commit(op)
      },
      capture: async (specs) => {
        guard()
        return await writer.capture(specs)
      },
      reconcile: async (entity, rows) => {
        guard()
        return await writer.reconcile(entity, rows)
      },
    }
  }
}
