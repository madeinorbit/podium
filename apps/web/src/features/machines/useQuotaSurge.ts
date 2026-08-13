import { quotaSurge } from '@podium/client-core/viewmodels'
import { useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'podium.quota.lastSeen.v1'
const SURGE_MS = 1000

function readLastSeen(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeLastSeen(seen: Record<string, number>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // Private mode / quota — the in-memory ref still covers this session.
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Which quota pools should play the one-shot surge. First paint with no prior
 * value stays still; a later jump of ≥15pp (including a window reset) fires.
 * Last-seen is kept in sessionStorage so a morning reload can still play.
 */
export function useQuotaSurge(pools: { key: string; percent: number }[]): Set<string> {
  const seenRef = useRef<Record<string, number> | null>(null)
  const [surging, setSurging] = useState<Set<string>>(() => new Set())
  const signature = pools
    .map((pool) => `${pool.key}:${pool.percent}`)
    .sort()
    .join('|')

  useEffect(() => {
    const next: Record<string, number> = {}
    if (signature) {
      for (const part of signature.split('|')) {
        const cut = part.lastIndexOf(':')
        next[part.slice(0, cut)] = Number(part.slice(cut + 1))
      }
    }
    if (seenRef.current === null) seenRef.current = readLastSeen()
    const prev = seenRef.current
    const keys = Object.keys(next).filter((key) => quotaSurge(prev[key], next[key]!))
    seenRef.current = { ...prev, ...next }
    writeLastSeen(seenRef.current)
    if (keys.length === 0 || prefersReducedMotion()) return
    setSurging(new Set(keys))
    const t = window.setTimeout(() => setSurging(new Set()), SURGE_MS)
    return () => window.clearTimeout(t)
  }, [signature])

  return surging
}
