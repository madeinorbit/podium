import { useState } from 'react'
import { useAccount } from '@/lib/account-context'
import { Button } from '@/components/ui/button'
import { Section } from './shared'

export function PodiumAccountSection() {
  const account = useAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!account) return null
  return (
    <Section
      title="This account"
      hint="Sign out to use another account. This removes this account’s offline data and queued changes from this device."
    >
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void account.signOut().catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            setBusy(false)
          })
        }}
      >
        Sign out
      </Button>
      {error && (
        <p role="alert" className="settings-prose text-destructive">
          {error}
        </p>
      )}
    </Section>
  )
}
