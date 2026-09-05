import type { IssueId, IssueWire } from '@podium/model'
import type { IssueRow } from '../../../store'
import type { IssueStore } from './core'
import type { IssueCrudModule } from './crud'

/** Hierarchy and dependency capability over the shared issue store. */
export class IssueHierarchyModule {
  constructor(
    readonly store: IssueStore,
    private readonly crud: () => Pick<IssueCrudModule, 'update'>,
  ) {}
  /** Dependency-only path; parent containment never participates. */
  private async dependencyPath(startId: string, targetId: string): Promise<string[] | null> {
    const seen = new Set<string>()
    const pending: Array<{ id: string; path: string[] }> = [{ id: startId, path: [startId] }]
    while (pending.length) {
      const current = pending.shift() as { id: IssueId; path: IssueId[] }
      if (current.id === targetId) return current.path
      if (seen.has(current.id)) continue
      seen.add(current.id)
      for (const dep of await this.store.deps.store.issues.listIssueDeps(current.id)) {
        if (dep.type === 'blocks') {
          pending.push({ id: dep.toId, path: [...current.path, dep.toId] })
        }
      }
    }
    return null
  }

  /** Containment-only parent path. */
  private containmentPath(startId: string, targetId: string): string[] | null {
    const path = [startId]
    const seen = new Set<string>()
    let current: string | null | undefined = startId
    while (current && !seen.has(current)) {
      if (current === targetId) return path
      seen.add(current)
      current = this.store.rows.get(current)?.parentId
      if (current) path.push(current)
    }
    return null
  }

  async addDep(fromRef: string, toRef: string, type = 'blocks'): Promise<IssueWire> {
    if (type === 'parent-child') throw new Error('parent-child is managed by reparent, not addDep')
    const fromId = await this.store.resolveRef(fromRef)
    const toId = await this.store.resolveRef(toRef)
    const row = await this.store.draftOrThrow(fromId)
    await this.store.rowOrThrow(toId)
    if (fromId === toId) throw new Error('an issue cannot depend on itself (self-dep)')
    if (type === 'blocks') {
      const returnPath = await this.dependencyPath(toId, fromId)
      if (returnPath) {
        throw new Error(
          `dependency ${fromId} -> ${toId} would create a dependency cycle: ${[fromId, ...returnPath].join(' -> ')}`,
        )
      }
    }
    const wire = this.store.persistWith(
      row,
      () => this.store.deps.store.issues.addIssueDep(fromId, toId, type),
      { extraChanges: this.store.depChanges([{ fromId, toId, type }], 'upsert') },
    )
    await this.store.broadcastListForDerivedRipple()
    return wire
  }

  async removeDep(fromRef: string, toRef: string, type?: string): Promise<IssueWire> {
    if (type === 'parent-child')
      throw new Error('parent-child is managed by reparent, not removeDep')
    const fromId = await this.store.resolveRef(fromRef)
    const toId = await this.store.resolveRef(toRef)
    const row = await this.store.draftOrThrow(fromId)
    const removed = (await this.store.deps.store.issues
      .listIssueDeps(fromId))
      .filter((d) => d.toId === toId && (type === undefined || d.type === type))
      .map((d) => ({ fromId, toId, type: d.type }))
    const wire = this.store.persistWith(
      row,
      () => this.store.deps.store.issues.removeIssueDep(fromId, toId, type),
      { extraChanges: this.store.depChanges(removed, 'remove') },
    )
    await this.store.broadcastListForDerivedRipple()
    return wire
  }

  async setParentForUpdate(row: IssueRow, newParentId: IssueId | null): Promise<void> {
    if (newParentId === row.parentId) return
    if (newParentId) {
      await this.store.rowOrThrow(newParentId)
      const returnPath = this.containmentPath(newParentId, row.id)
      if (returnPath) {
        throw new Error(
          `reparent ${row.id} -> ${newParentId} would create a containment cycle: ${[row.id, ...returnPath].join(' -> ')}`,
        )
      }
      // COLOUR IS A TOP-LEVEL PROPERTY [spec:SP-b4d1]. It names a mission in the
      // sidebar and flows down the mission's own surfaces (flight deck, terminal
      // tint) by inheritance, so a sub-issue never carries one of its own — it
      // would only compete with the parent's. Gaining a parent therefore drops
      // the issue's own slot; the flow it now runs under is the parent's.
      row.color = null
    }
    row.parentId = newParentId
  }

  /**
   * Reparent changes the moving subtree permission set. Cross-owner confirmation
   * policy remains open in POD-1070; the registry continues to surface the
   * existing outside-scope confirmation instead of treating this as a silent
   * structural-only edit.
   */
  async reparent(id: string, parentId: string | null): Promise<IssueWire> {
    const row = await this.store.draftOrThrow(id)
    await this.setParentForUpdate(row, parentId == null ? null : await this.store.resolveRef(parentId))
    const wire = this.store.persist(row)
    await this.store.broadcastList()
    return wire
  }

  async ancestorIds(id: string): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    let cur = this.store.rows.get(await this.store.resolveRef(id))?.parentId ?? null
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = this.store.rows.get(cur)?.parentId ?? null
    }
    return out
  }

  async inProposedSubtree(id: string): Promise<boolean> {
    let row: IssueRow | undefined
    try {
      row = this.store.rows.get(await this.store.resolveRef(id))
    } catch {
      row = undefined
    }
    if (!row) return true
    if (row.stage === 'proposed') return true
    return (await this.ancestorIds(row.id)).some(
      (ancestor) => this.store.rows.get(ancestor)?.stage === 'proposed',
    )
  }

  async supersede(oldRef: string, newRef: string): Promise<IssueWire> {
    const oldId = await this.store.resolveRef(oldRef)
    const newId = await this.store.resolveRef(newRef)
    await this.store.rowOrThrow(newId)
    await this.addDep(oldId, newId, 'supersedes')
    return await this.crud().update(oldId, {
      stage: 'done',
      closedReason: 'superseded',
      supersededBy: newId,
    })
  }

  async duplicate(ref: string, canonicalRef: string): Promise<IssueWire> {
    const id = await this.store.resolveRef(ref)
    const canonicalId = await this.store.resolveRef(canonicalRef)
    await this.store.rowOrThrow(canonicalId)
    await this.addDep(id, canonicalId, 'related')
    return await this.crud().update(id, {
      stage: 'done',
      closedReason: 'duplicate',
      duplicateOf: canonicalId,
    })
  }
}
