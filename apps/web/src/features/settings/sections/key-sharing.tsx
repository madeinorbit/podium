/**
 * Who may use one stored key (POD-6390, over `accounts.share` from POD-6360).
 *
 * A managed key belongs to the user who connected it and reaches nobody else's
 * agents until its owner (or an admin) shares it: with everyone, or with named
 * people. The control shows the current sharing under the key's row and edits it
 * in place; each change replaces the sharing list, and choosing "Only you"
 * revokes every share.
 *
 * Named people come from the member-readable directory of active names and
 * roles (`/auth/members/directory`). If it cannot load, existing shares can
 * still be removed or revoked.
 */

import type { MemberRoster } from '@podium/client-graph/member-roster'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Row } from './shared'
import { useSettingsTrpc } from '../stable-access'

type Mode = 'private' | 'everyone' | 'people'

export interface KeySharingValue {
  everyone: boolean
  users: readonly string[]
}

/** The member's name if the directory knows them; never invents one. */
function nameOf(directory: MemberRoster | null, id: string): string | undefined {
  return directory?.nameOf(id)
}

/** "Ana", "Ana and Ben", "Ana, Ben and 2 others": names when known, else a count. */
export function peopleSummary(directory: MemberRoster | null, users: readonly string[]): string {
  const names = users.flatMap((id) => nameOf(directory, id) ?? [])
  const unnamed = users.length - names.length
  if (names.length === 0) return unnamed === 1 ? '1 person' : `${unnamed} people`
  const parts = unnamed > 0 ? [...names, unnamed === 1 ? '1 other' : `${unnamed} others`] : names
  return parts.length === 1
    ? (parts[0] as string)
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** `whose` names the key's owner when it is not the viewer's: "Only its owner". */
export function sharingSummary(
  directory: MemberRoster | null,
  sharing: KeySharingValue | undefined,
  whose: 'you' | 'its owner' = 'you',
): string {
  if (!sharing || (!sharing.everyone && sharing.users.length === 0)) return `Only ${whose}`
  if (sharing.everyone) return 'Everyone on this server'
  return peopleSummary(directory, sharing.users)
}

const modeOf = (sharing: KeySharingValue | undefined): Mode =>
  sharing?.everyone ? 'everyone' : (sharing?.users.length ?? 0) > 0 ? 'people' : 'private'

/**
 * The sharing line under a key the viewer owns. `owner` is set only when an
 * admin manages another user's key; it is passed through to `accounts.share`.
 */
export const KeySharing = observer(function KeySharing({
  accountId,
  label,
  sharing,
  owner,
  directory,
  currentMemberId,
  onChanged,
}: {
  accountId: string
  label: string
  sharing: KeySharingValue | undefined
  owner?: string
  directory: MemberRoster | null
  currentMemberId?: string
  onChanged: () => void
}): JSX.Element {
  const trpc = useSettingsTrpc()
  const [mode, setMode] = useState<Mode>(() => modeOf(sharing))
  const [picked, setPicked] = useState<readonly string[]>(() => sharing?.users ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setMode(modeOf(sharing))
    setPicked(sharing?.users ?? [])
  }, [sharing])

  const keyOwner = owner ?? currentMemberId
  const known = (directory?.members ?? []).filter((member) => member.id !== keyOwner && !member.disabledAt)
  const knownIds = new Set(known.map((member) => member.id))
  const extra = picked.filter((id) => !knownIds.has(id))
  const canPick = known.length > 0 || extra.length > 0

  const save = async (nextMode: Mode, users: readonly string[], undo = true): Promise<void> => {
    if (busy) return
    const previousMode = mode
    const previousUsers = picked
    setMode(nextMode)
    setPicked(users)
    // Choosing the people editor needs a person before there is a share to save.
    if (nextMode === 'people' && users.length === 0 && mode !== 'people') return
    setBusy(true)
    setError(null)
    try {
      await trpc.accounts.share.mutate({
        id: accountId,
        ...(owner ? { owner } : {}),
        everyone: nextMode === 'everyone',
        users: nextMode === 'people' ? [...users] : [],
      })
      onChanged()
      toast('Saved', undo ? { action: { label: 'Undo', onClick: () => void save(previousMode, previousUsers, false) } } : undefined)
    } catch (e) {
      setMode(previousMode)
      setPicked(previousUsers)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row label="Share with" error={error} pending={busy}>
        <fieldset aria-label={`Who can use ${label}`} disabled={busy} className="m-0 flex min-w-0 rounded-lg border border-hairline-soft bg-muted/40 p-0.5">
          {([
            ['private', owner ? 'Only its owner' : 'Only you'],
            ['everyone', 'Everyone'],
            ['people', 'Specific people'],
          ] as const).map(([value, text]) => <Button key={value} type="button" size="sm" variant="ghost" aria-pressed={mode === value} disabled={busy || (value === 'people' && !canPick)} className={mode === value ? 'bg-secondary text-foreground' : 'text-muted-foreground'} onClick={() => void save(value, value === 'people' ? picked : [])}>{text}</Button>)}
        </fieldset>
      </Row>
      {!canPick && <p className="settings-list-note settings-prose">{directory?.loading ? 'Loading people…' : directory?.error ? 'People could not be loaded. Existing shares can still be removed.' : 'No other active members are available to select.'}</p>}
      {mode === 'people' && <>
        {known.map((member) => <Row key={member.id} label={nameOf(directory, member.id) ?? 'Member'}>
          <Switch aria-label={nameOf(directory, member.id) ?? 'Member'} checked={picked.includes(member.id)} disabled={busy} onCheckedChange={(checked) => void save('people', checked ? [...picked, member.id] : picked.filter((id) => id !== member.id))} />
        </Row>)}
        {extra.map((id) => <Row key={id} label={nameOf(directory, id) ?? id}>
          <Switch aria-label={nameOf(directory, id) ?? id} checked disabled={busy} onCheckedChange={() => void save('people', picked.filter((user) => user !== id))} />
        </Row>)}
      </>}
    </>
  )
})

/** One row of `accounts.keys`: another user's stored key, as an admin sees it. */
export interface StoredKey {
  owner: string
  id: string
  provider: string
  kind: 'api-key' | 'oauth'
  identity?: string
  sharing: KeySharingValue
}

/** The admin's answer to "whose keys exist": a request answer, dropped on close. */
export class StoredKeys extends RequestAnswer<readonly StoredKey[]> {
  dispose(): void {
    this.close()
  }
}

/**
 * Every OTHER member's stored keys, for an admin to manage their sharing. Drawn
 * only when the admin viewer offers People; the server refuses `accounts.keys`
 * below the admin floor regardless. The viewer's
 * own keys are not repeated here: their rows above carry the control.
 */
export const MembersKeys = observer(function MembersKeys({
  directory,
  labelOf,
  group,
}: {
  directory: MemberRoster
  labelOf: (key: { id: string; provider: string }) => string
  group: (children: React.ReactNode) => JSX.Element
}): JSX.Element | null {
  const trpc = useSettingsTrpc()
  const [keys] = useState(() => new StoredKeys())
  const reload = (): Promise<void> => keys.load(() => trpc.accounts.keys.query({}))
  // biome-ignore lint/correctness/useExhaustiveDependencies: one read per opening; Save reloads.
  useEffect(() => {
    void reload()
    return () => keys.dispose()
  }, [keys])

  const me = directory.currentMemberId
  const others = (keys.answer ?? []).filter((key) => key.owner !== me)
  if (keys.error) {
    return group(<p className="py-2.5 settings-prose text-destructive">{keys.error}</p>)
  }
  if (!keys.answer) return null
  return group(
    others.length === 0 ? (
      <p className="py-2.5 settings-prose">No other member has stored a key.</p>
    ) : (
      others.map((key) => {
        const label = labelOf(key)
        const ownerName = nameOf(directory, key.owner) ?? key.owner
        return (
          <div key={`${key.owner}-${key.id}`} className="pt-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="settings-prose">
                <span className="font-medium text-foreground">{ownerName}</span> · {label}
              </span>
              {key.identity && (
                <span className="font-mono text-[12px] text-muted-foreground">{key.identity}</span>
              )}
            </div>
            <KeySharing
              accountId={key.id}
              label={`${ownerName}'s ${label}`}
              sharing={key.sharing}
              owner={key.owner}
              directory={directory}
              currentMemberId={me}
              onChanged={() => void reload()}
            />
          </div>
        )
      })
    ),
  )
})
