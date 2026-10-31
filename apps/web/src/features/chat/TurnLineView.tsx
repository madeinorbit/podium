import { toolSubject, transcriptActivityFacts } from '@podium/client-core/values'
import { ChevronRight } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { useAgeNow } from '@/lib/clock-hooks'
import { renderMarkdown } from '@/lib/markdown'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { cn } from '@/lib/utils'
import { ChatBlockView, StableMarkdown } from './ChatBlockView'
import { handleChatMdClick } from './chat-md-click'
import { StretchMember } from './ToolBatchView'
import type { TranscriptFeedProps } from './TranscriptFeed'
import { transcriptTailState } from './TranscriptTail'
import { clockLabel, formatWorkDuration, fullTimeLabel, parseTs } from './transcript-time'
import { FOLD_GEOMETRY_EVENT, type FoldLine, foldLead, type TurnFoldState } from './turn-fold'
import { buildTurnPreviewMembers, type PresentedTurn, type TurnMember } from './turn-line-model'
import { useFeedArrivals } from './use-feed-arrivals'
import { WorkGlyph } from './WorkGlyph'

export function previewMembers(props: TranscriptFeedProps): TurnMember[] {
  if (props.chat?.view.previewMembers) return props.chat.view.previewMembers
  const preview = props.chat ? props.chat.view.preview : props.turnPreview
  const overlay = props.chat ? props.chat.view.overlay : props.overlay
  return buildTurnPreviewMembers(props.sessionId, preview, overlay)
}

export function turnTail(props: TranscriptFeedProps, model?: PresentedTurn) {
  const view = props.chat?.view
  const activity = view ? view.activity : props.activity
  const overlayStatus = props.chat ? view?.overlayStatus : props.overlay?.status
  const session = view?.session ?? props.session
  const preview = previewMembers(props)
  const tailActivity = overlayStatus
    ? { tone: 'working' as const, label: overlayStatus }
    : (activity ?? (preview.length ? { tone: 'working' as const, label: 'Working' } : null))
  const tool =
    preview.findLast((member) => member.block.item.role === 'tool')?.block ?? model?.currentTool
  const lastRow = tool
    ? { kind: 'tools' as const, blocks: [tool], blockIndices: [], title: '' }
    : (view?.presentation.tailRow(props.rows.at(-1)?.row) ?? props.rows.at(-1)?.row)
  const since = props.chat ? view?.session?.agentSince : session?.agentState?.since
  return {
    state: transcriptTailState(tailActivity, session, lastRow, since),
    activity: tailActivity,
    session,
    lastRow,
    since,
  }
}

/** Dependency waits are still work. Operator waits, transport and errors keep
 * their tail row; the line only hosts the tail's ongoing-work presentation. */
export function lineOwnsTail(line: FoldLine | undefined, props: TranscriptFeedProps): boolean {
  if (!line || line.fold.state !== 'live' || props.pendingAskBlock) return false
  const { state } = turnTail(props)
  return state?.mode === 'working' || state?.mode === 'wait'
}

function Clock({
  start,
  duration,
  live,
}: {
  start: string | undefined
  duration: number | undefined
  live: boolean
}) {
  const at = start ? Date.parse(start) : Number.NaN
  const known = Number.isFinite(at)
  const now = useAgeNow(at, 0, live && known)
  const elapsed = live && known ? Math.max(0, now - at) : duration
  return elapsed === undefined ? null : (
    <span className="tl-timer" aria-hidden={live || undefined}>
      {formatWorkDuration(elapsed)}
    </span>
  )
}

/** Keep at most one outgoing phrase. Text streaming into the same narration
 * updates in place; a new narration or settlement gets the approved swap. */
function Phrase({
  text,
  phraseKey,
  children,
  query = '',
  code = false,
}: {
  text: string
  phraseKey: string
  children?: React.ReactNode
  query?: string
  code?: boolean
}) {
  const node = useRef<HTMLSpanElement>(null)
  const previous = useRef({ text, phraseKey })
  const latest = useRef(text)
  latest.current = text
  if (previous.current.phraseKey === phraseKey) previous.current.text = text
  const [leaving, setLeaving] = useState<string | undefined>()
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = { text: latest.current, phraseKey }
    if (
      before.phraseKey === phraseKey ||
      !node.current?.animate ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setLeaving(undefined)
      return
    }
    setLeaving(before.text)
    const animation = node.current.animate(
      [
        { opacity: 0, transform: 'translateY(7px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
    const timer = setTimeout(() => setLeaving(undefined), 220)
    return () => {
      animation.cancel()
      clearTimeout(timer)
    }
  }, [phraseKey])
  return (
    <span className={cn('work-line-phrase tl-phrase', code && 'work-line-code')}>
      {leaving !== undefined && (
        <span className="leaving" aria-hidden="true">
          {leaving}
        </span>
      )}
      <span className="tl-current" ref={node}>
        {markPhrase(text, query)}
        {children}
      </span>
    </span>
  )
}

export const TurnLineView = observer(function TurnLineView({
  line,
  state,
  model,
  props,
  newest,
}: {
  line: FoldLine
  state: TurnFoldState
  model: PresentedTurn
  props: TranscriptFeedProps
  newest: boolean
}) {
  const { fold, open } = line
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)
  const tail = turnTail(props, model)
  const preview = newest ? previewMembers(props) : []
  const liveNarration = preview.findLast((member) => member.block.item.role === 'assistant')
  const live = newest && lineOwnsTail(line, props)
  const failed = newest && fold.state === 'live' && tail.state?.mode === 'error'
  const stopped = fold.state === 'stopped' || (newest && tail.state?.mode === 'interrupted')
  const paused =
    fold.state === 'paused' ||
    (newest && fold.state === 'live' && (!!props.pendingAskBlock || tail.state?.mode === 'waiting'))
  const mode = failed ? 'failed' : stopped ? 'stopped' : paused ? 'paused' : live ? 'live' : 'done'
  const [retiringMark, setRetiringMark] = useState(live)
  useLayoutEffect(() => {
    if (live) {
      setRetiringMark(true)
      return
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetiringMark(false)
      return
    }
    const timer = setTimeout(() => setRetiringMark(false), 200)
    return () => clearTimeout(timer)
  }, [live])
  const stopAt = fold.endedAt ?? (!live ? tail.since : undefined)
  const elapsed =
    fold.durationMs ??
    (fold.startedAt && stopAt
      ? Math.max(0, Date.parse(stopAt) - Date.parse(fold.startedAt))
      : undefined)
  // Answering a question settles the paused segment as a turn summary, even
  // when it contained just one command. The next segment gets its own line.
  const single = model.eventCount === 1 && !fold.questionSeam
  const singleWell = single && fold.updates === 0 && mode === 'done'
  const lead = foldLead({
    ...fold,
    state: stopped ? 'stopped' : fold.state,
    durationMs: elapsed,
    failed,
  })
  const phrase =
    live || paused
      ? liveNarration?.block.item.text ||
        model.narration ||
        (tail.lastRow?.kind === 'tools'
          ? toolSubject(tail.lastRow.blocks[0]!.item, Infinity)
          : undefined) ||
        model.eventPhrase
      : single && !failed && !stopped
        ? model.eventPhrase
        : lead
  const counts = !live && !paused && !single ? model.summary : ''
  const matching = props.search.filtering ? new Set(props.search.matches) : undefined
  const hits = matching
    ? fold.rows.reduce(
        (count, { row }) =>
          count +
          (row.kind === 'tools'
            ? row.blockIndices.filter((index) => matching.has(index)).length
            : Number(matching.has(row.blockIndex))),
        0,
      )
    : 0
  const current =
    live &&
    tail.lastRow?.kind === 'tools' &&
    tail.lastRow.blocks[0]?.result === undefined &&
    tail.lastRow.blocks[0]?.item.toolResult === undefined
      ? (toolSubject(tail.lastRow.blocks[0]!.item, Infinity) ?? tail.state?.detail)
      : undefined
  const from = parseTs(fold.startedAt),
    to = parseTs(fold.endedAt)
  const span = from ? `${clockLabel(from)}${to ? `–${clockLabel(to)}` : ''}` : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: these state transitions change fold geometry without changing its row identity.
  useLayoutEffect(() => {
    root.current?.closest('[data-feed-scroller]')?.dispatchEvent(new Event(FOLD_GEOMETRY_EVENT))
  }, [open, fold.rows.length, mode])
  const spokenLead =
    elapsed === undefined
      ? lead
      : `${failed ? 'Failed after' : stopped ? 'Stopped after' : 'Worked for'} ${spokenDuration(elapsed)}`
  const accessiblePhrase = !live && !paused && !single ? spokenLead : phrase
  const aria = `${accessiblePhrase}${counts ? `, ${counts}` : ''}${model.failures ? `, ${model.failures} failed` : ''}`
  return (
    <div
      className="transcript-row turn-line-row"
      data-turn-fold={fold.key}
      data-has-ask={fold.asks.size > 0 || undefined}
      data-row-key={
        model.row.kind === 'tools' ? model.row.blocks[0]!.item.id : model.row.block.item.id
      }
      data-row-aliases={
        props.chat ? undefined : JSON.stringify(model.members.map((member) => member.id))
      }
      data-block={open ? undefined : fold.start}
      ref={root}
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        <div
          className="work-line turn-line"
          data-state={mode}
          data-open={open ? 'true' : 'false'}
          data-testid="turn-line"
        >
          <button
            type="button"
            data-pressable
            data-transcript-run-toggle=""
            className="work-line-row"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={aria}
            onClick={() => state.toggle(fold.key)}
          >
            <span className="tl-mark" aria-hidden="true">
              <span className="tl-spin">{(live || retiringMark) && <WorkingMark size={15} />}</span>
              <span className="tl-stack">
                <WorkGlyph stretch={!single || live || paused} item={model.firstEvent?.item} />
              </span>
            </span>
            <Phrase
              text={phrase}
              query={
                props.search.filtering
                  ? (props.searchQuery ?? props.chat?.view.presentation.query ?? '')
                  : ''
              }
              code={
                (live || paused
                  ? !liveNarration && !model.narration
                  : single && !failed && !stopped) && model.firstEvent?.item.toolName === 'Bash'
              }
              phraseKey={
                live || paused
                  ? (liveNarration?.key ?? fold.narration ?? model.firstEvent?.item.id ?? fold.key)
                  : `${mode}:${phrase}`
              }
            >
              {counts && <span className="tl-counts"> · {counts}</span>}
              {!live && !paused && model.failures > 0 && (
                <span className="tl-bad">, {model.failures} failed</span>
              )}
            </Phrase>
            {(!singleWell || mode !== 'done') && (
              <ChevronRight
                className="work-line-chev"
                size={12}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            )}
            <span className="tl-meta">
              {props.search.filtering && hits > 0 && (
                <span className="tl-hits">
                  {hits} {hits === 1 ? 'hit' : 'hits'}
                </span>
              )}
              {live || paused ? (
                <>
                  <span className="tl-now">{current}</span>
                  <Clock start={fold.startedAt ?? tail.since} duration={elapsed} live={live} />
                </>
              ) : (
                <span className="tl-span">
                  {single
                    ? model.firstEvent?.item.durationMs !== undefined
                      ? formatWorkDuration(model.firstEvent.item.durationMs)
                      : span
                    : span}
                </span>
              )}
            </span>
          </button>
          <div id={listId} hidden={!open}>
            {open && (
              <TurnList
                model={model}
                props={props}
                live={live}
                singleWell={singleWell}
                newest={newest}
                primeSingle={single && fold.updates === 0 && state.isOpen(fold.key)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

function spokenDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ` : ''}${rest} ${rest === 1 ? 'second' : 'seconds'}`
}

function markPhrase(text: string, query: string): React.ReactNode {
  const needle = query.trim().toLowerCase()
  if (!needle) return text
  const parts: React.ReactNode[] = []
  let from = 0,
    at = text.toLowerCase().indexOf(needle)
  while (at >= 0) {
    parts.push(
      text.slice(from, at),
      <mark className="tl-phrase-hit" key={at}>
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    from = at + needle.length
    at = text.toLowerCase().indexOf(needle, from)
  }
  parts.push(text.slice(from))
  return parts
}

const TurnList = observer(function TurnList({
  model,
  props,
  live,
  singleWell,
  newest,
  primeSingle,
}: {
  model: PresentedTurn
  props: TranscriptFeedProps
  live: boolean
  singleWell: boolean
  newest: boolean
  primeSingle: boolean
}) {
  const durable = model.members
  const keys = new Set(durable.map((member) => member.key))
  const members = [
    ...durable,
    ...(newest ? previewMembers(props).filter((member) => !keys.has(member.key)) : []),
  ]
  const arriving = useFeedArrivals(members.map((member) => member.key))
  return (
    <div
      className={cn(
        'work-line-list work-line-list--timed turn-list',
        singleWell && 'turn-single-detail',
      )}
    >
      {members.map((member) => (
        <TurnEntry
          key={member.key}
          id={member.id}
          memberKey={member.key}
          index={member.index}
          snapshot={member.block}
          chat={props.chat}
          sessionId={props.sessionId}
          cwd={props.cwd}
          openFile={props.openFile}
          httpOrigin={props.httpOrigin}
          onOpenImage={props.onOpenImage}
          onQuote={props.onQuote}
          onAnswerAsk={props.onAnswerAsk}
          markdownHtml={
            member.block.item.role === 'system' ||
            (member.block.item.role === 'user' &&
              !transcriptActivityFacts(member.block.item).envelopes)
              ? props.markdownHtml
              : undefined
          }
          live={live}
          forceOpen={
            singleWell ||
            props.expandRuns === true ||
            (member.index >= 0 &&
              (member.blockIndex === props.search.activeMatch ||
                member.index === props.revealedRow))
          }
          arrived={arriving.has(member.key)}
          initialOpen={primeSingle && member.id === model.firstEvent?.item.id}
        />
      ))}
    </div>
  )
})

/** Pass the entry's actual inputs. A fresh feed props/member object on append
 * must not re-render every unchanged opened entry and reparse its markdown. */
const TurnEntry = observer(function TurnEntry({
  id,
  memberKey,
  index,
  snapshot,
  chat,
  sessionId,
  cwd,
  openFile,
  httpOrigin,
  onOpenImage,
  onQuote,
  onAnswerAsk,
  markdownHtml,
  live,
  forceOpen,
  arrived,
  initialOpen,
}: Pick<
  TranscriptFeedProps,
  | 'chat'
  | 'sessionId'
  | 'cwd'
  | 'openFile'
  | 'httpOrigin'
  | 'onOpenImage'
  | 'onQuote'
  | 'onAnswerAsk'
> & {
  markdownHtml?: ReadonlyMap<string, string> | undefined
  id: string
  memberKey: string
  index: number
  snapshot: import('@podium/client-core/values').ChatBlock
  live: boolean
  forceOpen: boolean
  arrived: boolean
  initialOpen: boolean
}) {
  const durable = chat?.view.presentation.block(id)
  const preview = durable ? undefined : chat?.view.previewMember?.(memberKey)?.block
  const block = durable ?? preview ?? snapshot
  const { item } = block
  const bodyClick = useCallback(
    (event: React.MouseEvent) => handleChatMdClick(event, sessionId, cwd, openFile),
    [sessionId, cwd, openFile],
  )
  const narration = item.role === 'assistant' && !item.answer
  const activity = item.role === 'tool' || transcriptActivityFacts(item).envelopes !== null
  const at = parseTs(item.ts)
  return (
    <div
      className={cn(
        'turn-entry',
        arrived && 'is-new',
        narration && 'tl-say',
        !activity && !narration && 'turn-entry-context',
      )}
      data-block={index >= 0 ? index : undefined}
      data-row-key={id}
      data-transcript-member-key={id}
      data-turn-preview={index < 0 || undefined}
      data-testid={(preview || index < 0) && narration ? 'streaming-text' : undefined}
    >
      {narration ? (
        <>
          {at && (
            <time className="quiet-time" dateTime={item.ts} title={fullTimeLabel(at)}>
              {clockLabel(at)}
            </time>
          )}
          <StableMarkdown
            html={renderMarkdown(item.text)}
            className={cn('chat-md', (preview || index < 0) && 'chat-md--streaming')}
            sessionId={sessionId}
            cwd={cwd}
            openFile={openFile}
          />
        </>
      ) : activity ? (
        <StretchMember
          block={block}
          ordinary
          timed
          live={
            live &&
            item.role === 'tool' &&
            block.result === undefined &&
            item.toolResult === undefined
          }
          forceOpen={forceOpen}
          initialOpen={initialOpen}
          onBodyClick={bodyClick}
          sessionId={sessionId}
          cwd={cwd}
          openFile={openFile}
        />
      ) : (
        <ChatBlockView
          block={block}
          index={index}
          markdownHtml={markdownHtml}
          highlighted={forceOpen}
          dimmed={false}
          sessionId={sessionId}
          cwd={cwd}
          httpOrigin={httpOrigin}
          onOpenImage={onOpenImage}
          openFile={openFile}
          onQuote={onQuote}
          askLivePending={false}
          onAnswerAsk={onAnswerAsk}
        />
      )}
    </div>
  )
})
