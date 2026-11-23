/**
 * WHAT A CONCERTMASTER NEEDS FROM ITS PERSON (POD-7211): the open asks of one
 * session, oldest first, and under a fold the ones already settled. The dock
 * panel draws it above the task's own details, so what needs you stays in view
 * after the chat has moved on. The cards are the chat's ({@link
 * ConcertmasterAskCard}), over the same records.
 */

import {
  concertmasterConversationHeld,
  openConcertmasterAskIds,
  respondToConcertmasterAsk,
  settledConcertmasterAskIds,
} from '@podium/client-graph/concertmaster'
import { here } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { observer } from '@podium/client-graph/react'
import type { SessionId } from '@podium/model/browser'
import type { SyncSubmitTransport } from '@podium/protocol'
import { type JSX, useCallback, useState } from 'react'
import { ConcertmasterAskCard, type RespondToAsk } from './ConcertmasterAskCard'

const Ask = observer(function Ask({
  pool,
  id,
  onRespond,
}: {
  pool: MobxPool
  id: string
  onRespond: RespondToAsk
}): JSX.Element | null {
  const entry = here(pool.model('concertmasterEntry', id))
  return entry ? <ConcertmasterAskCard entry={entry} dock onRespond={onRespond} /> : null
})

export const ConcertmasterNeedsYou = observer(function ConcertmasterNeedsYou({
  pool,
  transport,
  sessionId,
}: {
  pool: MobxPool
  transport: SyncSubmitTransport
  sessionId: SessionId
}): JSX.Element {
  // Reading the conversation holds it while this panel is shown.
  const held = concertmasterConversationHeld(pool, sessionId)
  const open = openConcertmasterAskIds(pool, sessionId)
  const settled = settledConcertmasterAskIds(pool, sessionId)
  const [showSettled, setShowSettled] = useState(false)
  const respond = useCallback<RespondToAsk>(
    (entry, response, text) =>
      respondToConcertmasterAsk(transport, {
        sessionId,
        entryId: entry.entryId,
        response,
        ...(text !== undefined ? { text } : {}),
      }),
    [transport, sessionId],
  )
  return (
    <section className="flex flex-col gap-2" data-testid="concertmaster-needs-you">
      <div className="flex items-baseline gap-2 text-[11.5px]">
        <h3 className="font-semibold text-muted-foreground">Needs you</h3>
        {open.length > 0 && <span className="text-text-faint tabular-nums">{open.length}</span>}
        <span className="flex-1" />
        {settled.length > 0 && (
          <button
            data-pressable
            type="button"
            aria-expanded={showSettled}
            onClick={() => setShowSettled((shown) => !shown)}
            className="text-text-dim transition-colors hover:text-foreground"
          >
            {showSettled ? 'Hide settled' : `Settled · ${settled.length}`}
          </button>
        )}
      </div>
      {open.length === 0 && (
        <p className="text-[12px] leading-[1.5] text-muted-foreground">
          {held
            ? 'Nothing right now. Questions, decisions and to-dos from this agent show up here.'
            : 'Loading…'}
        </p>
      )}
      {open.map((id) => (
        <Ask key={id} pool={pool} id={id} onRespond={respond} />
      ))}
      {showSettled && (
        <div className="flex flex-col gap-1.5 border-t border-hairline-soft pt-2">
          {settled.map((id) => (
            <Ask key={id} pool={pool} id={id} onRespond={respond} />
          ))}
        </div>
      )}
    </section>
  )
})
