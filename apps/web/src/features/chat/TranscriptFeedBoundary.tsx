import { lazy } from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'

// EVERY LAZY SURFACE GOES THROUGH `throughRestarts` (POD-2762) — including this
// one, which only looks like an exception because the lazy declaration moved out
// of ChatView after that sweep had already been made. The transcript is the
// surface most likely to be asked for during a handover, not the least.
export const TranscriptFeedBoundary = lazy(() =>
  throughRestarts(() => import('./TranscriptFeed')).then((module) => ({
    default: module.TranscriptFeed,
  })),
)
