import { normalizeRepoPath } from '../../../store/repos'

export interface GitWorktreeRecord {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
}

/** Parse git worktree list --porcelain -z without path quoting. */
export function parseGitWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = []
  let current: GitWorktreeRecord | null = null
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) records.push(current)
      current = {
        path: normalizeRepoPath(field.slice('worktree '.length)),
        head: null,
        branch: null,
        detached: false,
      }
      continue
    }
    if (!current) continue
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length)
    } else if (field === 'detached') current.detached = true
  }
  if (current) records.push(current)
  return records
}

export function sameWorktreePath(left: string, right: string): boolean {
  return normalizeRepoPath(left) === normalizeRepoPath(right)
}
