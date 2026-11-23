import { createSidebarFixture } from './sidebar-fixture'

/** Match the investigated browser's scale without reading an operator's data. */
export function createSidebarFoldFixture() {
  const now = Date.now()
  const fixture = createSidebarFixture(3609, now, true)
  const sizes = [58, 14, ...Array.from({ length: 14 }, (_, i) => (i === 0 ? 26 : 25))]
  const repos = sizes.map((_, i) => ({
    path: `/synthetic/fold-${String(i).padStart(2, '0')}`,
    repoId: `fold-repo-${i}`,
    kind: 'repository',
    branch: 'main',
    worktrees: [],
  }))
  fixture.putMachinesAndRepos({ repos })
  for (const repo of repos)
    fixture.records.set(`repo:${repo.repoId}`, {
      entity: 'repo',
      entityId: repo.repoId,
      value: {
        id: repo.repoId,
        repoPath: repo.path,
        prefix: 'SYN',
        name: repo.path.split('/').at(-1),
      },
      provenance: { seq: 1 },
    })
  const openRows = sizes.reduce((sum, size) => sum + size, 0)
  for (const [key, record] of fixture.records) {
    const row = record.value as Record<string, unknown>
    if (record.entity === 'issueProjection') {
      const i = Number(record.entityId.slice('synthetic-'.length))
      let group = 0
      let end = 58
      while (i < openRows && i >= end) end += sizes[++group] ?? 0
      const repo = repos[group]
      if (!repo) throw new Error(`Missing synthetic project ${group}`)
      fixture.records.set(key, {
        ...record,
        value: {
          ...row,
          repoId: repo.repoId,
          worktreePath: repo.path,
          stage: i < openRows ? 'in_progress' : 'done',
          ...(i >= openRows
            ? {
                closedAt: new Date(now - 3600000).toISOString(),
                closedReason: 'done',
              }
            : {}),
        },
      })
    } else if (record.entity === 'issueUserState') {
      const { entityId } = row
      const i = Number(String(entityId).slice('synthetic-'.length))
      if (i >= openRows)
        fixture.records.set(key, {
          ...record,
          value: { ...row, tuckedAt: new Date(now - 3600000).toISOString() },
        })
    } else if (record.entity === 'session') {
      const i = Number(record.entityId.slice('synthetic-session-'.length))
      if (i >= 1831) fixture.records.delete(key)
      else fixture.records.set(key, { ...record, value: { ...row, cwd: '/synthetic/fold-00' } })
    }
  }
  return fixture
}
