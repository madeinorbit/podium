import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
}

type ActionName = 'reload' | 'installApp' | 'updateServer'

function viewKey(view: UpdateView): string {
  if (view.state === 'none') return 'none'
  if (view.state === 'failed') return `failed:${view.detail}`
  return `${view.state}:${view.version}`
}

export function UpdateDialog({ view, actions }: UpdateDialogProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  const [pendingAction, setPendingAction] = useState<ActionName | null>(null)

  useEffect(() => {
    setDismissed(false)
  }, [viewKey(view)])

  if (view.state === 'none' || dismissed) return null

  const blocking = view.state === 'required'
  const canClose = view.state === 'available' || view.state === 'failed'
  /**
   * Reload only helps when THIS APP is one of the places being updated. A release
   * that touches only the server or only machines would otherwise offer a button
   * that fetches the same app back, and in the no-restart-needed state it is the
   * only action besides Later, which reads as "click here to update" when the
   * machines are converging on their own. Same rule as places: offer what does
   * something.
   */
  const appTouched =
    'places' in view && view.places.some((place) => place.kind === 'this-app')

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && canClose) setDismissed(true)
      }}
    >
      <DialogContent
        data-testid="update-dialog"
        showCloseButton={canClose}
        overlayClassName="bg-black/65 supports-backdrop-filter:backdrop-blur-[2px]"
        className="max-w-md gap-0 overflow-hidden border border-border bg-popover p-0 text-popover-foreground shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)]"
      >
        {view.state === 'available' || view.state === 'required' ? (
          <>
            <DialogHeader className="gap-1 border-b border-border px-4 pt-4 pb-3 pr-12">
              <DialogTitle className="text-[14px] font-semibold tracking-[-0.01em]">
                Podium {view.version} is {view.state === 'required' ? 'required' : 'available'}
              </DialogTitle>
              <DialogDescription className="text-[11px] leading-[1.5] text-muted-foreground">
                One Podium update, applied where it is needed.
              </DialogDescription>
            </DialogHeader>

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

            <DialogFooter className="-mx-0 -mb-0 rounded-none border-border bg-muted/30 px-4 py-3 sm:flex-row sm:justify-between">
              {!blocking ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDismissed(true)}
                >
                  Later
                </Button>
              ) : (
                <span />
              )}
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
            </DialogFooter>
          </>
        ) : view.state === 'in-progress' ? (
          <>
            <DialogHeader className="gap-1 px-4 pt-4 pb-3">
              <DialogTitle className="text-[14px] font-semibold">
                Podium {view.version} is being applied
              </DialogTitle>
              <DialogDescription className="text-[11px] leading-[1.5] text-muted-foreground">
                {view.done} of {view.total} places are ready.
              </DialogDescription>
            </DialogHeader>
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
            <DialogHeader className="gap-1 px-4 pt-4 pb-3">
              <DialogTitle className="text-[14px] font-semibold">Podium update paused</DialogTitle>
              <DialogDescription className="text-[11px] leading-[1.5] text-muted-foreground">
                {view.detail}
              </DialogDescription>
            </DialogHeader>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
