import type { JSX } from 'react'
import { BootScreen } from '@/app/BootScreen'
import { endpointLabel } from '@/lib/replica-failure'

/**
 * A recovery console for the one startup failure developers can usually fix
 * themselves.
 *
 * It was the first screen in Podium to treat a failure as something worth
 * designing, and POD-1304 made its composition the shared one — so what is left
 * here is only what is TRUE of this fault: the backend never answered.
 */
export function SetupUnreachable({
  httpOrigin,
  onRetry,
}: {
  httpOrigin: string
  onRetry: () => void
}): JSX.Element {
  return (
    <BootScreen
      eyebrow="Connection / interrupted"
      headline={'The backend\nwent quiet.'}
      prose="Your interface is ready, but the Podium server never answered. Your work is still on the host — restore the process, then reconnect."
      trace={{ from: 'this browser', to: 'server' }}
      fields={[
        { label: 'Target', value: endpointLabel(httpOrigin) },
        { label: 'Next check', value: 'podium status', tone: 'command' },
      ]}
      reassurance="retrying automatically — this screen clears itself"
      primary={{ label: 'Retry connection', onClick: onRetry }}
    />
  )
}
