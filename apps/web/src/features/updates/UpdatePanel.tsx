/**
 * THE ONE PANEL (POD-2102, spec §6.1).
 *
 * One non-modal `aside` in the bottom-right corner — the position the old dialog
 * already had right — into which every state renders. It never becomes a toast,
 * a banner, or a second dialog, and it has exactly one dismiss verb: **Hide**,
 * which collapses it to the toolbar indicator and discards nothing (the update
 * lives on the server now, so there is nothing here to lose).
 *
 * ONE PRIMARY ACTION. The view model computes the single recommended action for
 * this surface and this state; this component renders it and does not choose.
 * The old dialog could show three co-equal primaries at once because each button
 * had its own reason to exist and nobody owned the question "which one should
 * this person press?" — the view model owns it now.
 *
 * THE READY CARD (POD-2338). With only this surface left to move, the same panel
 * narrows and loses its bands: one sentence, the notes behind "What's new", and the
 * buttons on one row. The title already names the version.
 */
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { type JSX, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { renderReadoutMarkdown } from '@/lib/markdown'
import type { UpdatePanelView } from './operation-view'
import type { ReloadHandshakeStatus } from './reload-handshake'
import type { Place, PlaceImpact } from './update-view'
import type { PanelActionKind } from './use-update-state'

export interface UpdatePanelProps {
  view: UpdatePanelView
  pending: PanelActionKind | null
  onAction: (kind: PanelActionKind) => void
  onHide: () => void
  reloadStatus?: ReloadHandshakeStatus
  onResetCachedInterface?: () => void
}

/** `0.2.1-dev.76+bcca0ff` reads as `0.2.1-dev.76 · bcca0ff`: the build hash is metadata. */
export function versionLine(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : `${version.slice(0, plus)} · ${version.slice(plus + 1)}`
}

const IMPACT_LABEL: Record<PlaceImpact, string> = {
  interrupts: 'Interrupts briefly',
  'needs-you': 'Needs you',
  background: 'Background only',
}

function ImpactDot({ impact }: { impact: PlaceImpact }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={
        impact === 'interrupts'
          ? 'mt-[6px] size-[7px] shrink-0 rounded-full bg-warning'
          : impact === 'needs-you'
            ? 'mt-[6px] size-[7px] shrink-0 rounded-full border-[1.5px] border-warning'
            : 'mt-[6px] size-[7px] shrink-0 rounded-full bg-muted-foreground/50'
      }
    />
  )
}

function PlaceList({ places }: { places: Place[] }): JSX.Element {
  const impacts = new Set(places.map((place) => place.impact ?? 'background'))
  return (
    <div className="flex flex-col gap-1.5">
      <ul
        className="flex flex-col divide-y divide-border/70 rounded-md border border-border/70 bg-muted/25"
        aria-label="Places affected by this update"
      >
        {places.map((place) => {
          const impact = place.impact ?? 'background'
          return (
            <li
              key={place.kind + place.label}
              data-impact={impact}
              className="flex items-start gap-2 px-3 py-2"
            >
              <ImpactDot impact={impact} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium break-words text-foreground">
                  {place.label}
                  {place.detail && (
                    <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                      {place.detail}
                    </span>
                  )}
                </span>
                <span className="text-[11px] leading-[1.45] text-muted-foreground">
                  <span className="sr-only">{IMPACT_LABEL[impact]}: </span>
                  {place.effect}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      {impacts.size > 1 && (
        <p
          aria-hidden="true"
          className="flex flex-wrap gap-x-3.5 gap-y-1 text-[10px] text-muted-foreground"
        >
          {(['interrupts', 'needs-you', 'background'] as const)
            .filter((impact) => impacts.has(impact))
            .map((impact) => (
              <span key={impact} className="inline-flex items-center gap-1.5">
                <ImpactDot impact={impact} />
                <span>{IMPACT_LABEL[impact]}</span>
              </span>
            ))}
        </p>
      )}
    </div>
  )
}

function StepList({ view }: { view: UpdatePanelView }): JSX.Element | null {
  if (view.steps.length === 0) return null
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Update steps">
      {view.steps.map((step) => (
        <li
          key={step.id}
          data-step={step.id}
          data-state={step.state}
          className="flex items-start gap-2 text-[11px] leading-[1.5]"
        >
          <span
            aria-hidden="true"
            className={
              step.state === 'done'
                ? 'mt-[3px] text-primary'
                : step.state === 'failed'
                  ? 'mt-[3px] text-destructive'
                  : step.state === 'current' || step.state === 'stalled'
                    ? 'mt-[3px] text-foreground'
                    : 'mt-[3px] text-muted-foreground/60'
            }
          >
            {step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : '•'}
          </span>
          <span className="flex flex-col gap-0.5">
            <span
              className={
                step.state === 'pending'
                  ? 'text-muted-foreground/70'
                  : step.state === 'current' || step.state === 'stalled'
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground'
              }
            >
              {step.title}
            </span>
            {step.substatus && (
              <span className="text-[10px] text-muted-foreground">{step.substatus}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * RELEASE NOTES, AS MUCH AS FITS. The notes are the changelog section the release shipped with,
 * so they are Markdown: a headline, headings, bold-led bullets. They render as a readout (no
 * anchors; the panel owns the one link out) and take whatever height the panel has left after
 * the states above them, fading out where they are cut. "Show all" lets them take their full
 * height, and the panel body scrolls; a stable release also links to its GitHub page, which
 * carries the same text.
 */
export function ReleaseNotes({ summary, url }: { summary?: string; url?: string }): JSX.Element {
  const html = useMemo(() => (summary ? renderReadoutMarkdown(summary.trim()) : ''), [summary])
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const bodyId = useId()
  // biome-ignore lint/correctness/useExhaustiveDependencies: new notes can overflow a box whose size never changes, so re-measure on them
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || open) return
    const measure = () => setCut(body.scrollHeight > body.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [html, open])
  return (
    <section
      data-testid="update-notes"
      aria-label="Release notes"
      className={open ? 'flex shrink-0 flex-col gap-1.5' : 'flex min-h-28 shrink flex-col gap-1.5'}
    >
      {html && (
        <div
          ref={bodyRef}
          id={bodyId}
          className="update-notes min-h-0 flex-1"
          data-open={open}
          data-cut={!open && cut}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderReadoutMarkdown sanitizes through DOMPurify and drops every anchor
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {((html && (cut || open)) || url) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {html && (cut || open) && (
            <button
              type="button"
              data-testid="update-notes-toggle"
              className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Show less' : 'Show all'}
              {open ? (
                <ChevronUp size={11} aria-hidden="true" />
              ) : (
                <ChevronDown size={11} aria-hidden="true" />
              )}
            </button>
          )}
          {url && (
            <a
              data-testid="update-notes-link"
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-3 hover:underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {html ? 'Release page' : "What's new"}
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
    </section>
  )
}

/** The ready card's way to the notes: they unfold in place, or a link when only a page exists. */
function WhatsNew({
  notes,
  open,
  controls,
  onToggle,
}: {
  notes: UpdatePanelView['notes']
  open: boolean
  controls: string
  onToggle: () => void
}): JSX.Element {
  const className =
    'inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground'
  if (notes?.summary) {
    return (
      <button
        type="button"
        data-testid="update-whats-new"
        className={className}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        What's new
        {open ? (
          <ChevronUp size={12} aria-hidden="true" />
        ) : (
          <ChevronDown size={12} aria-hidden="true" />
        )}
      </button>
    )
  }
  if (notes?.url) {
    return (
      <a
        data-testid="update-whats-new"
        className={className}
        href={notes.url}
        target="_blank"
        rel="noreferrer"
      >
        What's new
        <ExternalLink size={11} aria-hidden="true" />
      </a>
    )
  }
  return <span />
}

export function UpdatePanel({
  view,
  pending,
  onAction,
  onHide,
  reloadStatus,
  onResetCachedInterface,
}: UpdatePanelProps): JSX.Element | null {
  const [notesOpen, setNotesOpen] = useState(false)
  const notesId = useId()
  if (view.state === 'none') return null

  const ready = view.state === 'waiting-you' && view.primary !== undefined
  const hasNotes = Boolean(view.notes?.summary || view.notes?.url)

  return (
    <aside
      data-testid="update-panel"
      data-state={view.state}
      role="dialog"
      aria-modal="false"
      aria-label="Podium update"
      className={`fixed right-4 bottom-9 z-50 flex ${ready ? 'w-[min(24rem,calc(100vw-2rem))]' : 'w-[min(28rem,calc(100vw-2rem))]'} max-h-[min(42rem,calc(100vh-4rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)]`}
    >
      <div
        className={
          ready
            ? 'flex shrink-0 flex-col gap-1 px-4 pt-4 pb-3'
            : 'flex shrink-0 flex-col gap-0.5 border-b border-border px-4 pt-4 pb-3'
        }
      >
        <h2
          className={`${ready ? 'text-[15px]' : 'text-[14px]'} font-semibold tracking-[-0.01em] break-words`}
        >
          {view.title}
        </h2>
        {view.version && !ready && (
          <p
            data-testid="update-version"
            className="font-mono text-[10.5px] break-all text-muted-foreground/80"
          >
            {versionLine(view.version)}
          </p>
        )}
        {view.subtitle && (
          <p
            className={`${ready ? 'text-[13px]' : 'text-[11px]'} leading-[1.5] text-muted-foreground`}
          >
            {view.subtitle}
          </p>
        )}
      </div>

      {/*
        The body takes the height left between header and footer. Everything in it keeps its
        natural height except the release notes, which shrink to what is left; when even that
        is not enough (or the notes are shown in full), the body scrolls.
      */}
      <div
        id={ready ? notesId : undefined}
        className={
          ready
            ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3 empty:hidden'
            : 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4'
        }
      >
        {/* The offer's place rows: what this update touches, ordered by how much you'll notice. */}
        {view.places && view.places.length > 0 && <PlaceList places={view.places} />}

        <StepList view={view} />

        {/* LIVENESS IS NEVER OPTIONAL while something is running (P4). */}
        {view.liveness && (
          <p
            data-testid="update-liveness"
            className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase"
          >
            {view.stepPosition && view.steps.length > 0
              ? `Step ${view.stepPosition.current} of ${view.stepPosition.total} · ${view.liveness}`
              : view.liveness}
          </p>
        )}

        {view.reason && (
          <p className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-[1.5] text-destructive">
            {view.reason}
          </p>
        )}

        {/* §7's three layers: what happened, the one next action, folded detail. */}
        {view.error && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] leading-[1.5] text-muted-foreground">{view.error.message}</p>
            <p className="text-[11px] leading-[1.5] text-foreground">{view.error.nextAction}</p>
            {view.error.detail && (
              <details className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-[11px]">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  Technical details
                </summary>
                <pre className="mt-2 font-mono text-[10px] leading-[1.5] whitespace-pre-wrap text-muted-foreground">
                  {view.error.detail}
                </pre>
              </details>
            )}
          </div>
        )}

        {view.awaitingElsewhere.map((ask) => (
          <p key={ask} className="text-[11px] leading-[1.5] text-muted-foreground">
            {ask}
          </p>
        ))}

        {view.deferredNote && view.state !== 'done' && (
          <p className="text-[11px] leading-[1.5] text-muted-foreground">{view.deferredNote}</p>
        )}

        {view.primary?.consequence && (
          <p className="text-[11px] leading-[1.5] text-muted-foreground">
            {view.primary.consequence}
          </p>
        )}

        {view.note && (
          <p className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-[11px] leading-[1.5] text-muted-foreground">
            {view.note}
          </p>
        )}

        {reloadStatus && (
          <div
            data-testid="service-worker-status"
            role="status"
            className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-[11px] leading-[1.5]"
          >
            <p className="font-medium text-foreground">{reloadStatus.message}</p>
            {reloadStatus.detail && (
              <p className="mt-1 text-muted-foreground">{reloadStatus.detail}</p>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">
                Service-worker state
              </summary>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                controller={reloadStatus.snapshot.controller ?? 'none'} · active=
                {reloadStatus.snapshot.active ?? 'none'} · installing=
                {reloadStatus.snapshot.installing ?? 'none'} · waiting=
                {reloadStatus.snapshot.waiting ?? 'none'}
              </p>
            </details>
            {reloadStatus.canReset && onResetCachedInterface && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="reset-cached-interface"
                className="mt-2"
                onClick={onResetCachedInterface}
              >
                Reset cached interface
              </Button>
            )}
          </div>
        )}

        {hasNotes && !ready && <ReleaseNotes summary={view.notes?.summary} url={view.notes?.url} />}
        {ready && notesOpen && view.notes?.summary && (
          <div className="flex min-h-0 shrink flex-col border-t border-border pt-3">
            <ReleaseNotes summary={view.notes.summary} url={view.notes.url} />
          </div>
        )}
      </div>

      <div
        className={
          ready
            ? 'flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-4'
            : 'flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-3'
        }
      >
        {/*
          ONE DISMISS BUTTON (§6.1). It collapses to the indicator and discards
          nothing. Later while the update can still come back for the user;
          Close once it is over, since hiding a failure acknowledges it.
        */}
        {ready ? (
          <WhatsNew
            notes={view.notes}
            open={notesOpen}
            controls={notesId}
            onToggle={() => setNotesOpen(!notesOpen)}
          />
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={onHide}>
            {view.state === 'done' || view.state === 'failed' ? 'Close' : 'Later'}
          </Button>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {ready && (
            <Button type="button" variant="ghost" size="sm" onClick={onHide}>
              Later
            </Button>
          )}
          {view.cancel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              pending={pending === 'cancel'}
              pendingLabel="Canceling…"
              onClick={() => onAction('cancel')}
            >
              {view.cancel.label}
            </Button>
          )}
          {view.primary && (
            <Button
              type="button"
              size="sm"
              data-testid="update-primary"
              pending={pending === view.primary.kind}
              pendingLabel={view.primary.pendingLabel}
              onClick={() => {
                if (view.primary) onAction(view.primary.kind)
              }}
            >
              {view.primary.label}
            </Button>
          )}
        </div>
      </div>
    </aside>
  )
}
