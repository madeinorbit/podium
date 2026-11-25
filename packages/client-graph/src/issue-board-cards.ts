import { here, omitGone } from './lookup'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { operationalState } from '@podium/client-core/values'
import { companion, clearCompanions, lazy } from '@podium/mobx-helpers'
import { ISSUE_STAGES } from '@podium/model/browser'
import { compareShallow, compareStructural } from 'mobx'
import type { ModelOf, SessionModel } from './models'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** The pooled issue object at the board's stored-field types. A card reads
 * its facts here; no overlay or copied card value is built. */
export type BoardIssue = ModelOf['issue'] & IssueViewModel
type ScopeRow = Pick<IssueViewModel, 'isDraftVessel' | 'deletedAt' | 'audience'>

/** The board's audience rule: drafts never show, and an agent-audience task
 * shows only with agent tasks or under a human ancestor. */
export function inBoardScope(
  pool: MobxPool,
  row: ScopeRow,
  id: string,
  agents: boolean,
  liveParents = false,
  parentOf: (id: string) => string | null | undefined = (at) => pool.graph.one('issue', at, 'treeParent'),
): boolean {
  if (row.isDraftVessel && !row.deletedAt) return false
  if (agents || row.deletedAt || row.audience !== 'agent') return true
  const seen = new Set([id])
  let parent = parentOf(id)
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const value = pool.queries.issueScope(parent)
    if (!value || (value.draft && !value.deleted) || (liveParents && (value.archived || value.deleted)))
      return false
    if (value.deleted || !value.agent) return true
    parent = parentOf(parent)
  }
  return false
}

export type StageCount = { stage: IssueViewModel['stage']; count: number }
/** What a stage count reads of a child: stub fields only. */
type StageChild = ScopeRow & Pick<IssueViewModel, 'stage' | 'archived'>
const NO_STAGES: readonly StageCount[] = Object.freeze([])

/** A board card's own rule: where the children in the board's audience are. */
export class BoardCard {
  constructor(
    readonly issue: BoardIssue,
    private readonly pool: MobxPool,
    private readonly agents: boolean,
  ) {}

  /** The record this card draws (names its derivations per record). */
  get id(): string { return this.issue.id }

  /** Live in-scope children per stage, in stage order; only stages with any. */
  @lazy({ equals: compareStructural })
  get stageCounts(): readonly StageCount[] {
    const { issue } = this, pool = this.pool, agents = this.agents
    if (!issue.childCount) return NO_STAGES
    const own = omitGone(pool.row('issue', issue.id)) as Loaded<IssueViewModel>
    if (own === LOADING) throw LOADING
    if (!own || own.archived || own.deletedAt || !inBoardScope(pool, own, issue.id, agents, true))
      return NO_STAGES
    const counts = new Map<IssueViewModel['stage'], number>()
    const count = (id: string, child: StageChild | undefined, parentOf?: (id: string) => string | null | undefined) => {
      if (child && id !== issue.id && !child.archived && !child.deletedAt &&
        inBoardScope(pool, child, id, agents, true, parentOf))
        counts.set(child.stage, (counts.get(child.stage) ?? 0) + 1)
    }
    if (pool.collections.available) {
      // Every child over all history, by its stub (POD-7581): a card holds no
      // child row and loads none, and a child closed long ago still counts.
      // Stubs prefer the resident row (local edits); the audience walk goes
      // up stub parents, so a child held only as a stub finds its human ancestor.
      const ids = pool.collections.childIds(issue.id)
      if (ids === LOADING) throw LOADING
      const stubOf = (at: string) => here(pool.stub(at))
      for (const id of ids) count(id, stubOf(id) as StageChild | undefined, (at) => stubOf(at)?.parentId)
    } else
      for (const id of pool.graph.many('issue', issue.id, 'treeChildren')) {
        const child = omitGone(pool.row('issue', id)) as Loaded<IssueViewModel>
        if (child === LOADING) throw LOADING
        count(id, child)
      }
    return counts.size
      ? ISSUE_STAGES.flatMap(stage => counts.has(stage) ? [{ stage, count: counts.get(stage)! }] : [])
      : NO_STAGES
  }
}

/** The always-on board's per-record companions, one per pool. */
export class BoardCards {
  private readonly cards = [false, true].map(agents =>
    companion((issue: BoardIssue) => new BoardCard(issue, this.pool, agents)))
  constructor(private readonly pool: MobxPool) {}

  issue(id: string): BoardIssue {
    return this.pool.issueObject(id) as BoardIssue
  }

  card(issue: BoardIssue, agents: boolean): BoardCard {
    return this.cards[agents ? 1 : 0]!(issue)
  }
}

export function boardCards(pool: MobxPool): BoardCards {
  return pool.sources.view('issueBoardCards', () => new BoardCards(pool))
}
