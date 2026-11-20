import { observer } from '@podium/client-graph/react'
import { machineWrites } from '@podium/commands/fleet-synced'
import type { UninstallEditOutcome } from '@podium/protocol'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MachineReplacementOptions, type SettingsMachine } from './machine-view'
import { useSettingsMachines } from './readers'
import { ConfirmInline, Row, Section } from './sections/shared'
import { useSettingsFrame } from './settings-frame'
import { useSettingsTrpc } from './stable-access'

export const MachineRemove = observer(function MachineRemove({ view }: { view: SettingsMachine }) {
  const trpc = useSettingsTrpc()
  const { closeTakeover } = useSettingsFrame()
  const machines = useSettingsMachines()
  const options = useMemo(
    () => new MachineReplacementOptions(view.machine, machines),
    [view.machine, machines],
  )
  const [confirming, setConfirming] = useState<'replace' | 'remove' | 'uninstall' | null>(null)
  const [uninstalled, setUninstalled] = useState<UninstallAnswer | null>(null)
  const [replacementId, setReplacementId] = useState('')
  const [busy, setBusy] = useState(false)
  const machine = view.machine
  if (uninstalled)
    return (
      <UninstallReport machineName={machine.name} answer={uninstalled} onDone={closeTakeover} />
    )
  if (!view.canManage) return null
  return (
    <Section title="Remove">
      {view.canReplace && (
        <>
          <Row
            label="Replace with another machine"
            description="Retires this machine when you reinstall or replace a computer. The replacement keeps its existing access."
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setReplacementId('')
                setConfirming('replace')
              }}
            >
              Replace…
            </Button>
          </Row>
          {confirming === 'replace' && (
            <div className="py-2">
              <label className="settings-label" htmlFor={`replacement-${machine.id}`}>
                Replacement machine
              </label>
              <Select
                value={replacementId || null}
                disabled={busy}
                onValueChange={(id) => setReplacementId(id ?? '')}
              >
                <SelectTrigger
                  id={`replacement-${machine.id}`}
                  aria-label="Replacement machine"
                  className="mt-2 w-full max-w-sm"
                >
                  <SelectValue placeholder="Choose a machine" />
                </SelectTrigger>
                <SelectContent>
                  {options.candidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.hostname} ·{' '}
                      {candidate.online ? 'online' : 'offline'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {options.candidates.length === 0 && (
                <p className="settings-prose mt-2">Add a replacement machine first.</p>
              )}
              {options.candidates.some((candidate) => candidate.id === replacementId) ? (
                <ConfirmInline
                  key={replacementId}
                  sentence={
                    <>
                      Replace {machine.name} with{' '}
                      {options.candidates.find((candidate) => candidate.id === replacementId)?.name}
                      ? This disconnects the old machine and cancels its access grants and queued
                      work. Matching names do not prove these are the same device.
                    </>
                  }
                  actionLabel="Replace machine"
                  destructive
                  pending={busy}
                  onCancel={() => setConfirming(null)}
                  onConfirm={async () => {
                    if (
                      !view.canReplace ||
                      !options.candidates.some((candidate) => candidate.id === replacementId)
                    )
                      return
                    setBusy(true)
                    try {
                      await machineWrites(trpc).supersede.mutate({ id: machine.id, replacementId })
                      closeTakeover()
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              )}
            </div>
          )}
        </>
      )}
      <Row
        label="Remove from workspace"
        description="Disconnects it. Running sessions finish; it must pair again to come back."
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive"
          disabled={busy}
          onClick={() => setConfirming('remove')}
        >
          Remove
        </Button>
      </Row>
      {confirming === 'remove' && (
        <ConfirmInline
          sentence={
            <>
              Remove {machine.name} from this workspace? It will be disconnected and must pair again
              to reconnect. Running sessions finish.
            </>
          }
          actionLabel="Remove machine"
          destructive
          pending={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            if (!view.canManage) return
            setBusy(true)
            try {
              await machineWrites(trpc).revoke.mutate({ id: machine.id })
              closeTakeover()
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
      {view.canUninstall && (
        <Row
          label="Uninstall Podium"
          description="Undoes Podium’s changes in its harness folders, removes Podium’s services and files there, then removes it. Your own harness installs stay."
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={busy}
            onClick={() => setConfirming('uninstall')}
          >
            Uninstall…
          </Button>
        </Row>
      )}
      {confirming === 'uninstall' && view.canUninstall && (
        <ConfirmInline
          sentence={
            <>
              Uninstall Podium from {machine.name}? Its sessions stop, Podium’s changes in its
              harness folders are undone, Podium’s services and files there are deleted, and it
              leaves this workspace. Sign-ins kept in Podium’s own folders there are deleted too.
            </>
          }
          actionLabel="Uninstall Podium"
          destructive
          pending={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            if (!view.canUninstall) return
            setBusy(true)
            try {
              const answer = await trpc.machines.uninstall.mutate({ id: machine.id })
              setUninstalled({ outcomes: answer.outcomes, removesState: answer.removesState })
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </Section>
  )
})

interface UninstallAnswer {
  outcomes: readonly UninstallEditOutcome[]
  removesState: boolean
}

/** What the machine said it did, once "Uninstall Podium" has been answered. */
function UninstallReport({
  machineName,
  answer,
  onDone,
}: {
  machineName: string
  answer: UninstallAnswer
  onDone: () => void
}) {
  const count = (status: UninstallEditOutcome['status']) =>
    answer.outcomes.filter((outcome) => outcome.status === status).length
  const kept = answer.outcomes.filter((outcome) => outcome.status !== 'restored')
  return (
    <Section title="Uninstall Podium">
      <div className="py-2" role="status">
        <p className="settings-prose">
          Podium is being removed from {machineName}, and the machine has left this workspace.
        </p>
        <p className="settings-prose mt-2">
          {answer.outcomes.length === 0
            ? 'Podium had made no changes in its harness folders.'
            : `Podium’s changes in its harness folders: ${count('restored')} undone, ${count('changed')} changed since and left as they are, ${count('failed')} could not be undone.`}
        </p>
        {kept.length > 0 && (
          <ul className="settings-prose mt-2 list-disc pl-5">
            {kept.map((outcome) => (
              <li key={`${outcome.harness}:${outcome.file}`}>
                {outcome.file} ({outcome.harness}): {outcome.reason ?? outcome.status}
              </li>
            ))}
          </ul>
        )}
        {!answer.removesState && (
          <p className="settings-prose mt-2">
            Podium’s files stay on the machine until these are resolved. To remove them anyway, run{' '}
            <code>podium uninstall --force</code> there.
          </p>
        )}
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onDone}>
          Done
        </Button>
      </div>
    </Section>
  )
}
