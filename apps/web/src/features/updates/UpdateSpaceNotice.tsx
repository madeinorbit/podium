import { AlertTriangle } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useEffect, useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { UpdateSpaceView } from './update-space-view'

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
      {view.summary && <p>{view.summary}</p>}
      {view.stale && <p className="update-space-stale">Estimate may be out of date.</p>}
    </div>
  )
})
