export interface GrokDirInfo {
  id: string
  createdMs: number
  mtimeMs: number
}

/** Pick the Grok session dir to observe. Binds to the session created after the
 *  spawn watermark (not merely the freshest mtime, which an actively-written
 *  prior session would win), and never re-binds once a dir is chosen. */
export function chooseGrokSessionDir(opts: {
  dirs: GrokDirInfo[]
  watermarkMs: number
  boundId?: string
}): string | undefined {
  const { dirs, watermarkMs, boundId } = opts
  if (boundId && dirs.some((d) => d.id === boundId)) return boundId
  const fresh = dirs.filter((d) => d.createdMs >= watermarkMs)
  if (fresh.length === 0) return undefined
  return fresh.reduce((best, d) => (d.mtimeMs > best.mtimeMs ? d : best)).id
}
