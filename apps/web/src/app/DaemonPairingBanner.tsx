import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { type NativeDaemonConnectivity, nativeDesktopBridge } from '@/lib/nativeDesktop'
import { SKEW_BANNER_HEIGHT_VAR } from './WireSkewBanner'

export const DAEMON_PAIRING_BANNER_HEIGHT_VAR = '--daemon-pairing-banner-h'
export const DAEMON_CONNECTIVITY_POLL_MS = 500

function publicServerAddress(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.split(/[?#]/u, 1)[0] ?? raw
  }
}

function isPairingRefusal(
  status: NativeDaemonConnectivity | null,
): status is NativeDaemonConnectivity & { state: 'unauthorized' } {
  return status?.state === 'unauthorized'
}

export function pairingRefusalMessage(status: NativeDaemonConnectivity): string {
  const target = status.serverUrl ? ` at ${publicServerAddress(status.serverUrl)}` : ''
  return (
    `This machine was not added to the server${target}: its pairing code is invalid, expired, ` +
    'or has already been used. In Settings → Machines → Add machine, create a new one-use code ' +
    'and pair this machine with that new code.'
  )
}

/**
 * A terminal daemon refusal is local shell state, not fleet presence. Read the
 * daemon's durable status until startup reaches connected or terminal, then
 * show the permanent refusal above every authenticated app surface.
 */
export function DaemonPairingBanner(): JSX.Element | null {
  const [refusal, setRefusal] = useState<NativeDaemonConnectivity | null>(null)

  useEffect(() => {
    const bridge = nativeDesktopBridge()
    if (bridge?.launchMode !== 'daemon' || !bridge.daemonConnectivity) return
    const read = bridge.daemonConnectivity
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const status = await read()
        if (disposed) return
        if (isPairingRefusal(status)) {
          setRefusal(status)
          return
        }
        if (status?.state === 'connected') {
          setRefusal(null)
          return
        }
      } catch {
        // An older/mid-upgrade shell may reject the optional command. Silence
        // here preserves the browser and older-shell behavior.
        return
      }
      timer = setTimeout(() => void poll(), DAEMON_CONNECTIVITY_POLL_MS)
    }

    void poll()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const measure = useCallback((element: HTMLDivElement | null) => {
    const root = document.documentElement
    if (!element) {
      root.style.removeProperty(DAEMON_PAIRING_BANNER_HEIGHT_VAR)
      return
    }
    const publish = () => {
      root.style.setProperty(
        DAEMON_PAIRING_BANNER_HEIGHT_VAR,
        `${Math.ceil(element.getBoundingClientRect().height)}px`,
      )
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty(DAEMON_PAIRING_BANNER_HEIGHT_VAR)
    }
  }, [])

  if (!refusal) return null

  return (
    <div
      ref={measure}
      role="alert"
      data-testid="daemon-pairing-banner"
      style={{
        position: 'fixed',
        insetInline: 0,
        top: `var(${SKEW_BANNER_HEIGHT_VAR}, 0px)`,
        zIndex: 2147483646,
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        background: '#7f1d1d',
        color: '#fff7ed',
        padding: '10px 16px',
        font: '600 13px/1.5 ui-sans-serif, system-ui, sans-serif',
        boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      }}
    >
      <span>{pairingRefusalMessage(refusal)}</span>
      <button
        type="button"
        data-pressable
        onClick={() =>
          (
            globalThis as {
              __PODIUM_SETTINGS__?: () => void
            }
          ).__PODIUM_SETTINGS__?.()
        }
        style={{
          border: '1px solid currentColor',
          borderRadius: '6px',
          padding: '2px 10px',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        Open settings
      </button>
    </div>
  )
}
