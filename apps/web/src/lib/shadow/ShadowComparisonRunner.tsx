/**
 * The `kernel-replica-shadow` flag's mount point (POD-1223).
 *
 * Renders nothing. It owns the second connection's lifetime, samples on a timer,
 * and publishes the latest report on `window.__podiumShadowReport` — which is
 * how a Playwright run reads a verdict out of the real app rather than out of a
 * unit fixture.
 *
 * IT NEVER TOUCHES THE UI. A shadow comparison that could toast, block or
 * re-render would be changing the thing it measures; a divergence is reported to
 * the console and to that window field, and the app behaves identically with the
 * flag on and off.
 */

import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import type { KernelAssembly } from '@/lib/kernelReplica'
import { type ShadowReport, startShadowComparison } from './runner'

declare global {
  // eslint-disable-next-line no-var
  var __podiumShadowReport: ShadowReport | undefined
}

/** How often a sample is taken while the flag is on. */
export const SHADOW_SAMPLE_INTERVAL_MS = 15_000

export function ShadowComparisonRunner({
  assembly,
  trpc,
  wsClientUrl,
  authorityScoped,
  intervalMs = SHADOW_SAMPLE_INTERVAL_MS,
}: {
  assembly: KernelAssembly
  trpc: Trpc
  wsClientUrl: string
  authorityScoped: boolean
  intervalMs?: number
}): null {
  const [, setReport] = useState<ShadowReport | null>(null)
  useEffect(() => {
    const runner = startShadowComparison({
      kernel: assembly.kernel,
      trpc,
      wsClientUrl,
      authorityScoped,
      onKernelEvent: assembly.onKernelEvent,
      onReport: (report) => {
        globalThis.__podiumShadowReport = report
        setReport(report)
        if (report.status === 'could-not-sample') {
          console.warn('[podium] shadow comparison could not sample', report.reason)
          return
        }
        if (report.divergences.length > 0) {
          console.error('[podium] shadow comparison DIVERGENCE', report.divergences)
          return
        }
        console.info('[podium] shadow comparison clean', report.counts)
      },
    })
    void runner.sample()
    const timer = setInterval(() => void runner.sample(), intervalMs)
    return () => {
      clearInterval(timer)
      runner.stop()
    }
  }, [assembly, trpc, wsClientUrl, authorityScoped, intervalMs])
  return null
}
