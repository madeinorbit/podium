import { useEffect, useState } from 'react'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import type { AuthBootstrap } from '@/lib/use-kernel-replica'
import { clientRegistration } from './client-registration'
import type { Trpc } from './trpc'

/** Mounted in the shared app lifecycle, after LoginGate confirms live authentication. */
export function ClientRegistrationNotice({ auth, trpc }: { auth?: AuthBootstrap; trpc: Trpc }) {
  const [error, setError] = useState<string | null>(null)
  const authenticated = auth?.kind === 'principal'
  useEffect(() => {
    if (!authenticated) return
    let disposed = false
    void clientRegistration.start(nativeDesktopBridge(), trpc).then((message) => {
      if (!disposed) setError(message)
    })
    return () => {
      disposed = true
    }
  }, [authenticated, trpc])

  if (!error) return null
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-[2147483646] border-t border-border bg-background p-3 text-center text-sm"
    >
      {error}
    </div>
  )
}
