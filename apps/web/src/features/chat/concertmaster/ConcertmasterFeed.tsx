/**
 * A CONCERTMASTER'S CURATED CHAT (POD-7211): what takes the transcript's place
 * in the pane of a session marked as a Concertmaster.
 *
 * It shows one ordered conversation and nothing of how the agent works:
 *
 *  - what the agent chose to send (`podium concertmaster say`), as prose on the
 *    sheet at the reading measure;
 *  - what its person sent, as the same right-hand card the transcript uses;
 *  - the agent's asks, inline where they were asked: an open one is a card to
 *    act on, a settled one a line that keeps the question and its answer.
 *
 * A message the person just sent is the chat's own pending bubble
 * ({@link PendingBubbles}) until the agent has it; then the conversation holds
 * its entry and the bubble steps aside for it. The tail is the transcript's:
 * the working mark while the agent computes, and stillness otherwise.
 *
 * The transcript still loads behind this view (the conversation service owns
 * that); it is not drawn. Clearing the mark shows it again.
 */

import {
  concertmasterConversationHeld,
  concertmasterEntryIds,
  respondToConcertmasterAsk,
} from '@podium/client-graph/concertmaster'
import { here } from '@podium/client-graph/lookup'
import type { ConcertmasterEntryModel, SessionModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import type { SessionId } from '@podium/model/browser'
import { concertmasterMessageIdOf, isConcertmasterResponseMessageId } from '@podium/model/browser'
import type { SyncSubmitTransport } from '@podium/protocol'
import { ArrowDownToLine } from 'lucide-react'
import { type JSX, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '@/lib/markdown'
import { useKnownRefPrefixesVersion } from '@/lib/use-known-ref-prefixes'
import { cn } from '@/lib/utils'
import { StableMarkdown } from '../ChatBlockView'
import { ItemAttachments } from '../ChatUploadThumb'
import { OfferArtifactStrip } from '../OfferArtifactStrip'
import { TranscriptCold } from '../TranscriptCold'
import { PendingBubbles } from '../TranscriptFeed'
import { TranscriptTail } from '../TranscriptTail'
import { clockLabel, dayKey, dayLabel, fullTimeLabel } from '../transcript-time'
import type { ChatSurface } from '../use-chat-layout'
import { ConcertmasterAskCard, type RespondToAsk } from './ConcertmasterAskCard'

/** Within this of the end, the feed counts as at the end and follows new entries. */
const PINNED_SLACK_PX = 56

type OpenFile = (sessionId: SessionId, path: string) => void

/** A message body as sanitized Markdown, with the chat's link handling. */
const MessageMarkdown = memo(function MessageMarkdown({
  text,
  sessionId,
  cwd,
  openFile,
}: {
  text: string
  sessionId: SessionId
  cwd: string
  openFile: OpenFile
}): JSX.Element {
  const refPrefixesVersion = useKnownRefPrefixesVersion()
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderMarkdown reads the ref-prefix registry.
  const html = useMemo(() => renderMarkdown(text), [text, refPrefixesVersion])
  return <StableMarkdown html={html} sessionId={sessionId} cwd={cwd} openFile={openFile} />
})

function Clock({ iso }: { iso: string }): JSX.Element | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return (
    <time className="chat-clk" dateTime={iso} title={fullTimeLabel(at)}>
      {clockLabel(at)}
    </time>
  )
}

/** What the agent sent: prose on the sheet, with any artifacts it named. */
const SaidEntry = observer(function SaidEntry({
  entry,
  session,
  sessionId,
  cwd,
  openFile,
}: {
  entry: ConcertmasterEntryModel
  session: SessionModel | undefined
  sessionId: SessionId
  cwd: string
  openFile: OpenFile
}): JSX.Element {
  const artifacts = entry.artifacts
  // The strip resolves named artifacts against the issue's list; an offer is
  // the shape it takes them in.
  const evidence = useMemo(
    () =>
      artifacts && artifacts.length > 0
        ? { message: '', actions: [], artifacts: [...artifacts], createdAt: entry.createdAt }
        : null,
    [artifacts, entry.createdAt],
  )
  return (
    <div className="transcript-row cm-said" data-testid="concertmaster-said">
      <div className="transcript-body">
        <MessageMarkdown text={entry.body} sessionId={sessionId} cwd={cwd} openFile={openFile} />
        {evidence && session && (
          <div className="mt-2">
            <OfferArtifactStrip offer={evidence} session={session} />
          </div>
        )}
        <div className="msg-foot" data-side="left">
          <Clock iso={entry.createdAt} />
        </div>
      </div>
    </div>
  )
})

/** What the person sent, once the agent has it: the transcript's own card. */
const UserEntry = observer(function UserEntry({
  entry,
  sessionId,
  cwd,
  openFile,
  httpOrigin,
  onOpenImage,
}: {
  entry: ConcertmasterEntryModel
  sessionId: SessionId
  cwd: string
  openFile: OpenFile
  httpOrigin: string
  onOpenImage: ChatSurface['setLightbox']
}): JSX.Element {
  const attachments = entry.attachments ?? []
  return (
    <div className="transcript-row transcript-turn-open" data-testid="concertmaster-user">
      <div className="transcript-body transcript-you">
        <div className="transcript-you-bubble">
          <div className="transcript-you-body">
            <MessageMarkdown
              text={entry.body}
              sessionId={sessionId}
              cwd={cwd}
              openFile={openFile}
            />
            {attachments.length > 0 && (
              <ItemAttachments
                sessionId={sessionId}
                attachments={attachments.map((file) => ({
                  id: file.id,
                  filename: file.filename,
                  kind: file.kind,
                }))}
                tags={[]}
                httpOrigin={httpOrigin}
                onOpenImage={onOpenImage}
              />
            )}
          </div>
        </div>
        <div className="msg-foot" data-side="right">
          <Clock iso={entry.createdAt} />
        </div>
      </div>
    </div>
  )
})

/** One entry by its pool id; a row that left the pool draws nothing. */
const Entry = observer(function Entry({
  id,
  chat,
  sessionId,
  onRespond,
}: {
  id: string
  chat: ChatSurface
  sessionId: SessionId
  onRespond: RespondToAsk
}): JSX.Element | null {
  const entry = here(chat.conversation.pool.model('concertmasterEntry', id))
  if (!entry) return null
  const { cwd, session } = chat.view
  if (entry.kind === 'ask') {
    return (
      <div className="transcript-row cm-ask-row">
        <div className="transcript-body">
          <ConcertmasterAskCard entry={entry} onRespond={onRespond} />
        </div>
      </div>
    )
  }
  if (entry.kind === 'user') {
    return (
      <UserEntry
        entry={entry}
        sessionId={sessionId}
        cwd={cwd}
        openFile={chat.openFile}
        httpOrigin={chat.httpOrigin}
        onOpenImage={chat.setLightbox}
      />
    )
  }
  // `say`, and any kind a newer server adds: its words, as the agent's.
  return (
    <SaidEntry
      entry={entry}
      session={session}
      sessionId={sessionId}
      cwd={cwd}
      openFile={chat.openFile}
    />
  )
})

/** The day each entry was said, for the marks between days. */
function dayMarks(
  pool: ChatSurface['conversation']['pool'],
  ids: readonly string[],
  now: Date,
): ReadonlyMap<string, string> {
  const marks = new Map<string, string>()
  let previous: string | undefined
  for (const id of ids) {
    const entry = here(pool.model('concertmasterEntry', id))
    if (!entry) continue
    const at = new Date(entry.createdAt)
    if (Number.isNaN(at.getTime())) continue
    const key = dayKey(at)
    if (key !== previous) marks.set(id, dayLabel(at, now))
    previous = key
  }
  return marks
}

/** What an empty conversation says: who this is and how it will speak. */
const EmptyConversation = observer(function EmptyConversation({
  session,
}: {
  session: SessionModel | undefined
}): JSX.Element {
  const name = session?.name || session?.title || 'This agent'
  return (
    <div className="cm-empty" data-testid="concertmaster-empty">
      <p className="cm-empty-title">{name} is your Concertmaster.</p>
      <p className="cm-empty-copy">
        It speaks to you here, in messages it chooses to send, and keeps what it needs from you in
        the panel on the right. Its transcript and terminal stay out of view.
      </p>
      <p className="cm-empty-copy">Tell it what to take on.</p>
    </div>
  )
})

export const ConcertmasterFeed = observer(function ConcertmasterFeed({
  chat,
  sessionId,
  compact,
}: {
  chat: ChatSurface
  sessionId: SessionId
  compact: boolean
}): JSX.Element {
  const pool = chat.conversation.pool
  // Reading the conversation holds it on this device while the chat is shown.
  const held = concertmasterConversationHeld(pool, sessionId)
  const ids = concertmasterEntryIds(pool, sessionId)
  const session = chat.view.session

  // A sent message is a bubble until the conversation holds its entry.
  const recorded = useMemo(() => {
    const messages = new Set<string>()
    for (const id of ids) {
      const entryId = here(pool.model('concertmasterEntry', id))?.entryId
      const messageId = entryId === undefined ? undefined : concertmasterMessageIdOf(entryId)
      if (messageId !== undefined) messages.add(messageId)
    }
    return messages
  }, [ids, pool])
  // Nor is the message that carries a response to the agent: the conversation
  // shows a response on its ask.
  const pending = chat.view.pending.filter((bubble) => {
    const ids = bubble.record === undefined ? [bubble.id] : [bubble.id, bubble.record.id]
    return !ids.some((id) => recorded.has(id) || isConcertmasterResponseMessageId(id))
  })

  const transport = chat.conversation.runtime.api as unknown as SyncSubmitTransport
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

  // FOLLOW THE END WHILE THE READER IS AT IT. A reader who scrolled up to read
  // back stays where they are and gets the way down instead.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  const toEnd = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
    pinnedRef.current = true
    setAtEnd(true)
  }, [])
  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const pinned =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PINNED_SLACK_PX
    pinnedRef.current = pinned
    setAtEnd(pinned)
  }, [])
  const entryCount = ids.length
  const pendingCount = pending.length
  const working = chat.view.turnActive
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counts and the working state are what grow the feed.
  useLayoutEffect(() => {
    if (pinnedRef.current) toEnd()
  }, [entryCount, pendingCount, working, sessionId, toEnd])

  // biome-ignore lint/correctness/useExhaustiveDependencies: marks follow the entries; the clock is read when they change.
  const marks = useMemo(() => dayMarks(pool, ids, new Date()), [pool, ids])
  const loading = !held && entryCount === 0
  const empty = held && entryCount === 0 && pendingCount === 0

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="concertmaster-feed">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className={cn(
          'cm-feed min-h-0 flex-1 overflow-x-hidden overflow-y-auto',
          compact
            ? 'px-3.5 pt-3 pb-4'
            : 'px-[max(32px,calc((100%-var(--chat-reading-measure))/2))] pt-[26px] pb-[14px]',
        )}
      >
        <div className="feed-column flex min-h-full min-w-0 flex-col">
          {/* A short conversation sits on the composer, as the transcript's does. */}
          <div className="mt-auto" aria-hidden="true" />
          {loading && <TranscriptCold compact={compact} />}
          {empty && <EmptyConversation session={session} />}
          {ids.map((id) => (
            <div key={id} data-entry={id}>
              {marks.has(id) && (
                <div className="transcript-daymark" data-testid="transcript-daymark">
                  <span className="transcript-daymark-label">{marks.get(id)}</span>
                </div>
              )}
              <Entry id={id} chat={chat} sessionId={sessionId} onRespond={respond} />
            </div>
          ))}
          <PendingBubbles
            pending={pending}
            session={session}
            sessionId={sessionId}
            cwd={chat.view.cwd}
            openFile={chat.openFile}
            httpOrigin={chat.httpOrigin}
            onOpenImage={chat.setLightbox}
            onRetractQueued={chat.retractQueuedMessage}
            onRetryPending={chat.retryPending}
            onDiscardPending={chat.discardPending}
            onSendAgain={chat.sendAgain}
          />
          {/* The slot stands whether or not a tail is due, so a phase change at
              the end of a pinned feed moves no geometry (the transcript's rule). */}
          <div className="feed-tail-slot" data-testid="feed-tail-slot">
            <TranscriptTail
              activity={chat.view.activity}
              since={session?.agentState?.since}
              session={session}
            />
          </div>
        </div>
      </div>
      {!atEnd && (
        <button
          data-pressable
          type="button"
          className="absolute bottom-3 left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-input bg-muted px-3 py-[5px] text-xs text-foreground shadow-[0_4px_14px_var(--carve-popover-near)] hover:border-foreground/30"
          onClick={toEnd}
        >
          <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
        </button>
      )}
    </div>
  )
})
