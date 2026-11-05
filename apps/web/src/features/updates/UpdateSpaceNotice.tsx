import { observer } from 'mobx-react-lite'
import { useEffect, useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { formatSpaceBytes, UpdateSpaceView } from './update-space-view'

export interface UpdateSpaceNoticeProps {
  client: Pick<Trpc, 'updates'>
  scope?: 'operation' | 'all'
  expectedVersion?: string
}

/** Mounted in the offer only. No access to update dispatch, pending state, or grants. */
export function UpdateSpaceNotice({
  client,
  scope = 'operation',
  expectedVersion,
}: UpdateSpaceNoticeProps) {
  const view = useMemo(
    () =>
      new UpdateSpaceView(() =>
        client.updates.checkSpace.query({ scope, ...(expectedVersion ? { expectedVersion } : {}) }),
      ),
    [client, scope, expectedVersion],
  )
  useEffect(() => {
    void view.refresh()
    return () => view.close()
  }, [view])
  return <UpdateSpaceReadout view={view} />
}

export const UpdateSpaceReadout = observer(function UpdateSpaceReadout({
  view,
}: {
  view: UpdateSpaceView
}) {
  return (
    <div
      data-testid="update-space-notice"
      role="status"
      className="flex flex-col gap-2 text-[11px] leading-[1.5]"
    >
      {view.loading && <p className="text-muted-foreground">Estimating disk space…</p>}
      {view.warnings.map((warning) => (
        <p
          key={warning}
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground"
        >
          {warning}
        </p>
      ))}
      {view.error && <p className="text-muted-foreground">{view.error}</p>}
      {view.unverified && (
        <p className="text-muted-foreground">
          Disk space could not be verified on {view.unverified}.
        </p>
      )}
      {view.enoughCount > 0 && (
        <p className="text-muted-foreground">
          Estimated disk space is sufficient on {view.enoughCount}{' '}
          {view.enoughCount === 1 ? 'machine' : 'machines'}.
        </p>
      )}
      {view.stale && <p className="text-muted-foreground">This estimate may be out of date.</p>}
      {view.answer?.machines.length === 0 && !view.loading && (
        <p className="text-muted-foreground">No pending machine updates to estimate.</p>
      )}
      {view.answer && view.answer.machines.length > 0 && (
        <details className="rounded-md border border-border/70 bg-muted/25 px-3 py-2">
          <summary className="cursor-pointer text-muted-foreground">Storage details</summary>
          <p className="mt-2 text-muted-foreground">
            Estimates include 30% slack, with at least 512 MiB spare per volume.
          </p>
          {view.answer.machines.map((machine) => (
            <div key={machine.machineId} className="mt-2">
              <p className="font-medium">
                {machine.name} · {machine.targetVersion}
              </p>
              {machine.reason && <p className="text-muted-foreground">{machine.reason}</p>}
              {machine.volumes.map((volume) => (
                <p key={volume.path} className="break-words text-muted-foreground">
                  {volume.path}: {formatSpaceBytes(volume.availableBytes)} available; about{' '}
                  {formatSpaceBytes(volume.requiredBytes)} needed.
                  {volume.shortfallBytes > 0 && (
                    <>
                      {' '}
                      Free at least {formatSpaceBytes(volume.shortfallBytes)} on this volume, then
                      check again.
                    </>
                  )}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={view.loading}
          onClick={() => void view.refresh()}
        >
          Check again
        </Button>
      </div>
    </div>
  )
})
