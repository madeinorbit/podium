import type { MachineModel } from '@podium/client-graph'
import type { RosterFacts } from '@podium/client-graph/worklist/view-model'
import { lazy } from '@podium/mobx-helpers'
import { type MachineGrantEntry, SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model/browser'
import { compareShallow } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMemberRoster } from '@/lib/member-roster'
import { useSettingsMachine } from './readers'
import { ConfirmInline, Row, Subsection } from './sections/shared'

/** The fleet commands this control sends. */
export interface MachineShareApi {
  machines: {
    share: {
      mutate(input: {
        id: string
        grantee: string
        verb: 'use'
        acknowledgeSharedMachine: true
      }): Promise<unknown>
    }
    unshare: {
      mutate(input: {
        id: string
        grantee: string
        verb: MachineGrantEntry['verb']
      }): Promise<unknown>
    }
  }
}

/** Use grants are distinct from custody and from visibility-only grants. */
export class MachineSharing {
  constructor(
    readonly machine: MachineModel,
    private readonly roster: RosterFacts | undefined,
  ) {}

  @lazy({ equals: compareShallow }) get grants(): readonly MachineGrantEntry[] {
    return (this.machine.grants ?? []).filter((grant) => grant.verb === 'use')
  }
  @lazy({ equals: compareShallow }) get candidates() {
    return (this.roster?.members ?? []).filter(
      (member) =>
        member.id !== this.machine.custodian &&
        !this.grants.some((grant) => grant.grantee === member.id),
    )
  }
}

/** POD-6700's grants, re-homed into the machine detail pane. */
export const MachineCustody = observer(function MachineCustody({
  machineId,
  transferable,
  trpc,
}: {
  machineId: string
  transferable: boolean
  trpc: MachineShareApi
}) {
  const machine = useSettingsMachine(machineId)
  return machine ? (
    <MachineGrants machine={machine} transferable={transferable} trpc={trpc} />
  ) : null
})

const MachineGrants = observer(function MachineGrants({
  machine,
  transferable,
  trpc,
}: {
  machine: MachineModel
  transferable: boolean
  trpc: MachineShareApi
}) {
  const roster = useMemberRoster(true)
  const view = useMemo(() => new MachineSharing(machine, roster), [machine, roster])
  const [open, setOpen] = useState(false)
  const [grantee, setGrantee] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const selected = view.candidates.find((person) => person.id === grantee)
  const canManage = transferable && machine.transferable === true && !machine.revokedAt
  const close = () => {
    setOpen(false)
    setGrantee('')
  }
  const remove = async (grant: MachineGrantEntry) => {
    if (!canManage || busy) return
    setBusy(true)
    setMessage(null)
    try {
      await trpc.machines.unshare.mutate({
        id: machine.id,
        grantee: grant.grantee,
        verb: grant.verb,
      })
      setMessage({
        error: false,
        text: `${roster?.nameOf(grant.grantee) ?? 'They'} can no longer start agents here. Sessions already running finish.`,
      })
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Subsection
      title="Who else can run agents here"
      hint="People here share this machine’s operating-system account with whoever looks after it: their agents can read each other’s files."
    >
      {canManage && view.candidates.length > 0 && !open && (
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setGrantee(view.candidates[0]?.id ?? '')
              setMessage(null)
              setOpen(true)
            }}
          >
            Add someone
          </Button>
        </div>
      )}
      <div className="rounded-lg border border-border">
        {machine.grants === undefined ? (
          <p className="settings-prose px-4 py-4">
            {canManage
              ? 'Access has not been reported yet.'
              : 'Only the person who looks after it or an admin can see who else has access.'}
          </p>
        ) : view.grants.length === 0 ? (
          <p className="settings-prose px-4 py-4">Only the person who looks after it.</p>
        ) : (
          <ul aria-label="Who else can run agents here" className="divide-y divide-border">
            {view.grants.map((grant) => (
              <li key={grant.grantee} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="settings-label">
                    {roster?.nameOf(grant.grantee) ?? 'A member'}
                    {grant.grantee === roster?.currentMemberId ? ' (you)' : ''}
                  </p>
                  <p className="settings-prose mt-1">Can run agents here</p>
                </div>
                {canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${roster?.nameOf(grant.grantee) ?? 'this member'}: can run agents`}
                    onClick={() => void remove(grant)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {open && canManage && (
          <div className="border-t border-border px-4 py-2">
            <Row label="Person">
              <Select
                value={selected?.id ?? null}
                disabled={busy}
                onValueChange={(id) => setGrantee(id ?? '')}
              >
                <SelectTrigger aria-label="Person" className="w-full">
                  <SelectValue placeholder="Choose someone" />
                </SelectTrigger>
                <SelectContent>
                  {view.candidates.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {roster?.nameOf(person.id) ?? 'A member'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            {selected ? (
              <ConfirmInline
                key={grantee}
                sentence={SHARED_MACHINE_ACCOUNT_WARNING}
                acknowledgement="I understand we will share this machine’s account"
                actionLabel="Let them run agents here"
                pending={busy}
                onCancel={close}
                onConfirm={async () => {
                  if (!canManage || !view.candidates.some((person) => person.id === grantee)) return
                  setBusy(true)
                  setMessage(null)
                  try {
                    await trpc.machines.share.mutate({
                      id: machine.id,
                      grantee,
                      verb: 'use',
                      acknowledgeSharedMachine: true,
                    })
                    setMessage({
                      error: false,
                      text: `${roster?.nameOf(grantee) ?? 'They'} can now run agents here.`,
                    })
                    close()
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
      {message && (
        <p
          className={message.error ? 'settings-prose mt-2 text-destructive' : 'settings-prose mt-2'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </Subsection>
  )
})
