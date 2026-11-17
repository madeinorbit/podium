/**
 * "SEND TO A MACHINE" (credential management §8). A credential goes to the
 * machines its owner holds custody of without asking. Any other machine the
 * person may run on needs an explicit yes, given next to the statement that
 * everyone on that machine's operating-system account can read it.
 */

import { CREDENTIAL_MACHINE_DISCLOSURE } from '@podium/commands/credentials'
import { asMachineId, type CredentialView } from '@podium/model'
import { Laptop } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { settingsReceipt } from '@/features/settings/settings-receipt'
import { ConfirmInline, EntityRow } from '@/features/settings/sections/shared'
import { type CredentialDeps, errorText, type MachineChoice } from './credentials-deps'

export function MachineSend({ view, deps }: { view: CredentialView; deps: CredentialDeps }) {
  const [sending, setSending] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const allowed = new Set<string>(view.allowedMachines)
  // An allowed machine the person can no longer pick still shows, so it can be taken back.
  const machines: MachineChoice[] = [
    ...deps.sendable,
    ...view.allowedMachines
      .filter((id) => !deps.sendable.some((machine) => machine.id === id))
      .map((id) => ({ id, name: deps.machineName(id) })),
  ]

  const takeBack = async (machine: MachineChoice) => {
    setBusy(machine.id)
    setError(null)
    try {
      await deps.commands.disallowMachine.mutate({
        credentialId: view.id,
        machineId: asMachineId(machine.id),
      })
      deps.reload()
      settingsReceipt('Saved')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  if (machines.length === 0) {
    return (
      <p className="settings-list-note settings-prose">
        It runs on the machines you look after. There is no other machine you may run on.
      </p>
    )
  }
  return (
    <>
      {machines.map((machine) => (
        <div key={machine.id}>
          <EntityRow
            leading={<Laptop size={16} aria-hidden="true" />}
            title={machine.name}
            subtitle={allowed.has(machine.id) ? 'Sent' : 'Not sent'}
            trailing={
              allowed.has(machine.id) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void takeBack(machine)}
                >
                  Take back
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setSending(machine.id)}
                >
                  Send…
                </Button>
              )
            }
          />
          {sending === machine.id && (
            <ConfirmInline
              sentence={CREDENTIAL_MACHINE_DISCLOSURE}
              acknowledgement={`I understand. Send ${view.label} to ${machine.name}.`}
              actionLabel={`Send to ${machine.name}`}
              onCancel={() => setSending(null)}
              onConfirm={async () => {
                await deps.commands.allowMachine.mutate({
                  credentialId: view.id,
                  machineId: asMachineId(machine.id),
                  acknowledgeDisclosure: true,
                })
                setSending(null)
                deps.reload()
                settingsReceipt('Saved')
              }}
            />
          )}
        </div>
      ))}
      {error && (
        <p className="settings-list-note settings-prose text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
