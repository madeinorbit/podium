export interface GrokDirInfo {
  id: string
  createdMs: number
  mtimeMs: number
}

/** Pick the Grok session dir to observe. Binds to the session created after the
 *  spawn watermark (not merely the freshest mtime, which an actively-written
 *  prior session would win), and never re-binds once a dir is chosen.
 *
 *  `excludeIds` are dirs already claimed by OTHER live sessions: a grok session
 *  dir maps to at most one Podium session, so an unbound session must skip them.
 *  Without this, two unbound sessions reattaching with watermark 0 both pick the
 *  freshest dir and collide on one resume ref (the prod mis-bind). A session's own
 *  `boundId` is always honored — it is its own claim, never someone else's. */
export function chooseGrokSessionDir(opts: {
  dirs: GrokDirInfo[]
  watermarkMs: number
  boundId?: string
  excludeIds?: ReadonlySet<string>
}): string | undefined {
  const { dirs, watermarkMs, boundId, excludeIds } = opts
  if (boundId && dirs.some((d) => d.id === boundId)) return boundId
  const fresh = dirs.filter((d) => d.createdMs >= watermarkMs && !excludeIds?.has(d.id))
  if (fresh.length === 0) return undefined
  return fresh.reduce((best, d) => (d.mtimeMs > best.mtimeMs ? d : best)).id
}
