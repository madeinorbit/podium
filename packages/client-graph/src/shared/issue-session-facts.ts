import { observable, runInAction } from 'mobx'

/** Raw ownership summaries include archived and headless sessions, independently
 * of residency and resume collapse. Each answer has its own observable key. */
export interface IssueSessionFacts {
  replicaActivityAt?: string
  tipActivityAt?: string
  headlessStaffed: boolean
  headlessOccupied: boolean
}
export type IssueSessionFact = keyof IssueSessionFacts
export type IssueSessionFactReader = <K extends IssueSessionFact>(id: string, field: K) => IssueSessionFacts[K]
type Contribution = IssueSessionFacts & { owner: string }
type Totals = { replicaActivityAt?: string; tipActivityAt?: string; staffed: number; occupied: number }
const EMPTY: IssueSessionFacts = { headlessStaffed: false, headlessOccupied: false }

export class IssueSessionFactsIndex {
  private readonly sessions = new Map<string, Contribution>()
  private readonly owners = new Map<string, Map<string, Contribution>>()
  private readonly totals = new Map<string, Totals>()
  private readonly values = {
    replicaActivityAt: observable.map<string, string | undefined>(undefined, { deep: false }),
    tipActivityAt: observable.map<string, string | undefined>(undefined, { deep: false }),
    headlessStaffed: observable.map<string, boolean>(undefined, { deep: false }),
    headlessOccupied: observable.map<string, boolean>(undefined, { deep: false }),
  }
  readonly stats = { contributions: 0, rescanned: 0, staffingChanges: 0 }

  read: IssueSessionFactReader = (id, field) =>
    (this.values[field].get(id) ?? EMPTY[field]) as IssueSessionFacts[typeof field]

  install(id: string, row: Readonly<Record<string, unknown>> | undefined): void {
    runInAction(() => {
      this.stats.contributions++
      const before = this.sessions.get(id)
      const after: Contribution | undefined = row && typeof row.issueId === 'string' ? {
        owner: row.issueId,
        replicaActivityAt: row.agentKind === 'shell' ? undefined : row.lastActiveAt as string | undefined,
        tipActivityAt: row.archived === true ? undefined : row.lastActiveAt as string | undefined,
        headlessStaffed: row.headless === true && row.archived !== true && row.status !== 'exited',
        headlessOccupied: row.headless === true && row.archived !== true,
      } : undefined
      if (before?.owner === after?.owner && before?.replicaActivityAt === after?.replicaActivityAt &&
          before?.tipActivityAt === after?.tipActivityAt && before?.headlessStaffed === after?.headlessStaffed &&
          before?.headlessOccupied === after?.headlessOccupied) return
      if (before && before.owner !== after?.owner) this.owners.get(before.owner)?.delete(id)
      if (after) {
        this.sessions.set(id, after)
        let members = this.owners.get(after.owner)
        if (!members) this.owners.set(after.owner, members = new Map())
        members.set(id, after)
      } else this.sessions.delete(id)
      if (before && before.owner !== after?.owner) this.update(before.owner, before, undefined)
      if (after) this.update(after.owner, before?.owner === after.owner ? before : undefined, after)
    })
  }

  private update(owner: string, before: Contribution | undefined, after: Contribution | undefined): void {
    let total = this.totals.get(owner)
    if (!total) this.totals.set(owner, total = { staffed: 0, occupied: 0 })
    const replicaReduced = before?.replicaActivityAt !== undefined && before.replicaActivityAt === total.replicaActivityAt &&
      (after?.replicaActivityAt === undefined || after.replicaActivityAt < before.replicaActivityAt)
    const tipReduced = before?.tipActivityAt !== undefined && before.tipActivityAt === total.tipActivityAt &&
      (after?.tipActivityAt === undefined || after.tipActivityAt < before.tipActivityAt)
    if (replicaReduced) total.replicaActivityAt = undefined
    if (tipReduced) total.tipActivityAt = undefined
    if (replicaReduced || tipReduced) {
      for (const member of this.owners.get(owner)?.values() ?? []) {
        this.stats.rescanned++
        if (replicaReduced && member.replicaActivityAt && (!total.replicaActivityAt || member.replicaActivityAt > total.replicaActivityAt))
          total.replicaActivityAt = member.replicaActivityAt
        if (tipReduced && member.tipActivityAt && (!total.tipActivityAt || member.tipActivityAt > total.tipActivityAt))
          total.tipActivityAt = member.tipActivityAt
      }
    }
    if (after?.replicaActivityAt && (!total.replicaActivityAt || after.replicaActivityAt > total.replicaActivityAt))
      total.replicaActivityAt = after.replicaActivityAt
    if (after?.tipActivityAt && (!total.tipActivityAt || after.tipActivityAt > total.tipActivityAt)) total.tipActivityAt = after.tipActivityAt
    if (Boolean(before?.headlessStaffed) !== Boolean(after?.headlessStaffed)) {
      total.staffed += Number(after?.headlessStaffed === true) - Number(before?.headlessStaffed === true)
      this.stats.staffingChanges++
    }
    if (Boolean(before?.headlessOccupied) !== Boolean(after?.headlessOccupied)) {
      total.occupied += Number(after?.headlessOccupied === true) - Number(before?.headlessOccupied === true)
      this.stats.staffingChanges++
    }
    this.values.replicaActivityAt.set(owner, total.replicaActivityAt)
    this.values.tipActivityAt.set(owner, total.tipActivityAt)
    this.values.headlessStaffed.set(owner, total.staffed > 0)
    this.values.headlessOccupied.set(owner, total.occupied > 0)
    if (this.owners.get(owner)?.size === 0) {
      this.owners.delete(owner)
      this.totals.delete(owner)
      for (const values of Object.values(this.values)) values.delete(owner)
    }
  }

  clear(): void {
    runInAction(() => {
      this.sessions.clear()
      this.owners.clear()
      this.totals.clear()
      for (const values of Object.values(this.values)) values.clear()
    })
  }
}
