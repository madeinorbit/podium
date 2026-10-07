/**
 * Live scalar answers. These uncached getter views let each model @lazy read
 * only its question; the eager part functions remain the rebuild's oracle.
 * A working/count read must not warm every sibling's sidebar and seat cache.
 */
import { issueAbandoned } from '../views'
import { isFinished } from '../shared/predicates'
import {
  formalCycleOf, LOADING, NO_UNIT, NO_UNITS, PENDING_UNIT,
  type Aggregate, type OwnAttention, type PhaseFlags, type RollupInputs,
  type RollupParts, type RollupSelf, type SeatVerdict, type UnitOwn, type Units,
} from './rollup'
import {
  combineSidebarSessionField, NO_SIDEBAR_SESSIONS, sortedSidebarSessions,
  type SidebarSessionFacts,
} from './sidebar-row'

function sidebarFields(read: <K extends keyof SidebarSessionFacts>(key: K) => SidebarSessionFacts[K]): SidebarSessionFacts {
  return {
    get fleet() { return read('fleet') },
    get working() { return read('working') },
    get waitingOpen() { return read('waitingOpen') },
    get waitingFinished() { return read('waitingFinished') },
    get doneSince() { return read('doneSince') },
    get totalMs() { return read('totalMs') },
    get errorClass() { return read('errorClass') },
    get allUnstarted() { return read('allUnstarted') },
  }
}

function sidebarField<K extends keyof SidebarSessionFacts>(
  key: K, parts: Iterable<SidebarSessionFacts>,
): SidebarSessionFacts[K] {
  let value = NO_SIDEBAR_SESSIONS[key], hasValue = false
  for (const facts of parts) {
    if (facts === NO_SIDEBAR_SESSIONS) continue
    value = hasValue ? combineSidebarSessionField(key, value, facts[key]) : facts[key]
    hasValue = true
  }
  return value
}

export function ownAttentionFields(input: RollupInputs, self: RollupSelf): OwnAttention {
  const ready = () => self.present && self.ownFacts.state === 'ready'
  function* seats(): Iterable<SeatVerdict> {
    for (const id of self.rosterIds) {
      const seat = input.seat(id)
      if (seat !== LOADING && seat !== undefined) yield seat
    }
  }
  const flags = (finished: boolean): PhaseFlags => {
    const phase = (seat: SeatVerdict) => finished ? seat.finished : seat.open
    return {
      get waiting() {
        if (ready()) for (const seat of seats()) if (phase(seat) === 'waiting') return true
        return false
      },
      get working() {
        if (ready()) for (const seat of seats()) if (phase(seat) === 'working') return true
        return false
      },
      get allDone() {
        if (ready()) for (const seat of seats()) if (phase(seat) !== 'done') return false
        return true
      },
    }
  }
  const railWaiting = (finished: boolean) => {
    let count = 0
    const deciding = self.ownAttention.deciding
    for (const seat of seats()) {
      if (seat.id === undefined) continue
      if (deciding && seat.sidebarOrder?.offerOnly) continue
      if ((finished ? seat.finished : seat.open) === 'waiting') count++
    }
    return count
  }
  return {
    get cold() { return self.present && self.ownFacts.state === 'cold' },
    get seated() {
      if (ready()) for (const _seat of seats()) return true
      return false
    },
    get working() {
      if (ready()) for (const seat of seats()) if (seat.working) return true
      return false
    },
    get workingSince() {
      let since: number | null = null
      if (ready()) for (const seat of seats()) {
        const at = seat.workingSinceMs
        if (at !== null && (since === null || at < since)) since = at
      }
      return since
    },
    get deciding() {
      if (!ready()) return false
      const facts = self.ownFacts
      if (facts.decision === null || (!facts.finished && self.ownAttention.working)) return false
      return facts.decision !== 'review' ||
        (!facts.continuedByField && (self.openOwn || !self.tip.found))
    },
    get pending() {
      if (!self.present) return 0
      if (self.ownFacts.state === 'cold') return 1
      if (!ready()) return 0
      let pending = 0
      for (const id of self.rosterIds) if (input.seat(id) === LOADING) pending++
      const facts = self.ownFacts
      if (facts.decision === 'review' && (facts.finished || !self.ownAttention.working) &&
        !facts.continuedByField && !self.openOwn) pending += self.tip.pending
      return pending
    },
    get open() { return flags(false) },
    get finished() { return flags(true) },
    get sessionIds() {
      if (!ready()) return undefined
      const ids: string[] = []
      for (const seat of seats()) if (seat.id !== undefined) ids.push(seat.id)
      return sortedSidebarSessions(ids, input.reached ?? (() => false),
        self.ownFacts.coordinatorSessionId, id => {
          const seat = input.seat(id)
          if (seat === undefined || seat === LOADING || seat.sidebarOrder === undefined)
            throw new Error(`Missing roster order: ${id}`)
          return seat.sidebarOrder
        })
    },
    get firstSessionId() { return ready() ? self.ownAttention.sessionIds?.[0] ?? null : undefined },
    get railWaiting() {
      if (!ready()) return undefined
      return {
        get open() { return railWaiting(false) },
        get finished() { return railWaiting(true) },
        get decisions() { return self.ownAttention.deciding ? 1 : 0 },
      }
    },
    get sidebarFacts() {
      if (!ready()) return undefined
      return sidebarFields(<K extends keyof SidebarSessionFacts>(key: K) => {
        // Order matters for fleet glyphs, error choice and tied timer anchors.
        function* facts(): Iterable<SidebarSessionFacts> {
          for (const id of self.ownAttention.sessionIds ?? []) {
            const seat = input.seat(id)
            if (seat !== LOADING && seat !== undefined) yield seat.sidebarFacts ?? NO_SIDEBAR_SESSIONS
          }
        }
        return sidebarField(key, facts())
      })
    },
    get updatedAt() { return ready() ? self.ownFacts.updatedAt : undefined },
    get order() { return ready() ? self.ownFacts.order : undefined },
    get decidingAt() {
      return self.ownAttention.deciding
        ? Date.parse(self.ownFacts.closedAt ?? self.ownFacts.updatedAt ?? '') || undefined
        : undefined
    },
  }
}

export function aggregateFields(input: RollupInputs, id: string, self: RollupSelf): Aggregate {
  function* parts(): Iterable<Aggregate> {
    yield self.ownAttention
    if (self.ownAttention.cold) return
    for (const childId of input.nested(id)) {
      const child = input.rollupNode(childId)
      if (child !== undefined) yield child.aggregate
    }
  }
  const any = (key: 'working' | 'deciding' | 'seated') => {
    for (const part of parts()) if (part[key]) return true
    return false
  }
  const flags = (key: 'open' | 'finished'): PhaseFlags => ({
    get waiting() { for (const part of parts()) if (part[key].waiting) return true; return false },
    get working() { for (const part of parts()) if (part[key].working) return true; return false },
    get allDone() { for (const part of parts()) if (!part[key].allDone) return false; return true },
  })
  const rail = (key: 'open' | 'finished' | 'decisions') => {
    let total = 0
    for (const part of parts()) total += part.railWaiting?.[key] ?? 0
    return total
  }
  const orderedParts = (): Aggregate[] => {
    const [own, ...children] = parts()
    children.sort((a, b) => {
      const x = a.order, y = b.order
      if (x === undefined || y === undefined) return 0
      const keyed = Number(!x.sortKey) - Number(!y.sortKey)
      if (keyed) return keyed
      if (x.sortKey && y.sortKey && x.sortKey !== y.sortKey) return x.sortKey < y.sortKey ? -1 : 1
      return (Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0) ||
        y.seq - x.seq || x.id.localeCompare(y.id)
    })
    return [own!, ...children]
  }
  return {
    get working() { return any('working') },
    get deciding() { return any('deciding') },
    get seated() { return any('seated') },
    get open() { return flags('open') },
    get finished() { return flags('finished') },
    get pending() { let total = 0; for (const part of parts()) total += part.pending; return total },
    get railWaiting() {
      return {
        get open() { return rail('open') },
        get finished() { return rail('finished') },
        get decisions() { return rail('decisions') },
      }
    },
    get sessionIds() {
      const ids: string[] = []
      for (const part of orderedParts()) ids.push(...(part.sessionIds ?? []))
      return ids
    },
    get sidebarFacts() {
      return sidebarFields(<K extends keyof SidebarSessionFacts>(key: K) => {
        function* facts(): Iterable<SidebarSessionFacts> {
          for (const part of orderedParts()) yield part.sidebarFacts ?? NO_SIDEBAR_SESSIONS
        }
        return sidebarField(key, facts())
      })
    },
    get updatedAt() {
      let latest = ''
      for (const part of parts()) if ((part.updatedAt ?? '') > latest) latest = part.updatedAt ?? ''
      return latest
    },
    get order() { return self.ownAttention.order },
    get decidingAt() {
      let earliest: number | undefined
      for (const part of parts()) {
        const at = part.decidingAt
        if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at
      }
      return earliest
    },
  }
}

export function unitOwnFields(
  input: RollupInputs, id: string, self: Pick<RollupSelf, 'openOwn' | 'unitsBelow'>,
): UnitOwn {
  const issue = input.loadedIssue(id)
  if (issue === LOADING) return PENDING_UNIT
  if (issue === undefined) return NO_UNIT
  const vacated = () => input.spinOffCount(id) > 0 && !self.openOwn
  const member = () => issue.stage !== 'proposed' && !issueAbandoned(issue)
  const unit = () => member() && !vacated()
  const staffed = () => self.openOwn || self.unitsBelow.staffed === true
  return {
    cold: false,
    get member() { return member() },
    get unit() { return unit() },
    get done() { return unit() && isFinished(issue) },
    get solo() { return !issueAbandoned(issue) && !vacated() },
    get staffed() { return staffed() },
    get state() {
      return unit() && isFinished(issue) ? 'done' : issue.blocked ? 'block' :
        issue.stage === 'review' ? 'review' :
          ['planning', 'in_progress', 'shipping'].includes(issue.stage)
            ? issue.stage === 'shipping' || staffed() ? 'run' : 'stall' : 'wait'
    },
  }
}

type UnitChild = { readonly own: UnitOwn; readonly below: Units }

function unitsFields(children: () => Iterable<UnitChild>): Units {
  const count = (key: 'members' | 'units' | 'done') => {
    const ownKey = key === 'members' ? 'member' : key === 'units' ? 'unit' : 'done'
    let total = 0
    for (const { own, below } of children())
      if (!own.cold) total += (own[ownKey] ? 1 : 0) + below[key]
    return total
  }
  return {
    get members() { return count('members') },
    get units() { return count('units') },
    get done() { return count('done') },
    get pending() {
      let total = 0
      for (const { own, below } of children()) total += own.cold ? 1 : below.pending
      return total
    },
    get staffed() {
      for (const { own, below } of children())
        if (!own.cold && (own.staffed === true || below.staffed === true)) return true
      return false
    },
    get progress() {
      const progress = { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
      for (const { own, below } of children()) {
        if (own.cold) continue
        if (own.unit) progress[own.state ?? (own.done ? 'done' : 'wait')]++
        const nested = below.progress
        for (const state of Object.keys(progress) as (keyof typeof progress)[])
          progress[state] += nested?.[state] ?? 0
      }
      return progress
    },
  }
}

export function unitsBelowFields(input: RollupInputs, id: string): Units {
  function* children(): Iterable<UnitChild> {
    const ids = [...input.formalChildren(id)]
    const cycle = ids.length > 0 ? formalCycleOf(input, id) : undefined
    if (cycle !== undefined) {
      // The same once-per-member closure as the eager oracle. Only staffing
      // asks for cycle-wide staffing; plain counts never acquire those seats.
      const members: { id: string; node: RollupParts }[] = []
      const branches: UnitChild[] = []
      const seen = new Set<string>([id]), pending = [...ids]
      while (pending.length > 0) {
        const childId = pending.pop()!
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = input.rollupNode(childId)
        if (child === undefined) continue
        if (!cycle.has(childId)) {
          branches.push({ own: child.unitOwn, get below() { return child.unitOwn.cold ? NO_UNITS : child.unitsBelow } })
          continue
        }
        const issue = input.loadedIssue(childId)
        if (issue === LOADING) { branches.push({ own: PENDING_UNIT, below: NO_UNITS }); continue }
        if (issue === undefined) continue
        members.push({ id: childId, node: child })
        pending.push(...input.formalChildren(childId))
      }
      const staffing: Units = {
        ...NO_UNITS,
        get staffed() {
          if (input.rollupNode(id)?.openOwn) return true
          for (const member of members) if (member.node.openOwn) return true
          for (const { own, below } of branches)
            if (!own.cold && (own.staffed === true || below.staffed === true)) return true
          return false
        },
      }
      yield* branches
      for (const member of members) yield {
        own: unitOwnFields(input, member.id, {
          get openOwn() { return member.node.openOwn }, unitsBelow: staffing,
        }), below: NO_UNITS,
      }
      return
    }
    for (const childId of ids) {
      const child = input.rollupNode(childId)
      if (child !== undefined) yield {
        own: child.unitOwn,
        get below() { return child.unitOwn.cold ? NO_UNITS : child.unitsBelow },
      }
    }
  }
  return unitsFields(children)
}
