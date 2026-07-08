import { z } from 'zod'

// ---- Omni-search (docs/spec/search-v1.md §2.4) ----
// One ranked hit from `search.query`, typed by source. `id` is kind-scoped (the
// sessionId / issue id / conversation id / segment item / setting key); the
// optional refs carry what a client needs to OPEN the hit without a second
// round-trip. `score` is the fused rank — comparable across kinds, higher = better.
export const SearchResultKind = z.enum([
  'session',
  'issue',
  'conversation',
  'transcript',
  'setting',
])
export type SearchResultKind = z.infer<typeof SearchResultKind>
export const SearchResultWire = z.object({
  kind: SearchResultKind,
  id: z.string(),
  title: z.string(),
  /** Matched context (FTS snippet with `**` match markers, or a body excerpt). */
  snippet: z.string().optional(),
  score: z.number(),
  /** Recency evidence that fed the ranking, when the source has one (ISO 8601). */
  ts: z.string().optional(),
  // Open-the-hit refs.
  sessionId: z.string().optional(),
  machineId: z.string().optional(),
  /** Native conversation id (transcript hits — pairs with machineId). */
  nativeId: z.string().optional(),
  /** Registry identity of the conversation a transcript hit belongs to. */
  podiumId: z.string().optional(),
  repoPath: z.string().optional(),
  settingKey: z.string().optional(),
})
export type SearchResultWire = z.infer<typeof SearchResultWire>
