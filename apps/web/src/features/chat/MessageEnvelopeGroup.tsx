import {
  envelopePrincipal,
  isOperatorQuestion,
  type ParsedEnvelope,
  pointerFallbackBody,
  principalShortName,
} from '@podium/client-core/values'
import { ChevronRight } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { memo, useMemo, useState } from 'react'
import { renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import { isKnownRefPrefix } from '@/lib/markdown-references'
import { useKnownRefPrefixesVersion } from '@/lib/use-known-ref-prefixes'
import { useMailBody } from './mail-body'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'
import { WorkGlyph } from './WorkGlyph'

function PrincipalLabel({ label }: { label: string }): JSX.Element {
  const p = envelopePrincipal(label.startsWith('system:') ? principalShortName(label) : label)
  const chip = p.ref !== null && isKnownRefPrefix(p.ref.split('-')[0] ?? '')
  return (
    <>
      {p.ref === null && p.pre}
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

/** The first line supplies the subject. The opened body keeps its markdown. */
function splitSubject(body: string): { subject: string; detail: string } {
  const [first = '', ...rest] = body.trim().split('\n')
  return {
    subject: first
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\*\*(.*)\*\*$/, '$1')
      .replace(/^`(.*)`$/, '$1'),
    detail: rest.join('\n').trim(),
  }
}

/** Identical HTML must not replace text nodes while a reader selects a note. */
const StableEnvelopeMarkdown = memo(function StableEnvelopeMarkdown({ html }: { html: string }) {
  return (
    <div
      className="chat-md mail-item-body"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized before this boundary
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

function EnvelopeBody({
  body,
  markdownHtml,
}: {
  body: string
  markdownHtml?: ReadonlyMap<string, string> | undefined
}): JSX.Element | null {
  const cached = markdownHtml?.get(body)
  const refPrefixesVersion = useKnownRefPrefixesVersion()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ref-prefix registry changes markdown linkification.
  const html = useMemo(
    () => (cached === undefined ? renderMarkdown(body) : sanitizeRenderedMarkdown(cached)),
    [cached, body, refPrefixesVersion],
  )
  return body ? <StableEnvelopeMarkdown html={html} /> : null
}

/** Mount only after disclosure, so folded pointers never fetch their bodies. */
function PointerEnvelopeBody({ envelope }: { envelope: ParsedEnvelope }): JSX.Element {
  const mail = useMailBody(envelope.id)
  const body =
    mail.status === 'ready'
      ? mail.body
      : mail.status === 'loading'
        ? envelope.body || 'Loading…'
        : mail.status === 'denied'
          ? "You can't view this message\nOnly its sender, its recipients and an admin can open it."
          : 'Could not load this message'
  const known = splitSubject(envelope.body).subject
  const fetched = splitSubject(body)
  const detail = known && fetched.subject === known ? fetched.detail : body
  return (
    <>
      <EnvelopeBody body={detail} />
      {mail.status === 'error' && (
        <button data-pressable type="button" className="mail-item-retry" onClick={mail.retry}>
          Retry
        </button>
      )}
    </>
  )
}

function EnvelopeItem({
  envelope,
  forceOpen,
  direction,
  ts,
  timed,
  markdownHtml,
  onReply,
}: {
  envelope: ParsedEnvelope
  forceOpen: boolean
  direction: 'from' | 'to'
  ts?: string | undefined
  timed: boolean
  markdownHtml?: ReadonlyMap<string, string> | undefined
  onReply?: ((envelope: ParsedEnvelope) => void) | undefined
}): JSX.Element {
  const [opened, setOpened] = useState(false)
  const full = opened || forceOpen
  const { subject, detail } = useMemo(() => splitSubject(envelope.body), [envelope.body])
  const ask = isOperatorQuestion(envelope)
  const who = principalShortName(direction === 'from' ? envelope.from : envelope.to)
  const stamp = timed ? parseTs(ts) : undefined
  const toggle = (): void => setOpened((v) => !v)
  const phrase = subject || (direction === 'from' ? `Note from ${who}` : `Note to ${who}`)
  return (
    <div
      className={ask ? 'mail-question' : 'work-line mail-item mail-group'}
      data-transcript-retain={opened ? '' : undefined}
      data-transcript-run-view={forceOpen && !opened ? '' : undefined}
      data-open={full ? 'true' : 'false'}
      data-full={full ? 'true' : undefined}
      data-testid="mail-item"
    >
      {stamp && (
        <time className="quiet-time" dateTime={ts} title={fullTimeLabel(stamp)}>
          {clockLabel(stamp)}
        </time>
      )}
      {ask ? (
        <div className="quiet-ask">
          <span className="quiet-ask-dot" aria-hidden="true" />
          <button
            data-pressable
            type="button"
            className="quiet-ask-text"
            data-transcript-run-toggle={forceOpen && !opened ? '' : undefined}
            aria-expanded={full}
            onClick={toggle}
          >
            <b>{principalShortName(envelope.from)}</b> asks {subject || 'a question'}
          </button>
          <button
            data-pressable
            type="button"
            className="quiet-ask-reply"
            onClick={() => {
              setOpened(true)
              onReply?.(envelope)
            }}
          >
            Reply
          </button>
        </div>
      ) : (
        <button
          data-pressable
          type="button"
          className="work-line-row mail-item-head"
          data-transcript-run-toggle={forceOpen && !opened ? '' : undefined}
          data-testid="message-envelope-toggle"
          aria-expanded={full}
          aria-label={`${full ? 'Fold' : 'Unfold'} ${phrase}`}
          onClick={toggle}
        >
          <span className="work-line-glyph" aria-hidden="true">
            <WorkGlyph mail />
          </span>
          <span className="work-line-phrase">
            {subject ? (
              <>
                <span className="work-line-who">
                  {direction === 'to' && 'To '}
                  {who}
                </span>
                {'  '}
                {subject}
              </>
            ) : (
              phrase
            )}
          </span>
        </button>
      )}
      {full && (
        <div className="mail-item-detail">
          {envelope.pointer === 'by-id' ? (
            <PointerEnvelopeBody envelope={envelope} />
          ) : (
            <EnvelopeBody
              body={envelope.pointer ? pointerFallbackBody(envelope) : detail}
              markdownHtml={markdownHtml}
            />
          )}
          {envelope.machineNote && <span className="mail-item-note">{envelope.machineNote}</span>}
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
            {envelope.expectsReply && ' · reply requested'}
          </span>
        </div>
      )}
    </div>
  )
}

/** Notes render bare inside a stretch; only the owning row has feed identity. */
export function MessageEnvelopeGroup({
  envelopes,
  className = '',
  blockIndex,
  rowKey,
  markdownHtml,
  ts,
  onBodyClick,
  forceOpen = false,
  direction = 'from',
  bare = false,
  onReply,
}: {
  envelopes: readonly ParsedEnvelope[]
  className?: string
  blockIndex?: number | undefined
  rowKey?: string | undefined
  markdownHtml?: ReadonlyMap<string, string> | undefined
  ts?: string | undefined
  onBodyClick: (e: ReactMouseEvent) => void
  forceOpen?: boolean
  direction?: 'from' | 'to'
  bare?: boolean
  onReply?: ((envelope: ParsedEnvelope) => void) | undefined
}): JSX.Element {
  const [userOpen, setUserOpen] = useState(false)
  const open = userOpen || forceOpen
  const notes = envelopes.filter((e) => !isOperatorQuestion(e))
  const questions = envelopes.filter(isOperatorQuestion)
  const item = (envelope: ParsedEnvelope, i: number, timed: boolean): ReactNode => (
    <EnvelopeItem
      key={envelope.id}
      envelope={envelope}
      forceOpen={forceOpen}
      direction={direction}
      ts={i === 0 ? ts : undefined}
      timed={timed}
      markdownHtml={markdownHtml}
      onReply={onReply}
    />
  )
  const content = (
    <>
      {bare || notes.length === 1 ? (
        notes.map((e, i) => item(e, i, bare))
      ) : notes.length > 1 ? (
        <div
          className="work-line mail-group"
          data-open={open ? 'true' : 'false'}
          data-transcript-run-view={forceOpen && !userOpen ? '' : undefined}
        >
          <button
            data-pressable
            type="button"
            className="work-line-row mail-fold"
            data-transcript-run-toggle={forceOpen && !userOpen ? '' : undefined}
            data-testid="message-envelope-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Fold' : 'Unfold'} these notes`}
            onClick={() => setUserOpen((v) => !v)}
          >
            <span className="work-line-glyph" aria-hidden="true">
              <WorkGlyph stretch />
            </span>
            <span className="work-line-phrase">
              {direction === 'from' ? 'Read' : 'Sent'} {notes.length} notes
            </span>
            <ChevronRight
              className="work-line-chev"
              size={12}
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </button>
          {open && (
            <div className="work-line-list work-line-list--timed mail-card">
              {notes.map((e, i) => item(e, i, true))}
            </div>
          )}
        </div>
      ) : null}
      {questions.map((e, i) => item(e, i, false))}
    </>
  )
  const body = (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegated clicks activate only semantic links in sanitized markdown and route chips.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users activate those anchors natively.
    <div className={bare ? 'mail-members' : 'transcript-body'} onClick={onBodyClick}>
      {content}
    </div>
  )
  return bare ? (
    body
  ) : (
    <div
      className={className}
      data-block={blockIndex}
      data-row-key={rowKey}
      data-internal-message="true"
      data-testid="message-envelope"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      {body}
    </div>
  )
}
