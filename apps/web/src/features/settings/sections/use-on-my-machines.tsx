import type { HarnessAgent } from '@podium/runtime'
import type { JSX } from 'react'
import { useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { AccountView } from './shared'

/** The D11 label, word for word (September addendum §4). */
export const USE_ON_MY_MACHINES_LABEL =
  'Automatically transfer and use these credentials on other machines I own'

/** Said once beside the box: it reaches future machines, and unticking recalls nothing. */
export const USE_ON_MY_MACHINES_NOTE =
  'Includes machines you add later. Never replaces a different login already on a machine. ' +
  'Turning it off stops future copies; copies already made stay where they are.'

/** Only a native login with a known identity has the box (POD-6301). */
export function hasUseOnMyMachinesBox(account: AccountView): boolean {
  return (
    account.source === 'native' &&
    account.harness !== undefined &&
    account.identityFingerprint !== undefined &&
    account.useOnMyMachines !== undefined
  )
}

/**
 * THE D11 CHECKBOX (POD-6301; design §2.5). One per detected account, unticked
 * by default: ticked, Podium copies this login to every machine the person looks
 * after, now and in future, and uses it there.
 */
export function UseOnMyMachinesBox({
  account,
  trpc,
  onChanged,
}: {
  account: AccountView
  trpc: Pick<Trpc, 'accounts'>
  onChanged: () => void
}): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  if (!hasUseOnMyMachinesBox(account) || !account.harness || !account.identityFingerprint) {
    return null
  }
  const harness = account.harness as HarnessAgent
  const fingerprint = account.identityFingerprint
  const checked = optimistic ?? account.useOnMyMachines === true
  const kept = account.keptOn ?? []

  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setOptimistic(enabled)
    try {
      await trpc.accounts.useOnMyMachines.mutate({ harness, fingerprint, enabled })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOptimistic(null)
      setBusy(false)
    }
  }

  return (
    <div className="pb-2.5">
      <Label className="cursor-pointer items-start gap-2 text-[12.5px]">
        <Checkbox
          checked={checked}
          disabled={busy}
          aria-label={`${USE_ON_MY_MACHINES_LABEL} (${account.identity ?? harness})`}
          onCheckedChange={(next) => void change(next === true)}
        />
        <span>{USE_ON_MY_MACHINES_LABEL}</span>
      </Label>
      <p className="ml-6 max-w-[62ch] settings-prose">{USE_ON_MY_MACHINES_NOTE}</p>
      {kept.length > 0 && (
        <p className="ml-6 max-w-[62ch] settings-prose text-warning">
          Not copied to {kept.map((machine) => machine.name).join(', ')}: a different login is
          signed in there, and Podium kept it.
        </p>
      )}
      {error && (
        <p role="alert" className="ml-6 max-w-[62ch] settings-prose text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
