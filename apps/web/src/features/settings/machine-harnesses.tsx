import { relativeTime } from '@podium/client-core/focus'
import type { MachineModel } from '@podium/client-graph'
import {
  HarnessInstallAnswer,
  type HarnessInstallClient,
} from '@podium/client-graph/harness-installs-view'
import type { MachineHarness } from '@podium/client-graph/machine-harness'
import { observer } from '@podium/client-graph/react'
import type { HarnessInstallAction } from '@podium/protocol'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAgeNow } from '@/lib/clock-hooks'

export const MachineHarnesses = observer(function MachineHarnesses({
  machine,
  client,
}: {
  machine: MachineModel
  client: HarnessInstallClient
}) {
  return (
    <section aria-label="Harnesses" className="mt-6">
      <h3 className="text-sm font-medium">Harnesses</h3>
      <p className="settings-prose mt-1 mb-3">
        Each row shows who installed the harness and who handles its updates.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border px-4">
        {machine.harnessInstalls.map((row) => (
          <MachineHarnessRow key={row.kind} row={row} client={client} />
        ))}
      </div>
    </section>
  )
})

const CheckedAt = ({ at }: { at: string }) => {
  const now = useAgeNow(at)
  return <span> · checked {relativeTime(at, now)}</span>
}

export const MachineHarnessRow = observer(function MachineHarnessRow({
  row,
  client,
}: {
  row: MachineHarness
  client: HarnessInstallClient
}) {
  const answer = useMemo(() => new HarnessInstallAnswer(), [])
  useEffect(() => () => answer.close(), [answer])
  const [confirmRemove, setConfirmRemove] = useState(false)
  const run = (action: HarnessInstallAction) => {
    void answer.run(client, row, action)
  }
  return (
    <div className="py-4" data-harness-state={row.state}>
      <div className="flex flex-col items-start justify-between gap-x-6 gap-y-2 sm:flex-row sm:flex-wrap">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">{row.label}</h4>
          {row.ownLabel && <p className="settings-prose mt-1">{row.ownLabel}</p>}
          {row.managedLabel && (
            <p
              className="settings-prose mt-1"
              role={row.state === 'installing' ? 'status' : undefined}
            >
              {row.managedLabel}
              {row.managed?.lastCheckAt && row.state !== 'installing' && (
                <CheckedAt at={row.managed.lastCheckAt} />
              )}
            </p>
          )}
          {row.state === 'not-installed' && <p className="settings-prose mt-1">Not installed</p>}
          {row.state === 'unknown' && (
            <p className="settings-prose mt-1">Installation not yet reported</p>
          )}
          {row.sharing && (
            <p className="mt-2 text-xs text-warning">
              Both installs are sharing one folder for settings and conversations.
            </p>
          )}
          {row.updateNotice && <p className="settings-prose mt-2">{row.updateNotice}</p>}
          {row.installReason && !row.managed && (
            <p className="settings-prose mt-2 max-w-prose">{row.installReason}</p>
          )}
          {row.managed?.lastError && (
            <p role="alert" className="mt-2 text-xs text-warning">
              {row.managed.lastError.message}
            </p>
          )}
          {row.inventory?.install?.ledgerRebuilt && (
            <p className="mt-2 text-xs text-warning">
              Podium rebuilt the install record from the releases on this machine.
            </p>
          )}
        </div>
        <fieldset className="flex max-w-full flex-wrap gap-1" aria-label={`${row.label} actions`}>
          {row.actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === 'install' ? 'outline' : 'ghost'}
              size="xs"
              className="min-h-11 sm:min-h-0"
              disabled={
                !row.canAct ||
                answer.loading ||
                (action === 'install' && row.inventory?.management?.installable === false)
              }
              title={action === 'install' ? row.installReason : undefined}
              onClick={() => (action === 'remove' ? setConfirmRemove(true) : run(action))}
            >
              {row.actionLabel(action)}
            </Button>
          ))}
        </fieldset>
      </div>
      {row.inventory?.missingPrerequisites?.map((prerequisite) => (
        <p key={prerequisite.executable} role="alert" className="mt-2 text-xs text-warning">
          {prerequisite.message}
        </p>
      ))}
      {confirmRemove && (
        <div className="mt-3 rounded-md border border-border p-3 text-sm">
          <p>
            Remove Podium’s copy of {row.label}? Releases will be deleted once their running
            sessions exit. Your Podium home, conversations and sign-in folders will stay.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={answer.loading}
              onClick={() => {
                setConfirmRemove(false)
                run('remove')
              }}
            >
              Remove Podium’s copy
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {answer.loading && (
        <p role="status" className="settings-prose mt-2">
          Waiting for the machine…
        </p>
      )}
      {(answer.error || answer.answer?.error) && (
        <p role="alert" className="mt-2 text-xs text-warning">
          {answer.error ?? answer.answer?.error}
        </p>
      )}
      {answer.answer?.pendingSessions ? (
        <p role="status" className="settings-prose mt-2">
          Removal is waiting for {answer.answer.pendingSessions} running{' '}
          {answer.answer.pendingSessions === 1 ? 'session' : 'sessions'}. Homes and conversations
          are kept.
        </p>
      ) : null}
      {answer.answer?.changes && (
        <section className="settings-prose mt-3 space-y-2" aria-label="Podium’s changes">
          {answer.answer.changes.length === 0 ? (
            <p>No Podium changes are recorded in your own {row.label} folder.</p>
          ) : (
            answer.answer.changes.map((change) => (
              <div key={change.id} className="rounded border border-border p-2">
                <p className="break-all font-mono text-xs">{change.file}</p>
                <p>
                  {change.edit.kind === 'owned-file'
                    ? 'File created by Podium'
                    : `${change.edit.path.join('.')} = ${JSON.stringify(change.edit.value)}`}
                </p>
                {change.status && (
                  <p>
                    {change.status === 'changed'
                      ? 'Kept: you changed this after Podium wrote it.'
                      : change.status === 'restored'
                        ? 'Restored.'
                        : `Could not restore: ${change.reason ?? 'unknown error'}`}
                  </p>
                )}
              </div>
            ))
          )}
        </section>
      )}
      {answer.answer?.conversations && (
        <section
          className="mt-3 rounded-md border border-border p-3 text-sm"
          aria-label="Podium home"
        >
          <p>
            {answer.answer.homeExists
              ? 'The Podium home holds these conversations:'
              : 'There is no Podium home on this machine.'}
          </p>
          {answer.answer.conversations.length ? (
            <ul className="my-2 list-inside list-disc">
              {answer.answer.conversations.map((conversation) => (
                <li key={conversation.id}>
                  {conversation.title}{' '}
                  <span className="text-xs text-muted-foreground">({conversation.id})</span>
                </li>
              ))}
            </ul>
          ) : (
            answer.answer.homeExists && <p>No stored conversations.</p>
          )}
          {answer.answer.homeExists && (
            <Button
              className="mt-2"
              size="xs"
              variant="outline"
              disabled={answer.loading}
              onClick={() => {
                const conversations = answer.answer?.conversations ?? []
                if (
                  window.confirm(
                    `Delete the Podium home of ${row.label}? This deletes these conversations: ${conversations.length ? conversations.map((item) => item.title).join(', ') : '(none)'}. Your sign-in folders stay.`,
                  )
                )
                  void answer.run(
                    client,
                    row,
                    'remove-home',
                    conversations.map((item) => item.id),
                  )
              }}
            >
              Delete Podium home
            </Button>
          )}
        </section>
      )}
    </div>
  )
})
