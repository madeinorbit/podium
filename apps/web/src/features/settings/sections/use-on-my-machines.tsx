import type { HarnessAgent } from '@podium/runtime'
import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { Trpc } from '@/app/trpc'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { AccountView } from './shared'

/** The personal login copy switch (D11). */
export const USE_ON_MY_MACHINES_LABEL = 'Use on all my machines'

/** Said once in the section help: it reaches future machines, and unticking recalls nothing. */
export const USE_ON_MY_MACHINES_NOTE =
  'Use on all my machines copies a login to every machine you look after, including ones you add later. ' +
  'It never replaces a different login already there, and turning it off stops future copies. Copies already made stay where they are.'

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
 * THE D11 SWITCH (POD-6301; design §2.5). One per detected account, unticked
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

  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setOptimistic(enabled)
    try {
      await trpc.accounts.useOnMyMachines.mutate({ harness, fingerprint, enabled })
      onChanged()
      toast('Saved', { action: { label: 'Undo', onClick: () => void change(!enabled) } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOptimistic(null)
      setBusy(false)
    }
  }

  return (
    <div>
      <Label className="cursor-pointer gap-2 settings-micro">
        <Switch
          checked={checked}
          disabled={busy}
          aria-label={`${USE_ON_MY_MACHINES_LABEL} (${account.identity ?? harness})`}
          onCheckedChange={(next) => void change(next)}
        />
        <span>{USE_ON_MY_MACHINES_LABEL}</span>
      </Label>
      {error && (
        <p role="alert" className="mt-1 settings-prose text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
