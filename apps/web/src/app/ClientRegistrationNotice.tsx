import { useEffect, useState } from 'react'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import type { AuthBootstrap } from '@/lib/use-kernel-replica'
import { clientRegistration } from './client-registration'
import type { Trpc } from './trpc'

/** Mounted in the shared app lifecycle, after LoginGate confirms live authentication. */
export function ClientRegistrationNotice({ auth, trpc }: { auth?: AuthBootstrap; trpc: Trpc }) {
  const [notice, setNotice] = useState<{
    principal: string
    trpc: Trpc
    message: string | null
  }>()
  const principal = auth?.kind === 'principal' ? auth.principal : undefined
  useEffect(() => {
    if (principal === undefined) return
    let disposed = false
    void clientRegistration.start(nativeDesktopBridge(), trpc, principal).then((message) => {
      if (!disposed) setNotice({ principal, trpc, message })
    })
    return () => {
      disposed = true
    }
  }, [principal, trpc])

  const error = notice?.principal === principal && notice?.trpc === trpc ? notice.message : null
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
