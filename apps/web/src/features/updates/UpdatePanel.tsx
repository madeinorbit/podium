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
 */
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { type JSX, useEffect, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { UpdatePanelView } from './operation-view'
import { ReleaseNotes, ReleaseNotesLede, releaseNotesContent } from './ReleaseNotes'
import type { ReloadHandshakeStatus } from './reload-handshake'
import { UpdateCardHeader, UpdateCommitList, UpdateScrollArea } from './UpdateCardParts'
import type { Place, PlaceImpact } from './update-view'
import type { PanelActionKind } from './use-update-state'

export { ReleaseNotes } from './ReleaseNotes'

export interface UpdatePanelProps {
  view: UpdatePanelView
  pending: PanelActionKind | null
  onAction: (kind: PanelActionKind) => void
  onHide: () => void
  reloadStatus?: ReloadHandshakeStatus
  onResetCachedInterface?: () => void
  /** Pause the parent's done timer while the panel is being read. */
  onReadingChange?: (reading: boolean) => void
}

export function versionLine(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : `${version.slice(0, plus)} · ${version.slice(plus + 1)}`
}

const IMPACT_LABEL: Record<PlaceImpact, string> = {
  interrupts: 'Interrupts briefly',
  'needs-you': 'Needs you',
  background: 'Background only',
}

function PlaceList({ places }: { places: Place[] }): JSX.Element {
  return (
    <ul className="update-card-places" aria-label="Places affected by this update">
      {places.map((place) => {
        const impact = place.impact ?? 'background'
        return (
          <li key={place.kind + place.label} data-impact={impact}>
            <i
              className="update-card-dot"
              data-kind={place.kind === 'database' ? 'data' : impact}
              aria-hidden="true"
            />
            <div>
              <b>{place.label}</b>
              {place.detail && <span className="update-card-place-detail">{place.detail}</span>}
              <span className="sr-only">{IMPACT_LABEL[impact]}: </span>
              <span> {place.effect}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ImpactDetails({ view }: { view: UpdatePanelView }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!view.places?.length) return null
  return (
    <div className="update-card-impact">
      <div className="update-card-impact-row">
        {(view.impactSummary ?? []).map((item) => (
          <span key={item.label} className="update-card-impact-item">
            <i className="update-card-dot" data-kind={item.kind} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          Details <ChevronDown size={10} aria-hidden="true" />
        </button>
      </div>
      <div id={id} hidden={!open}>
        <PlaceList places={view.places} />
      </div>
    </div>
  )
}

function StepList({ view }: { view: UpdatePanelView }): JSX.Element | null {
  if (!view.steps.length) return null
  return (
    <ol className="update-card-steps" aria-label="Update steps">
      {view.steps.map((step) => (
        <li key={step.id} data-step={step.id} data-state={step.state}>
          <span className="update-card-glyph" aria-hidden="true">
            {step.state === 'done' ? (
              <Check size={12} />
            ) : step.state === 'failed' ? (
              <X size={12} />
            ) : (
              <i />
            )}
          </span>
          <div>
            <div className="update-card-step-title">{step.title}</div>
            {step.substatus && <div className="update-card-substatus">{step.substatus}</div>}
            {step.percent !== undefined && (
              <div
                className="update-card-meter"
                role="progressbar"
                aria-label={step.title}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={step.percent}
              >
                <i style={{ width: `${step.percent}%` }} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function DevOfferContent({
  view,
  onRead,
}: {
  view: UpdatePanelView
  onRead: () => void
}): JSX.Element {
  const [tab, setTab] = useState<'commits' | 'notes'>('commits')
  const id = useId()
  const count = view.commitCount ?? view.commits?.length
  return (
    <>
      <div
        className="update-card-bar"
        role="tablist"
        aria-label="Development release details"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 'commits'
              : event.key === 'End'
                ? 'notes'
                : tab === 'commits'
                  ? 'notes'
                  : 'commits'
          setTab(next)
          document.getElementById(`${id}-${next}`)?.focus()
        }}
      >
        {(['commits', 'notes'] as const).map((name) => (
          <button
            type="button"
            role="tab"
            key={name}
            id={`${id}-${name}`}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            aria-controls={`${id}-content`}
            onClick={() => setTab(name)}
          >
            {name === 'commits' ? (
              <>
                Commits{count !== undefined && <span className="update-card-count">({count})</span>}
              </>
            ) : (
              <>
                Notes <span className="update-card-count">Unreleased</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className="update-card-tab-content" id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
        {tab === 'commits' ? (
          <UpdateScrollArea labelledBy={`${id}-commits`} onRead={onRead}>
            {view.commits ? (
              <UpdateCommitList commits={view.commits} total={view.commitCount} />
            ) : (
              <p className="update-card-empty">Commit history isn't available for this build.</p>
            )}
          </UpdateScrollArea>
        ) : (
          <ReleaseNotes
            summary={view.notes?.summary}
            url={view.notes?.url}
            showLede
            labelledBy={`${id}-notes`}
            onRead={onRead}
          />
        )}
      </div>
    </>
  )
}

export function UpdatePanel({
  view,
  pending,
  onAction,
  onHide,
  reloadStatus,
  onResetCachedInterface,
  onReadingChange,
}: UpdatePanelProps): JSX.Element | null {
  const [notesOpen, setNotesOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const notesId = useId()
  const content = useMemo(() => releaseNotesContent(view.notes?.summary), [view.notes?.summary])
  const reading = hovered || focused || scrolled
  useEffect(() => {
    onReadingChange?.(reading)
  }, [reading, onReadingChange])
  useEffect(() => () => onReadingChange?.(false), [onReadingChange])
  if (view.state === 'none') return null
  const devOffer = view.state === 'offer' && view.channel === 'dev'
  const notesUpFront = view.state === 'offer' || view.state === 'done'
  const hasNotes = !!(view.notes?.summary || view.notes?.url)
  const hasStatus =
    (view.steps.length > 0 && view.state !== 'done') ||
    view.reason ||
    view.error ||
    view.awaitingElsewhere.length > 0 ||
    (view.deferredNote && view.state !== 'done') ||
    view.primary?.consequence ||
    view.note ||
    reloadStatus ||
    (view.liveness && view.state !== 'running')
  const badge =
    view.state === 'running' && view.stepPosition ? (
      `Step ${view.stepPosition.current} of ${view.stepPosition.total}`
    ) : view.channel ? (
      <>
        {view.channel === 'dev' ? 'dev' : view.channel === 'edge' ? 'Edge' : 'Stable'}
        {view.channel === 'dev' && view.version?.includes('+') && (
          <code>{view.version.split('+')[1]}</code>
        )}
      </>
    ) : undefined
  return (
    <aside
      data-testid="update-panel"
      data-state={view.state}
      role="dialog"
      aria-modal="false"
      aria-label="Podium update"
      className="update-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <UpdateCardHeader
        title={view.title}
        subtitle={view.subtitle}
        badge={badge}
        dev={view.channel === 'dev'}
        done={view.state === 'done'}
      >
        {notesUpFront && !devOffer && <ReleaseNotesLede html={content.lede} />}
      </UpdateCardHeader>

      {hasStatus && (
        <div className="update-card-status">
          {view.state !== 'done' && <StepList view={view} />}
          {view.liveness && view.state !== 'running' && (
            <p data-testid="update-liveness">{view.liveness}</p>
          )}
          {view.reason && (
            <p className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-[1.5] text-destructive">
              {view.reason}
            </p>
          )}

          {/* §7's three layers: what happened, the one next action, folded detail. */}
          {view.error && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] leading-[1.5] text-muted-foreground">
                {view.error.message}
              </p>
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
        </div>
      )}

      {devOffer ? (
        <DevOfferContent view={view} onRead={() => setScrolled(true)} />
      ) : hasNotes && notesUpFront ? (
        <ReleaseNotes
          summary={view.notes?.summary}
          url={view.notes?.url}
          onRead={() => setScrolled(true)}
        />
      ) : null}
      {hasNotes && !notesUpFront && (
        <>
          <button
            type="button"
            className="update-card-peek"
            aria-expanded={notesOpen}
            aria-controls={notesId}
            onClick={() => setNotesOpen(!notesOpen)}
          >
            <b>What's new{view.version ? ` in ${view.version.split('+')[0]}` : ''}</b>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
          {notesOpen && (
            <div className="update-card-notes-disclosure" id={notesId}>
              <ReleaseNotes
                summary={view.notes?.summary}
                url={view.notes?.url}
                showLede
                onRead={() => setScrolled(true)}
              />
            </div>
          )}
        </>
      )}
      {view.state === 'offer' && <ImpactDetails view={view} />}
      <footer className="update-card-foot">
        {view.dismiss?.hint && <span className="update-card-hint">{view.dismiss.hint}</span>}
        {!view.dismiss?.primary && (
          <Button type="button" variant="ghost" size="sm" onClick={onHide}>
            {view.dismiss?.label ?? 'Hide'}
          </Button>
        )}
        <span className="update-card-spacer" />
        {view.freshness && (
          <span data-testid="update-liveness" className="update-card-live">
            {view.freshness}
          </span>
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
        {view.dismiss?.primary && (
          <Button type="button" size="sm" onClick={onHide}>
            {view.dismiss.label}
          </Button>
        )}
      </footer>
    </aside>
  )
}
