import type { JSX } from 'react'
import { lazy, Suspense } from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'

const MobileHandoffQr = lazy(() =>
  throughRestarts(() => import('./MobileHandoffQr')).then((module) => ({
    default: module.MobileHandoffQr,
  })),
)

/**
 * Keep the QR encoder out of first paint. The code is useful only once one of
 * the phone surfaces is visible, and a fixed-size blank preserves that
 * surface's geometry while its small deferred chunk resolves.
 */
export function DeferredMobileHandoffQr({
  url,
  size,
  className,
}: {
  url: string
  size: number
  className?: string
}): JSX.Element {
  return (
    <Suspense
      fallback={
        <span
          className="flex flex-none"
          style={{ width: size + 8, height: size + 8 }}
          aria-hidden="true"
        />
      }
    >
      <MobileHandoffQr url={url} size={size} {...(className !== undefined ? { className } : {})} />
    </Suspense>
  )
}
