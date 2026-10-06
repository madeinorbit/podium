/** The fixture pool: tables of borrowed rows. */
export class Pool {
  readonly issues = new Map<string, { id: string; parentId?: string | null }>()
  readonly sessions = new Map<string, { sessionId: string; issueId?: string | null }>()
  readonly worktrees = new Map<string, { path: string }>()
}

export function createPool(): Pool {
  return new Pool()
}
