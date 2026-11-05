import { AlertTriangle, ChevronDown } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
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
    <div data-testid="update-space-notice" role="status" className="update-space-notice">
      {view.warnings.length > 0 && (
        <div className="update-space-warnings">
          {view.warnings.map((warning) => (
            <p key={warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              <span>{warning}</span>
            </p>
          ))}
        </div>
      )}
      <details className="update-space-details">
        <summary>
          <span>{view.summary}</span>
          {view.stale && <span className="update-space-stale">May be out of date</span>}
          <ChevronDown size={10} aria-hidden="true" />
        </summary>
        <div className="update-space-details-body">
          {view.error && <p>{view.error}</p>}
          <p>Estimates include 30% slack, with at least 512 MiB spare per volume.</p>
          {view.answer?.machines.map((machine) => (
            <div key={machine.machineId} className="update-space-machine">
              <b>
                {machine.name} · {machine.targetVersion}
              </b>
              {machine.status === 'unknown' && (
                <p>{machine.reason ?? 'Disk space could not be verified.'}</p>
              )}
              {machine.volumes.map((volume) => (
                <p key={volume.path}>
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
          <button
            type="button"
            className="update-space-refresh"
            disabled={view.loading}
            onClick={() => void view.refresh()}
          >
            Check again
          </button>
        </div>
      </details>
    </div>
  )
})
