/**
 * Who may use one stored key (POD-6390, over `accounts.share` from POD-6360).
 *
 * A managed key belongs to the user who connected it and reaches nobody else's
 * agents until its owner (or an admin) shares it: with everyone, or with named
 * people. The control shows the current sharing under the key's row and edits it
 * in place; saving replaces the whole sharing list, and choosing "Only you"
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
import { Button } from '@/components/ui/button'
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
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<Mode>(() => modeOf(sharing))
  const [picked, setPicked] = useState<readonly string[]>(() => sharing?.users ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const keyOwner = owner ?? currentMemberId
  const keyName = `${keyOwner ?? 'me'}-${accountId}`
  // Everyone the editor can offer: the directory's active members (not the key's
  // owner, who always has their own key), then anyone already named the
  // directory does not offer (gone, disabled, or no directory), so they can
  // still be removed.
  const known = (directory?.members ?? []).filter(
    (member) => member.id !== keyOwner && !member.disabledAt,
  )
  const knownIds = new Set(known.map((member) => member.id))
  const extra = (sharing?.users ?? []).filter((id) => !knownIds.has(id))
  const canPick = known.length > 0 || extra.length > 0

  const open = (): void => {
    setMode(modeOf(sharing))
    setPicked(sharing?.users ?? [])
    setError(null)
    setEditing(true)
  }

  const toggle = (id: string): void =>
    setPicked((users) =>
      users.includes(id) ? users.filter((user) => user !== id) : [...users, id],
    )

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await trpc.accounts.share.mutate({
        id: accountId,
        ...(owner ? { owner } : {}),
        everyone: mode === 'everyone',
        users: mode === 'people' ? [...picked] : [],
      })
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const peopleEmpty = mode === 'people' && picked.length === 0

  if (!editing) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pb-2.5">
        <span className="settings-micro">Shared with</span>
        <span className="settings-prose">
          {sharingSummary(directory, sharing, owner ? 'its owner' : 'you')}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Change who can use ${label}`}
          onClick={open}
        >
          Change
        </Button>
      </div>
    )
  }

  return (
    <fieldset className="space-y-2 pb-3" aria-label={`Who can use ${label}`} disabled={busy}>
      <legend className="settings-micro pb-1">Who can use this key</legend>
      <ModeOption name={keyName} value="private" mode={mode} onPick={setMode}>
        Only {owner ? 'its owner' : 'you'}
      </ModeOption>
      <ModeOption name={keyName} value="everyone" mode={mode} onPick={setMode}>
        Everyone on this server
      </ModeOption>
      <ModeOption name={keyName} value="people" mode={mode} onPick={setMode} disabled={!canPick}>
        Specific people
      </ModeOption>
      {!canPick && (
        <p className="max-w-[62ch] pl-6 settings-prose">
          No other active members are available to select.
        </p>
      )}
      {mode === 'people' && canPick && (
        <div className="space-y-1 pl-6">
          {known.map((member) => (
            <PersonOption
              key={member.id}
              id={member.id}
              name={nameOf(directory, member.id) ?? 'Member'}
              checked={picked.includes(member.id)}
              onToggle={toggle}
            />
          ))}
          {extra.map((id) => (
            <PersonOption
              key={id}
              id={id}
              name={nameOf(directory, id) ?? id}
              checked={picked.includes(id)}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
      <p className="max-w-[62ch] settings-prose">
        {mode === 'private'
          ? 'Nobody else’s agents can use it. Agents already running keep their key until they restart.'
          : 'Their agents use it when they have no key of their own. Removing someone stops their next agent start.'}
      </p>
      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" disabled={busy || peopleEmpty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="max-w-[62ch] settings-prose text-destructive">{error}</p>}
    </fieldset>
  )
})

function ModeOption({
  name,
  value,
  mode,
  onPick,
  disabled = false,
  children,
}: {
  name: string
  value: Mode
  mode: Mode
  onPick: (mode: Mode) => void
  disabled?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <label
      className="flex items-center gap-2 settings-prose aria-disabled:opacity-60"
      aria-disabled={disabled}
    >
      <input
        type="radio"
        name={`sharing-${name}`}
        value={value}
        checked={mode === value}
        disabled={disabled}
        onChange={() => onPick(value)}
      />
      {children}
    </label>
  )
}

function PersonOption({
  id,
  name,
  checked,
  onToggle,
}: {
  id: string
  name: string
  checked: boolean
  onToggle: (id: string) => void
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 settings-prose">
      <input type="checkbox" checked={checked} onChange={() => onToggle(id)} />
      {name}
    </label>
  )
}

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
