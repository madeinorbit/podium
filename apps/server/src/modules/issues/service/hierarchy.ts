import type { IssueId, IssueWire } from '@podium/model'
import type { IssueRow } from '../../../store'
import type { IssueStore } from './core'
import type { IssueCrudMethods } from './crud'
import type { IssueReportsMethods } from './reads'

/** Hierarchy and dependency capability over the shared issue store. */
export interface IssueHierarchyMethods extends IssueStore, IssueReportsMethods, IssueCrudMethods {}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the composition root installs this stateless method bundle onto IssueStore.
export class IssueHierarchyMethods {
  /** Dependency-only path; parent containment never participates. */
  private dependencyPath(startId: string, targetId: string): string[] | null {
    const seen = new Set<string>()
    const pending: Array<{ id: string; path: string[] }> = [{ id: startId, path: [startId] }]
    while (pending.length) {
      const current = pending.shift() as { id: IssueId; path: IssueId[] }
      if (current.id === targetId) return current.path
      if (seen.has(current.id)) continue
      seen.add(current.id)
      for (const dep of this.deps.store.issues.listIssueDeps(current.id)) {
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
      current = this.rows.get(current)?.parentId
      if (current) path.push(current)
    }
    return null
  }

  addDep(fromRef: string, toRef: string, type = 'blocks'): IssueWire {
    if (type === 'parent-child') throw new Error('parent-child is managed by reparent, not addDep')
    const fromId = this.resolveRef(fromRef)
    const toId = this.resolveRef(toRef)
    const row = this.rowOrThrow(fromId)
    this.rowOrThrow(toId)
    if (fromId === toId) throw new Error('an issue cannot depend on itself (self-dep)')
    if (type === 'blocks') {
      const returnPath = this.dependencyPath(toId, fromId)
      if (returnPath) {
        throw new Error(
          `dependency ${fromId} -> ${toId} would create a dependency cycle: ${[fromId, ...returnPath].join(' -> ')}`,
        )
      }
    }
    const wire = this.persistWith(
      row,
      () => this.deps.store.issues.addIssueDep(fromId, toId, type),
      { extraChanges: this.depChanges([{ fromId, toId, type }], 'upsert') },
    )
    this.broadcastListForDerivedRipple()
    return wire
  }

  removeDep(fromRef: string, toRef: string, type?: string): IssueWire {
    if (type === 'parent-child')
      throw new Error('parent-child is managed by reparent, not removeDep')
    const fromId = this.resolveRef(fromRef)
    const toId = this.resolveRef(toRef)
    const row = this.rowOrThrow(fromId)
    const removed = this.deps.store.issues
      .listIssueDeps(fromId)
      .filter((d) => d.toId === toId && (type === undefined || d.type === type))
      .map((d) => ({ fromId, toId, type: d.type }))
    const wire = this.persistWith(
      row,
      () => this.deps.store.issues.removeIssueDep(fromId, toId, type),
      { extraChanges: this.depChanges(removed, 'remove') },
    )
    this.broadcastListForDerivedRipple()
    return wire
  }

  setParentForUpdate(row: IssueRow, newParentId: IssueId | null): void {
    if (newParentId === row.parentId) return
    if (newParentId) {
      this.rowOrThrow(newParentId)
      const returnPath = this.containmentPath(newParentId, row.id)
      if (returnPath) {
        throw new Error(
          `reparent ${row.id} -> ${newParentId} would create a containment cycle: ${[row.id, ...returnPath].join(' -> ')}`,
        )
      }
    }
    row.parentId = newParentId
  }

  /**
   * Reparent changes the moving subtree permission set. Cross-owner confirmation
   * policy remains open in POD-1070; the registry continues to surface the
   * existing outside-scope confirmation instead of treating this as a silent
   * structural-only edit.
   */
  reparent(id: string, parentId: string | null): IssueWire {
    const row = this.rowOrThrow(id)
    this.setParentForUpdate(row, parentId == null ? null : this.resolveRef(parentId))
    const wire = this.persist(row)
    this.broadcastList()
    return wire
  }

  ancestorIds(id: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    let cur = this.rows.get(this.resolveRef(id))?.parentId ?? null
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = this.rows.get(cur)?.parentId ?? null
    }
    return out
  }

  inProposedSubtree(id: string): boolean {
    let row: IssueRow | undefined
    try {
      row = this.rows.get(this.resolveRef(id))
    } catch {
      row = undefined
    }
    if (!row) return true
    if (row.stage === 'proposed') return true
    return this.ancestorIds(row.id).some(
      (ancestor) => this.rows.get(ancestor)?.stage === 'proposed',
    )
  }

  supersede(oldRef: string, newRef: string): IssueWire {
    const oldId = this.resolveRef(oldRef)
    const newId = this.resolveRef(newRef)
    this.rowOrThrow(newId)
    this.addDep(oldId, newId, 'supersedes')
    return this.update(oldId, { stage: 'done', closedReason: 'superseded', supersededBy: newId })
  }

  duplicate(ref: string, canonicalRef: string): IssueWire {
    const id = this.resolveRef(ref)
    const canonicalId = this.resolveRef(canonicalRef)
    this.rowOrThrow(canonicalId)
    this.addDep(id, canonicalId, 'related')
    return this.update(id, { stage: 'done', closedReason: 'duplicate', duplicateOf: canonicalId })
  }
}
