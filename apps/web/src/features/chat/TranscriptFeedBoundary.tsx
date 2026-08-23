import { lazy } from 'react'

export const TranscriptFeedBoundary = lazy(() =>
  import('./TranscriptFeed').then((module) => ({ default: module.TranscriptFeed })),
)
