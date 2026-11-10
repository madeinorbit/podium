import { omitGone } from '@podium/client-graph/lookup'
import { type MachineGrantEntry, SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { type JSX, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import { useMemberRoster } from '@/lib/member-roster'

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

const VERB_LABEL: Record<MachineGrantEntry['verb'], string> = {
  use: 'can run agents',
  see: 'can see',
  manage: 'can manage',
}

/** What a removal tells the person who made it. */
const REMOVED_LABEL: Record<MachineGrantEntry['verb'], string> = {
  use: 'can no longer start agents here. Sessions already running finish.',
  see: 'can no longer see this machine.',
  manage: 'can no longer manage this machine.',
}

/** "8 Nov 2026"; an unreadable time shows nothing rather than "Invalid Date". */
function grantedOn(at: string): string | undefined {
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * CUSTODY, AND GIVING ANOTHER MEMBER USE OF A MACHINE (POD-6299; design §2.4).
 *
 * Names who holds custody of the machine. Where the server says the viewer
 * holds custody authority (the custodian, or an admin: `transferable`), it
 * offers to give another member `use`. Both people's agents then run under the
 * machine's one operating-system account, so the grant shows the server's
 * warning and is sent acknowledged only once the person ticks that they
 * understand it (POD-6300 refuses an unacknowledged grant).
 *
 * WHO ELSE HAS ACCESS (POD-6700). The custodian's and admins' rows carry the
 * machine's grants; each can be removed. Removal stops new sessions there; a
 * session already running finishes.
 */
export const MachineCustody = observer(function MachineCustody({
  machineId,
  transferable,
  trpc,
}: {
  machineId: string
  transferable: boolean
  trpc: MachineShareApi
}): JSX.Element | null {
  const pool = useWorklistPool()
  const roster = useMemberRoster(true)
  const model = pool ? omitGone(pool.model('machine', machineId)) : undefined
  const custodian = model && typeof model === 'object' ? (model.custodian ?? undefined) : undefined
  const grants =
    model && typeof model === 'object' && Array.isArray(model.grants)
      ? (model.grants as readonly MachineGrantEntry[])
      : []
  const [open, setOpen] = useState(false)
  const [grantee, setGrantee] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const candidates = (roster?.members ?? []).filter((member) => member.id !== custodian)
  const custodianName = custodian ? (roster?.nameOf(custodian) ?? 'A member') : undefined
  if (!custodianName && !(transferable && candidates.length > 0) && grants.length === 0) return null
  const close = () => {
    setOpen(false)
    setGrantee('')
    setUnderstood(false)
  }
  const share = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await trpc.machines.share.mutate({
        id: machineId,
        grantee,
        verb: 'use',
        acknowledgeSharedMachine: true,
      })
      setMessage({
        error: false,
        text: `${roster?.nameOf(grantee) ?? 'They'} can now run agents here.`,
      })
      close()
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (grant: MachineGrantEntry) => {
    setBusy(true)
    setMessage(null)
    try {
      await trpc.machines.unshare.mutate({
        id: machineId,
        grantee: grant.grantee,
        verb: grant.verb,
      })
      setMessage({
        error: false,
        text: `${roster?.nameOf(grant.grantee) ?? 'They'} ${REMOVED_LABEL[grant.verb]}`,
      })
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {custodianName && <span className="settings-prose">Custody: {custodianName}</span>}
      {transferable && grants.length > 0 && (
        <ul aria-label="Who else has access" className="flex flex-col gap-1">
          {grants.map((grant) => {
            const on = grantedOn(grant.grantedAt)
            const by = grant.grantedBy ? roster?.nameOf(grant.grantedBy) : undefined
            return (
              <li key={`${grant.grantee}:${grant.verb}`} className="flex items-center gap-2">
                <span className="settings-prose">
                  {roster?.nameOf(grant.grantee) ?? 'A member'} {VERB_LABEL[grant.verb]}
                  {on ? ` · since ${on}` : ''}
                  {by ? ` · given by ${by}` : ''}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${roster?.nameOf(grant.grantee) ?? 'this member'}: ${VERB_LABEL[grant.verb]}`}
                  onClick={() => void remove(grant)}
                >
                  Remove
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {transferable && candidates.length > 0 && !open && (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          Give use…
        </Button>
      )}
      {open && (
        <div role="dialog" aria-label="Give use of this machine" className="space-y-2">
          <label className="block">
            Member
            <select
              className="block w-full bg-background p-2"
              value={grantee}
              onChange={(e) => setGrantee(e.target.value)}
            >
              <option value="">Choose a member</option>
              {candidates.map((member) => (
                <option key={member.id} value={member.id}>
                  {roster?.nameOf(member.id) ?? member.displayName}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-prose" role="note">
            {SHARED_MACHINE_ACCOUNT_WARNING}
          </p>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            I understand that we will share this machine’s account
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy || !grantee || !understood}
            onClick={() => void share()}
          >
            Give use
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
        </div>
      )}
      {message && (
        <p
          className={message.error ? 'settings-prose text-destructive!' : 'settings-prose'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </div>
  )
})
