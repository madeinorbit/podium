import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export const SERVER_TRANSFER_PHASES = [
  { key: 'preparing', label: 'Preparing' },
  { key: 'copying', label: 'Copying' },
  { key: 'validating', label: 'Validating' },
  { key: 'switching', label: 'Switching' },
  { key: 'connected', label: 'Connected' },
] as const

export type ServerTransferPhase = (typeof SERVER_TRANSFER_PHASES)[number]['key']
export type ServerTransferDisplayState = ServerTransferPhase | 'aborted' | 'commit-uncertain'

export const SERVER_TRANSFER_CONFIRMATION = 'TRANSFER SERVER'

function transferPhaseIndex(state: ServerTransferDisplayState): number {
  return SERVER_TRANSFER_PHASES.findIndex((phase) => phase.key === state)
}

/** Durable, proof-aware transfer progress presentation shared across routes. */
export function ServerTransferProgress({
  state,
  targetName,
  detail,
}: {
  state: ServerTransferDisplayState
  targetName: string
  detail?: string
}): JSX.Element {
  const current = transferPhaseIndex(state)

  if (state === 'commit-uncertain') {
    return (
      <div
        className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
        role="alert"
      >
        <p className="settings-label text-warning">Connection could not be confirmed</p>
        <p className="settings-prose">
          {detail ??
            `${targetName} may already be serving. Keep the old server stopped, check the target, and do not retry the transfer.`}
        </p>
      </div>
    )
  }

  if (state === 'aborted') {
    return (
      <div className="space-y-1 rounded-md border border-destructive/30 px-3 py-2" role="alert">
        <p className="settings-label text-destructive">Transfer stopped safely</p>
        <p className="settings-prose">
          {detail ??
            `The current server is still active. Resolve the reported problem before trying ${targetName} again.`}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <ol
        className="grid grid-cols-5 gap-1"
        aria-label={`Server transfer progress for ${targetName}`}
      >
        {SERVER_TRANSFER_PHASES.map((phase, index) => {
          const complete = index < current || state === 'connected'
          const active = index === current
          return (
            <li
              key={phase.key}
              className={cn(
                'rounded border px-1.5 py-2 text-center text-[11px]',
                complete && 'border-success/30 bg-success/5 text-foreground',
                active && state !== 'connected' && 'border-primary/40 bg-primary/5 text-foreground',
                !complete && !active && 'border-border text-muted-foreground',
              )}
              aria-current={active ? 'step' : undefined}
              data-transfer-phase={phase.key}
              data-transfer-state={complete ? 'complete' : active ? 'active' : 'pending'}
            >
              {phase.label}
            </li>
          )
        })}
      </ol>
      <p className="settings-prose">
        {state === 'connected'
          ? `${targetName} proved it is serving and the previous server reconnected as a daemon.`
          : `${SERVER_TRANSFER_PHASES[current]?.label ?? 'Preparing'} server transfer…`}
      </p>
    </div>
  )
}

export interface ServerTransferProps {
  open: boolean
  targetName: string
  sourceName: string
  publicUrl: string
  confirmation: string
  displayState: ServerTransferDisplayState | null
  detail?: string
  error: string | null
  awaitingStatus: boolean
  checkingTarget: boolean
  showProgress: boolean
  urlIsValid: boolean
  canStart: boolean
  onOpenChange: (open: boolean) => void
  onPublicUrlChange: (value: string) => void
  onConfirmationChange: (value: string) => void
  onStart: () => void
  onCheckTarget: () => void
}

/**
 * Controlled server-transfer review and progress dialog. The caller interprets the durable
 * transfer snapshot and performs mutations; this component never infers success from a
 * mutation acknowledgement.
 */
export function ServerTransfer({
  open,
  targetName,
  sourceName,
  publicUrl,
  confirmation,
  displayState,
  detail,
  error,
  awaitingStatus,
  checkingTarget,
  showProgress,
  urlIsValid,
  canStart,
  onOpenChange,
  onPublicUrlChange,
  onConfirmationChange,
  onStart,
  onCheckTarget,
}: ServerTransferProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="sm:max-w-lg"
        aria-busy={awaitingStatus || undefined}
      >
        <DialogHeader>
          <DialogTitle>
            Move the server from {sourceName} to {targetName}?
          </DialogTitle>
          <DialogDescription>
            Portable shared state moves to {targetName}; repositories, native credentials, and
            running sessions stay on their machines. {sourceName} remains the server until the copy
            validates, then reconnects to the new public URL as a daemon.
          </DialogDescription>
        </DialogHeader>

        {showProgress ? (
          <ServerTransferProgress
            state={displayState ?? 'preparing'}
            targetName={targetName}
            detail={detail}
          />
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            {displayState === 'aborted' && (
              <ServerTransferProgress state="aborted" targetName={targetName} detail={detail} />
            )}
            <label htmlFor="server-transfer-url" className="flex flex-col gap-1">
              <span className="text-muted-foreground">New public URL</span>
              <Input
                id="server-transfer-url"
                value={publicUrl}
                onChange={(event) => onPublicUrlChange(event.currentTarget.value)}
                aria-label="New public URL"
                aria-invalid={publicUrl.trim() !== '' && !urlIsValid}
                placeholder="https://podium.example.com"
                autoComplete="url"
              />
              <span className="text-[11px] text-muted-foreground">
                Podium clients will reconnect to this HTTP(S) address after the target proves it is
                serving.
              </span>
            </label>
            <label htmlFor="server-transfer-confirmation" className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                Type <strong>{SERVER_TRANSFER_CONFIRMATION}</strong> to confirm
              </span>
              <Input
                id="server-transfer-confirmation"
                value={confirmation}
                onChange={(event) => onConfirmationChange(event.currentTarget.value)}
                aria-label="Server transfer confirmation"
                autoComplete="off"
              />
            </label>
            {publicUrl.trim() !== '' && !urlIsValid && (
              <p className="settings-prose text-destructive" role="alert">
                Enter a complete HTTP or HTTPS public URL.
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="settings-prose text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter showCloseButton>
          {!showProgress && (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!canStart}
              onClick={onStart}
            >
              Transfer server
            </Button>
          )}
          {displayState === 'commit-uncertain' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checkingTarget}
              onClick={onCheckTarget}
            >
              {checkingTarget ? 'Checking…' : 'Check target'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Settings-compatible name while the component itself remains route-neutral. */
export const ServerTransferDialog = ServerTransfer
