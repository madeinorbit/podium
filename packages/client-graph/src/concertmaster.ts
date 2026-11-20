/**
 * A CONCERTMASTER'S CURATED CONVERSATION IN THE POOL (POD-7211): the reads the
 * curated chat and the Concertmaster dock panel share, and the person's two
 * commands.
 *
 * The entries are synced records (`concertmasterEntry`). A device holds one
 * session's entries while a view reads them: {@link concertmasterConversation}
 * reads the `ofSession` collection through the pool, and that read is the hold
 * (frontend-data "holding follows reading"). An entry said, an ask settled or
 * retracted anywhere moves these reads without a request.
 *
 * Whether a session IS a Concertmaster is a fact on its own record
 * (`session.concertmaster`), read with the feature flag by
 * {@link isConcertmasterSession}: with the flag off a marked session is an
 * ordinary session on every surface.
 */

import {
  type ConcertmasterResponse,
  compareConcertmasterEntries,
  type SessionId,
} from '@podium/model/browser'
import { type SyncSubmitTransport, submitNow } from '@podium/protocol'
import { compareShallow, computed, type IComputedValue } from 'mobx'
import { featureEnabled } from './instance-preferences'
import type { MobxPool, PoolRows } from './pool'
import type { LoaderInstance } from './shared/source'

const NONE: readonly string[] = Object.freeze([])

type EntryRow = PoolRows['concertmasterEntry']

/** The collection instance that is one session's conversation. */
export function concertmasterConversationOf(sessionId: string): LoaderInstance {
  return { collection: 'concertmasterEntry.ofSession', args: { sessionId }, part: 'main' }
}

interface ConversationReads {
  /** Every entry, in conversation order. */
  readonly ids: IComputedValue<readonly string[]>
  /** The asks that still need the person, oldest first. */
  readonly openAsks: IComputedValue<readonly string[]>
  /** The settled asks, the most recently settled first. */
  readonly settledAsks: IComputedValue<readonly string[]>
}

type ConversationPool = Pick<MobxPool, 'tables' | 'sources'>

function conversationReads(pool: ConversationPool, sessionId: string): ConversationReads {
  return pool.sources.view(`concertmaster:${sessionId}`, () => {
    const rows = (): EntryRow[] => {
      const out: EntryRow[] = []
      // A pool without the table (a screen's stand-in in a test) holds none.
      for (const row of pool.tables.concertmasterEntry?.values() ?? []) {
        const entry = row as EntryRow
        if (entry.sessionId === sessionId) out.push(entry)
      }
      return out.sort(compareConcertmasterEntries)
    }
    const ordered = computed(rows, { equals: compareShallow })
    const idsOf = (list: readonly EntryRow[]): readonly string[] =>
      list.length === 0 ? NONE : list.map((row) => row.id)
    return {
      ids: computed(() => idsOf(ordered.get()), { equals: compareShallow }),
      openAsks: computed(
        () => idsOf(ordered.get().filter((row) => row.kind === 'ask' && row.status === 'open')),
        { equals: compareShallow },
      ),
      settledAsks: computed(
        () =>
          idsOf(
            ordered
              .get()
              .filter((row) => row.kind === 'ask' && row.status !== 'open')
              .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? '')),
          ),
        { equals: compareShallow },
      ),
    }
  })
}

/** TRACKED: one session's conversation, oldest first, as pool ids
 *  (`pool.model('concertmasterEntry', id)`). */
export function concertmasterEntryIds(
  pool: ConversationPool,
  sessionId: string,
): readonly string[] {
  if (pool.sources === undefined) return NONE
  return conversationReads(pool, sessionId).ids.get()
}

/** TRACKED: the asks of one session that still need its person, oldest first. */
export function openConcertmasterAskIds(
  pool: ConversationPool,
  sessionId: string,
): readonly string[] {
  if (pool.sources === undefined) return NONE
  return conversationReads(pool, sessionId).openAsks.get()
}

/** TRACKED: the settled asks of one session, the most recently settled first. */
export function settledConcertmasterAskIds(
  pool: ConversationPool,
  sessionId: string,
): readonly string[] {
  if (pool.sources === undefined) return NONE
  return conversationReads(pool, sessionId).settledAsks.get()
}

/**
 * TRACKED: whether the device holds the session's conversation whole. Reading
 * it holds the conversation for as long as the reader is observed, and asks
 * for it when the device does not have it yet.
 */
export function concertmasterConversationHeld(
  pool: Pick<MobxPool, 'collections'>,
  sessionId: string,
): boolean {
  return pool.collections.held(concertmasterConversationOf(sessionId))
}

/**
 * TRACKED: the session is shown as a Concertmaster: it carries the mark and the
 * `concertmaster` feature is on. The one predicate every surface asks, so the
 * pane, the dock and the menus cannot disagree.
 */
export function isConcertmasterSession(
  pool: Parameters<typeof featureEnabled>[0],
  session: { readonly concertmaster?: boolean | undefined } | undefined,
): boolean {
  return session?.concertmaster === true && featureEnabled(pool, 'concertmaster')
}

/** Mark one of my sessions as a Concertmaster, or clear the mark (`concertmaster.assign`). */
export async function assignConcertmaster(
  transport: SyncSubmitTransport,
  sessionId: SessionId,
  on: boolean,
): Promise<void> {
  await submitNow(transport, 'concertmaster.assign', { sessionId, on })
}

/**
 * Settle an open ask (`concertmaster.respond`): answer it, mark a to-do done,
 * or dismiss it. Answers `false` when it was settled in the meantime (the agent
 * retracted it, or another device of mine got there first): the record that
 * arrives says how.
 */
export async function respondToConcertmasterAsk(
  transport: SyncSubmitTransport,
  input: {
    sessionId: SessionId
    entryId: string
    response: ConcertmasterResponse
    text?: string
  },
): Promise<boolean> {
  const result = await submitNow<{ settled: boolean }>(transport, 'concertmaster.respond', {
    sessionId: input.sessionId,
    entryId: input.entryId,
    response: input.response,
    ...(input.text !== undefined && input.text.trim() !== '' ? { text: input.text.trim() } : {}),
  })
  return result.settled
}
