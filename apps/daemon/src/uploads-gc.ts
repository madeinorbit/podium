/**
 * Pure helper: given a list of upload files (with their mtime) return the paths
 * that are older than `ttlMs` and should be deleted.
 */
export function uploadsToGc(
  files: { path: string; mtimeMs: number }[],
  nowMs: number,
  ttlMs: number,
): string[] {
  return files.filter((f) => nowMs - f.mtimeMs > ttlMs).map((f) => f.path)
}
