import type { JSX } from 'react'
import { useState } from 'react'
import { pairNativeDesktop } from '@/app/native-pairing'
import { Button } from '@/components/ui/button'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'

/** State + action shared by the standalone card and the inline row button. [spec:SP-3701] */
export interface EnableHosting {
  busy: boolean
  error: string | null
  enable: () => Promise<void>
}

/**
 * [spec:SP-3701] The one-click "host sessions on this device" flow: mint a pairing code on
 * this hub, hand it to the shell (which flips the local config to daemon mode), restart.
 * Returns null outside a client-mode desktop shell — the only place hosting can be enabled.
 */
export function useEnableHosting(trpc: import('@/app/trpc').Trpc): EnableHosting | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bridge = nativeDesktopBridge()
  if (bridge?.launchMode !== 'client' || !bridge.enableHosting) return null
  const enableHosting = bridge.enableHosting

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      await pairNativeDesktop(
        trpc,
        enableHosting,
        'Hosting enabled — quit and reopen the app to finish pairing.',
      )
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return { busy, error, enable }
}

/**
 * [spec:SP-3701] Standalone hosting card, shown ONLY when this device never paired before —
 * a previously-paired device gets the inline "Enable" action on its machine row instead.
 */
export function HostThisDeviceCard({ hosting }: { hosting: EnableHosting }): JSX.Element {
  const { busy, error, enable } = hosting
  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="settings-label">This device</div>
        <p className="settings-prose mt-1">
          {error ?? 'Run sessions on this computer too. The app will restart to pair it.'}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="flex-none"
        disabled={busy}
        onClick={() => void enable()}
      >
        {busy ? 'Enabling…' : 'Host sessions on this device'}
      </Button>
    </div>
  )
}
