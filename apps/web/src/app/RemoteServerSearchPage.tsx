import { CONNECT_DEFAULT_BASE_URL } from '@podium/protocol/server-locate'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { restartPodiumShell } from '@/features/setup/restart-shell'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { BootScreen } from './BootScreen'
import { startBundledServerSearch } from './server-follow'

/**
 * THE DESKTOP WINDOW'S SERVER DID NOT ANSWER AT COLD START (POD-5921). The
 * shell opened this bundled page instead of a dead address's error page. It
 * boots nothing — no login, no setup, no local onboarding — and only looks
 * for the server: the stored address, then wherever Connect says it went,
 * accepting an address only once it proves it holds the installation key.
 * The shell then moves the window there.
 */
export function RemoteServerSearchPage({ serverUrl }: { serverUrl: string }): JSX.Element {
  const [status, setStatus] = useState('Looking for your server…')
  useEffect(() => {
    const bridge = nativeDesktopBridge()
    const identity = bridge?.serverIdentity
    if (!bridge?.moveServer || !identity) {
      setStatus('This app cannot look for your server. Restart Podium once it is back.')
      return
    }
    return startBundledServerSearch({
      serverUrl,
      identity,
      moveServer: bridge.moveServer,
      connectBaseUrl: CONNECT_DEFAULT_BASE_URL,
      log: (event) => {
        if (event.kind === 'found') setStatus(`Found it at ${new URL(event.origin).host}`)
        else if (event.kind === 'adopt-failed') setStatus('Found it, but could not open it yet')
      },
    })
  }, [serverUrl])
  let host = serverUrl
  try {
    host = new URL(serverUrl).host
  } catch {
    // Shown as configured.
  }
  return (
    <BootScreen
      eyebrow="Server / connecting"
      headline={'Connecting to\nyour server'}
      prose="Podium could not reach your server at its last address. If it moved — a tunnel that restarted, a server that was transferred — this window finds it and opens it on its own."
      fields={[
        { label: 'Last address', value: host },
        { label: 'Status', value: status },
      ]}
      trace={{ from: 'Desktop app', to: 'Your server' }}
      pending
      reassurance="Nothing on your server is lost while this window looks for it."
      primary={{
        label: 'Restart Podium',
        onClick: () => void restartPodiumShell(),
      }}
      panelLabel="Connection"
    />
  )
}
