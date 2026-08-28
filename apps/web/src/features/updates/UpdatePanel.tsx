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
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import type { UpdatePanelView } from './operation-view'
import type { ReloadHandshakeStatus } from './reload-handshake'
import type { PanelActionKind } from './use-update-state'

export interface UpdatePanelProps {
  view: UpdatePanelView
  pending: PanelActionKind | null
  onAction: (kind: PanelActionKind) => void
  onHide: () => void
  reloadStatus?: ReloadHandshakeStatus
  onResetCachedInterface?: () => void
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

export function UpdatePanel({
  view,
  pending,
  onAction,
  onHide,
  reloadStatus,
  onResetCachedInterface,
}: UpdatePanelProps): JSX.Element | null {
  if (view.state === 'none') return null

  return (
    <aside
      data-testid="update-panel"
      data-state={view.state}
      role="dialog"
      aria-modal="false"
      aria-label="Podium update"
      className="fixed right-4 bottom-9 z-50 w-[min(28rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100vh-4rem))] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)]"
    >
      <div className="gap-1 border-b border-border px-4 pt-4 pb-3">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{view.title}</h2>
        {view.subtitle && (
          <p className="text-[11px] leading-[1.5] text-muted-foreground">{view.subtitle}</p>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        {/* The offer's place rows: what this update touches, in place language. */}
        {view.places && view.places.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Places affected by this update">
            {view.places.map((place) => (
              <li
                key={place.kind + place.label}
                className="flex items-start justify-between gap-4 rounded-md border border-border/70 bg-muted/25 px-3 py-2"
              >
                <span className="font-medium text-foreground">{place.label}</span>
                <span className="text-right text-[11px] leading-[1.45] text-muted-foreground">
                  {place.effect}
                </span>
              </li>
            ))}
          </ul>
        )}

        <StepList view={view} />

        {/* LIVENESS IS NEVER OPTIONAL while something is running (P4). */}
        {view.liveness && (
          <p
            data-testid="update-liveness"
            className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase"
          >
            {view.stepPosition
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

        {view.restartNote && (
          <p className="text-[11px] leading-[1.5] text-muted-foreground">{view.restartNote}</p>
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

        {view.notes?.summary && (
          <p className="text-[11px] leading-[1.5] text-muted-foreground">{view.notes.summary}</p>
        )}
        {view.notes?.url && (
          <a
            className="w-fit text-[11px] font-medium text-primary underline-offset-3 hover:underline"
            href={view.notes.url}
            target="_blank"
            rel="noreferrer"
          >
            What's new
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-3">
        {/* ONE DISMISS VERB, in every state (§6.1). Hide collapses; it never discards. */}
        <Button type="button" variant="ghost" size="sm" onClick={onHide}>
          Hide
        </Button>
        <div className="flex flex-wrap justify-end gap-2">
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
