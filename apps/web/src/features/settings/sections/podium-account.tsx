/** Signing out on this device (POD-6292, MU-12): the next person sees nothing of this one's. */
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useAccount } from '@/lib/account-context'
import { useSettingsUnsyncedChangeCount } from '../readers'
import { Section } from './shared'

export function PodiumAccountSection() {
  const account = useAccount()
  const unsyncedChangeCount = useSettingsUnsyncedChangeCount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  if (!account) return null
  const signOut = () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void account.signOut().catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    })
  }
  return (
    <Section
      title="This account"
      hint="Sign out to use another account. This removes this account’s offline data and queued changes from this device, and closes it in every other tab."
    >
      <Button
        type="button"
        variant="outline"
        disabled={busy || unsyncedChangeCount === null}
        onClick={() => {
          if (unsyncedChangeCount === null) return
          if (unsyncedChangeCount > 0) setConfirming(true)
          else signOut()
        }}
      >
        Sign out
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out with unsynced changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {unsyncedChangeCount === 0
                ? 'All changes on this device have synced.'
                : unsyncedChangeCount === 1
                  ? "1 change on this device hasn't synced yet and will be lost."
                  : `${unsyncedChangeCount} changes on this device haven't synced yet and will be lost.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Wait</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={signOut}>
              {unsyncedChangeCount === 0 ? 'Sign out' : 'Sign out anyway'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <p role="alert" className="settings-prose text-destructive">
          {error}
        </p>
      )}
    </Section>
  )
}
