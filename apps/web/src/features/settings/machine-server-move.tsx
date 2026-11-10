import { observer } from '@podium/client-graph/react'
import type { Operation } from '@podium/protocol'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { serverMoveErrorCopy, settleServerMoveRecovery } from '@/features/machines/server-move'
import { updateStatus } from '@/lib/update-status'
import { cn } from '@/lib/utils'
import { useSettingsMachines } from './readers'
import { useSettingsTrpc } from './stable-access'

function ServerMoveProgress({
  operation,
  targetName,
}: {
  operation: Operation
  targetName: string
}) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <p className="settings-label">Moving the server to {targetName}</p>
      <ol className="flex flex-wrap gap-2" aria-label={`Server move progress for ${targetName}`}>
        {(operation.steps ?? []).map((step) => (
          <li
            key={step.id}
            className={cn(
              'settings-micro rounded border px-2 py-1',
              step.state === 'done' && 'border-success/30',
              (step.state === 'running' || step.state === 'stalled') &&
                'border-warning text-warning',
            )}
            aria-current={step.state === 'running' || step.state === 'stalled' ? 'step' : undefined}
            data-operation-step={step.id}
            data-operation-state={step.state}
          >
            {step.title ?? step.id}
          </li>
        ))}
      </ol>
      {operation.error && (
        <p className="settings-prose text-destructive" role="alert">
          {serverMoveErrorCopy(operation.error.code, operation.error.message)}
        </p>
      )}
    </div>
  )
}

/** Dormant transfer entry points are gone; an already running move can still finish recovery. */
export const ActiveServerMove = observer(function ActiveServerMove({
  canRecover,
}: {
  canRecover: boolean
}) {
  const status = updateStatus()
  useEffect(() => status.watch(), [status])
  const machines = useSettingsMachines()
  const trpc = useSettingsTrpc()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operation = status.operation
  if (operation?.kind !== 'server-move') return null
  const target = machines.find((machine) => machine.id === operation.details?.targetMachineId)
  return (
    <div className="mb-4 rounded-lg border border-border p-4">
      <ServerMoveProgress operation={operation} targetName={target?.name ?? 'the new machine'} />
      {canRecover && operation.awaiting?.some((ask) => ask.id === 'server-move-recovery') && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            void settleServerMoveRecovery(trpc, operation.id)
              .then(() => status.refresh())
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              )
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Checking…' : 'Check the new server'}
        </Button>
      )}
      {error && (
        <p className="settings-prose mt-2 text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
})
