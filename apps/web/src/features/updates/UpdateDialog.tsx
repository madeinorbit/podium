import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { UpdateView } from './update-view'

type MaybePromise = void | Promise<void>
type Action = () => MaybePromise

export interface UpdateActions {
  reload?: Action
  installApp?: Action
  updateServer?: Action
}

interface UpdateDialogProps {
  view: UpdateView
  actions: UpdateActions
  onDismiss?: () => void
}

type ActionName = 'reload' | 'installApp' | 'updateServer'

function viewKey(view: UpdateView): string {
  if (view.state === 'none') return 'none'
  if (view.state === 'failed') {
    return `failed:${view.message}:${view.guidance}:${view.diagnostic ?? ''}`
  }
  return `${view.state}:${view.version}`
}

export function UpdateDialog({ view, actions, onDismiss }: UpdateDialogProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  const [pendingAction, setPendingAction] = useState<ActionName | null>(null)

  useEffect(() => {
    setDismissed(false)
  }, [viewKey(view)])

  if (view.state === 'none' || dismissed) return null

  const canClose = view.state === 'available' || view.state === 'failed'
  const dismiss = () => {
    onDismiss?.()
    setDismissed(true)
  }
  /**
   * Reload only helps when THIS APP is one of the places being updated. A release
   * that touches only the server or only machines would otherwise offer a button
   * that fetches the same app back, and in the no-restart-needed state it is the
   * only action besides Later, which reads as "click here to update" when the
   * machines are converging on their own. Same rule as places: offer what does
   * something.
   */
  const appTouched = 'places' in view && view.places.some((place) => place.kind === 'this-app')

  const runAction = async (name: ActionName, action: Action | undefined) => {
    if (!action) return
    setPendingAction(name)
    try {
      await action()
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <aside
      data-testid="update-dialog"
      role="dialog"
      aria-modal="false"
      aria-label="Podium update"
      className="fixed right-4 bottom-4 z-50 w-[min(28rem,calc(100vw-2rem))] max-h-[min(42rem,calc(100vh-2rem))] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)]"
    >
      {view.state === 'available' || view.state === 'required' ? (
        <>
          <div className="relative gap-1 border-b border-border px-4 pt-4 pb-3 pr-12">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em]">
              Podium {view.version} is {view.state === 'required' ? 'required' : 'available'}
            </h2>
            <p className="text-[11px] leading-[1.5] text-muted-foreground">
              One Podium update, applied where it is needed.
            </p>
          </div>

          <div className="flex flex-col gap-3 px-4 py-4">
            <ul className="flex flex-col gap-2" aria-label="Places affected by this update">
              {view.places.map((place) => (
                <li
                  key={place.kind}
                  className="flex items-start justify-between gap-4 rounded-md border border-border/70 bg-muted/25 px-3 py-2"
                >
                  <span className="font-medium text-foreground">{place.label}</span>
                  <span className="text-right text-[11px] leading-[1.45] text-muted-foreground">
                    {place.effect}
                  </span>
                </li>
              ))}
            </ul>

            {view.reason && (
              <p className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-[1.5] text-destructive">
                {view.reason}
              </p>
            )}

            <p className="text-[11px] leading-[1.5] text-muted-foreground">{view.restartNote}</p>

            {view.notes?.summary && (
              <p className="text-[11px] leading-[1.5] text-muted-foreground">
                {view.notes.summary}
              </p>
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
            {canClose ? (
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              {actions.reload && appTouched && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  pending={pendingAction === 'reload'}
                  pendingLabel="Refreshing…"
                  onClick={() => void runAction('reload', actions.reload)}
                >
                  Reload
                </Button>
              )}
              {actions.installApp && (
                <Button
                  type="button"
                  size="sm"
                  pending={pendingAction === 'installApp'}
                  pendingLabel="Installing…"
                  onClick={() => void runAction('installApp', actions.installApp)}
                >
                  Install update
                </Button>
              )}
              {actions.updateServer && (
                <Button
                  type="button"
                  size="sm"
                  pending={pendingAction === 'updateServer'}
                  pendingLabel="Updating…"
                  onClick={() => void runAction('updateServer', actions.updateServer)}
                >
                  Update server
                </Button>
              )}
            </div>
          </div>
        </>
      ) : view.state === 'in-progress' ? (
        <>
          <div className="gap-1 px-4 pt-4 pb-3">
            <h2 className="text-[14px] font-semibold">Podium {view.version} is being applied</h2>
            <p className="text-[11px] leading-[1.5] text-muted-foreground">
              {view.done} of {view.total} places are ready.
            </p>
          </div>
          <div className="px-4 pb-4">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={view.total}
              aria-valuenow={view.done}
              aria-label={`Update progress: ${view.done} of ${view.total}`}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${view.total > 0 ? (view.done / view.total) * 100 : 0}%` }}
              />
            </div>
            <p className="mt-2 font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
              Sessions keep running
            </p>
          </div>
        </>
      ) : view.state === 'failed' ? (
        <>
          <div className="gap-1 px-4 pt-4 pb-4">
            <h2 className="text-[14px] font-semibold">Podium update paused</h2>
            <p className="mt-1 text-[11px] leading-[1.5] text-muted-foreground">{view.message}</p>
            <p className="mt-2 text-[11px] leading-[1.5] text-foreground">{view.guidance}</p>
            {view.diagnostic && (
              <details className="mt-3 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-[11px]">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  Technical details
                </summary>
                <p className="mt-2 font-mono text-[10px] leading-[1.5] text-muted-foreground">
                  {view.diagnostic}
                </p>
              </details>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
              Dismiss
            </Button>
            {actions.updateServer && (
              <Button
                type="button"
                size="sm"
                pending={pendingAction === 'updateServer'}
                pendingLabel="Trying again…"
                onClick={() => void runAction('updateServer', actions.updateServer)}
              >
                Try again
              </Button>
            )}
          </div>
        </>
      ) : null}
    </aside>
  )
}
