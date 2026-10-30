/**
 * PODIUM'S OWN MAIL, FOLDED TO ONE LINE (POD-993).
 *
 * System mail is provenance: a reader scanning a conversation needs to see THAT
 * one arrived and from whom, not the paragraph. Each frame used to be its own
 * row with its own header, so a turn receiving three notes spent three rows
 * before the answer got a word in.
 *
 * The whole burst is now ONE object — a quiet line like a tool run's (POD-2234,
 * POD-2286): "steward · Merge lock released" for one note, "3 notes from
 * steward" for a burst, opening into the same timed list a run of calls opens
 * into. See `.mail-group` in styles.css for what differs and why.
 *
 * NOTHING OPENS ON ARRIVAL (POD-2070): a question or reply request binds the
 * receiving agent, not the reader, so the fold line only flags it.
 * WHAT IS NOT LOST: the two-line preview is a preview — clicking an item opens
 * that frame's full markdown, refs and code live.
 *
 * AN INBOX POINTER IS A NOTE TOO (POD-2143): an oversized mail reaches the agent
 * as one line naming its id, so its item fetches the body when the card opens.
 */
import {
  envelopePrincipal,
  type ParsedEnvelope,
  pointerFallbackBody,
  principalShortName,
} from '@podium/client-core/values'
import { ChevronDown, Mail as MailIcon } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { memo, useMemo, useState } from 'react'
import { renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import { isKnownRefPrefix } from '@/lib/markdown-references'
import { useKnownRefPrefixesVersion } from '@/lib/use-known-ref-prefixes'
import { useMailBody } from './mail-body'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

/** An envelope-header principal: the nice-id issue ref renders as the same
 *  clickable ref-link chip the markdown pass emits, so the sender/recipient are
 *  as navigable as refs in the body. Legacy `#seq` labels and sessions stay
 *  plain text. */
function PrincipalLabel({ label }: { label: string }): JSX.Element {
  const p = envelopePrincipal(label)
  const chip = p.ref !== null && isKnownRefPrefix(p.ref.split('-')[0] ?? '')
  return (
    <>
      {p.pre}
      {p.ref !== null &&
        (chip ? (
          <a className="ref-link ref-link--issue" href={`#${p.ref}`} data-ref={p.ref}>
            {p.ref}
          </a>
        ) : (
          p.ref
        ))}
      {p.post}
    </>
  )
}

/** First line of a frame as a subject, and the rest as a preview.
 *
 * Mail in this system has no subject field — the sender writes a body — so the
 * subject is taken the way every mail client takes it when there is none: the
 * first line stands in for one. The markers a first line might carry (a heading
 * hash, bold, a list bullet) are stripped, because they are formatting for a
 * paragraph, not for a title. */
function splitSubject(body: string): { subject: string; preview: string } {
  const lines = body.trim().split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const first = (lines[i] ?? '').trim()
  const subject = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^`(.*)`$/, '$1')
  const preview = lines
    .slice(i + 1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { subject, preview }
}

/** Mail bodies are transcript DOM islands too. The surrounding group may
 * rerender when another block is indexed, but identical HTML must not be
 * assigned again or the browser loses a selection inside the opened note. */
const StableEnvelopeMarkdown = memo(function StableEnvelopeMarkdown({ html }: { html: string }) {
  return (
    <div
      className="chat-md mail-item-body"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized before this boundary
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

/** A pointer's item: the body the agent was not typed, fetched by id. A sent
 *  note's preview, when it has one, stands in while the body loads. */
function PointerEnvelopeItem(props: {
  envelope: ParsedEnvelope
  forceFull?: boolean
  direction: 'from' | 'to'
  ts?: string | undefined
}): JSX.Element {
  const mail = useMailBody(props.envelope.id)
  const body =
    mail.status === 'ready'
      ? mail.body
      : mail.status === 'loading'
        ? props.envelope.body || 'Loading…'
        : mail.status === 'denied'
          ? "You can't view this message\nOnly its sender, its recipients and an admin can open it."
          : 'Could not load this message'
  return (
    <EnvelopeItem
      {...props}
      body={body}
      footer={
        mail.status === 'error' && (
          <button data-pressable type="button" className="mail-item-retry" onClick={mail.retry}>
            Retry
          </button>
        )
      }
    />
  )
}

function EnvelopeItem({
  envelope,
  body = envelope.body,
  markdownHtml,
  forceFull = false,
  footer,
  direction,
  ts,
}: {
  envelope: ParsedEnvelope
  /** The burst's arrival time, for the opened list's gutter (POD-2286). Only
   *  the first note carries it: a burst arrives at one moment. */
  ts?: string | undefined
  /** Which party the left column names: the sender, or the recipient of a
   *  note this session sent. */
  direction: 'from' | 'to'
  /** The body when the frame did not carry it (an inbox pointer). */
  body?: string
  /** An action under the body, such as retrying a failed load. */
  footer?: ReactNode
  markdownHtml?: ReadonlyMap<string, string> | undefined
  /** The active search hit: the matched word may be anywhere in the body, so
   *  the preview is not enough. */
  forceFull?: boolean
}): JSX.Element {
  const [opened, setOpened] = useState(false)
  const full = opened || forceFull
  const setFull = setOpened
  const { subject, preview } = useMemo(() => splitSubject(body), [body])
  const stamp = parseTs(ts)
  const cachedHtml = markdownHtml?.get(body)
  const refPrefixesVersion = useKnownRefPrefixesVersion()
  // biome-ignore lint/correctness/useExhaustiveDependencies: refPrefixesVersion is a deliberate recompute trigger — linkifyRefs reads the prefix registry.
  const html = useMemo(() => {
    if (!full) return ''
    return cachedHtml === undefined ? renderMarkdown(body) : sanitizeRenderedMarkdown(cachedHtml)
    // Ref chips are state-free transcript content (see ChatBlockView); only the
    // prefix registry arriving re-renders them (POD-4966).
  }, [cachedHtml, body, full, refPrefixesVersion])
  return (
    <div className="mail-item" data-testid="mail-item" data-full={full ? 'true' : undefined}>
      {stamp && (
        <time className="quiet-time" dateTime={ts} title={fullTimeLabel(stamp)}>
          {clockLabel(stamp)}
        </time>
      )}
      <button
        data-pressable
        type="button"
        className="mail-item-head"
        aria-expanded={full}
        onClick={() => {
          setFull((v) => !v)
        }}
      >
        <span className="mail-item-subject">{subject || envelope.id}</span>
        {envelope.question && <span className="mail-item-badge">question</span>}
      </button>
      {full ? (
        <StableEnvelopeMarkdown html={html} />
      ) : (
        preview !== '' && <span className="mail-item-preview">{preview}</span>
      )}
      {full && envelope.machineNote && (
        <span className="mail-item-note">{envelope.machineNote}</span>
      )}
      {/* The route the card header used to carry, per note: in a burst from
          several senders each note names its own (POD-2234). */}
      <span className="mail-item-route">
        {direction === 'from' ? (
          <>
            <PrincipalLabel label={envelope.from} />
            {envelope.to && <span className="mail-item-arrow">→</span>}
            {envelope.to && <PrincipalLabel label={envelope.to} />}
          </>
        ) : (
          <>
            to <PrincipalLabel label={envelope.to} />
          </>
        )}
      </span>
      {envelope.expectsReply && <span className="mail-item-reply">reply · {envelope.id}</span>}
      {footer}
    </div>
  )
}

export function MessageEnvelopeGroup({
  envelopes,
  className,
  blockIndex,
  markdownHtml,
  ts,
  onBodyClick,
  forceOpen = false,
  direction = 'from',
}: {
  envelopes: readonly ParsedEnvelope[]
  className: string
  blockIndex?: number | undefined
  markdownHtml?: ReadonlyMap<string, string> | undefined
  ts?: string | undefined
  /** Delegated chat-md click handling (code copy, ref chips, file links). */
  onBodyClick: (e: ReactMouseEvent) => void
  /** THE SEARCH HIT MUST BE VISIBLE. Search matches a block on its full text,
   *  including the body of a frame this group has folded away — so a hit inside
   *  mail would scroll the reader to a two-line preview that does not contain
   *  the word they searched for. The active hit unfolds the whole group and
   *  every frame in it, the same way a run of tool calls unfolds. */
  forceOpen?: boolean
  /** Whose notes these are: mail that arrived (`from`, names the senders) or
   *  mail this session sent (`to`, names the recipients). */
  direction?: 'from' | 'to'
}): JSX.Element {
  // ALWAYS FOLDED ON ARRIVAL (POD-2070). A question or a reply request in agent
  // mail binds the RECEIVING AGENT, not the person reading the chat, so opening
  // the card for it put a box in front of the reader for something they had
  // nothing to do about. The fold line names the ask instead.
  const [userOpen, setUserOpen] = useState(false)
  const open = userOpen || forceOpen
  const toggle = (): void => setUserOpen((o) => !o)
  const flag = envelopes.some((e) => e.question)
    ? 'question'
    : envelopes.some((e) => e.expectsReply)
      ? 'reply asked'
      : undefined
  const single = envelopes.length === 1
  const stamp = parseTs(ts)
  const count = envelopes.length
  const noun = single ? 'Note' : `${count} notes`
  // Distinct short senders, in arrival order: "Note from steward",
  // "2 notes from POD-84 · POD-90".
  const names = [
    ...new Set(envelopes.map((e) => principalShortName(direction === 'from' ? e.from : e.to))),
  ].join(' · ')
  // ONE NOTE NAMES ITS SUBJECT (POD-2286): "steward · Merge lock released"
  // says what arrived; "Note from steward" only says that something did. A
  // pointer's body is fetched on open, so it keeps the generic line.
  const lone = single ? envelopes[0] : undefined
  const loneSubject = lone && lone.pointer !== 'by-id' ? splitSubject(lone.body).subject : ''
  const foldLabel = loneSubject
    ? direction === 'from'
      ? `${names} · ${loneSubject}`
      : `To ${names} · ${loneSubject}`
    : `${noun} ${direction} ${names}`

  return (
    <div
      className={className}
      data-block={blockIndex}
      data-internal-message="true"
      data-testid="message-envelope"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        {/* THE TOOL RUN'S LINE (POD-2234, POD-2286): a note is a quiet line like a
            run of calls — the same glyph slot, trailing time and chevron — told
            apart by its mail glyph. The row is the only toggle. */}
        <div className="work-line mail-group" data-open={open ? 'true' : 'false'}>
          <button
            data-pressable
            type="button"
            className="work-line-row mail-fold"
            data-testid="message-envelope-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Fold' : 'Unfold'} these notes${flag ? `, ${flag}` : ''}`}
            onClick={toggle}
          >
            <span className="work-line-glyph mail-fold-glyph" aria-hidden="true">
              <MailIcon size={13} />
            </span>
            <span className="work-line-phrase">
              {foldLabel}
              {flag && <span className="mail-fold-flag">· {flag}</span>}
            </span>
            {stamp && (
              <time className="work-line-time" dateTime={ts} title={fullTimeLabel(stamp)}>
                {clockLabel(stamp)}
              </time>
            )}
            <ChevronDown className="work-line-chev" size={11} aria-hidden="true" />
          </button>
          {open && (
            // biome-ignore lint/a11y/noStaticElementInteractions: delegated clicks activate only semantic links — the route chips and the anchors sanitized markdown emits
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users activate those anchors natively
            <div className="work-line-list work-line-list--timed mail-card" onClick={onBodyClick}>
              {envelopes.map((envelope, i) =>
                envelope.pointer === 'by-id' ? (
                  <PointerEnvelopeItem
                    key={envelope.id}
                    envelope={envelope}
                    forceFull={forceOpen}
                    direction={direction}
                    ts={i === 0 ? ts : undefined}
                  />
                ) : (
                  <EnvelopeItem
                    key={envelope.id}
                    envelope={envelope}
                    body={envelope.pointer ? pointerFallbackBody(envelope) : envelope.body}
                    markdownHtml={markdownHtml}
                    forceFull={forceOpen}
                    direction={direction}
                    ts={i === 0 ? ts : undefined}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
