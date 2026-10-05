import { isFinished } from './predicates'
import { createKeyedAnswer, type KeyedAnswer } from '../query-result'

type Row = Readonly<Record<string, unknown>>
interface Containment { path: string; seq: number; order: number }
export interface IssueQuestionFacts { parentId?: string; done: boolean; containment?: Containment }
export interface IssueChildCounts { readonly childCount: number; readonly childDoneCount: number }
interface ContainingIssue extends Containment { id: string }
interface Root { answer: KeyedAnswer<ContainingIssue> }
interface Seed {
  facts: KeyedAnswer<IssueQuestionFacts>
  children: KeyedAnswer<IssueChildCounts>
  roots: KeyedAnswer<Root>
  sequence: number
}
const NO_CHILDREN: IssueChildCounts = Object.freeze({ childCount: 0, childDoneCount: 0 })
export interface IssueQuestions {
  fork(): IssueQuestions
  set(id: string, row: Row | undefined): void
  setFacts(id: string, next: IssueQuestionFacts | undefined): void
  fact(id: string): IssueQuestionFacts | undefined
  childCounts(id: string): IssueChildCounts
  containingIssueId(cwd: string): string | undefined
  clear(): void
}

/** Raw direct-child counts, including archived and deleted children. Persistent
 * roots let resident changes shadow source contributions without a census. */
export function createIssueQuestions(seed?: Seed): IssueQuestions {
  let facts = seed?.facts.fork() ?? createKeyedAnswer<IssueQuestionFacts>()
  let children = seed?.children.fork() ?? createKeyedAnswer<IssueChildCounts>()
  let roots = seed?.roots.fork() ?? createKeyedAnswer<Root>()
  let sequence = seed?.sequence ?? 0
  const sameContainment = (before?: Containment, after?: Containment) =>
    before === after || (!!before && !!after && before.path === after.path && before.seq === after.seq && before.order === after.order)
  function fileRoot(id: string, value: Containment, present: boolean) {
    const answer = roots.get(value.path)?.answer.fork() ?? createKeyedAnswer<ContainingIssue>(
      (a, b) => a.seq - b.seq || a.order - b.order,
    )
    if (present) answer.set(id, id, { id, ...value })
    else answer.delete(id)
    if (answer.first()) roots.set(value.path, value.path, { answer })
    else roots.delete(value.path)
  }
  function setFacts(id: string, next: IssueQuestionFacts | undefined) {
    const previous = facts.get(id)
    if (previous === next || (previous && next && previous.parentId === next.parentId && previous.done === next.done && sameContainment(previous.containment, next.containment))) return
    const change = (value: IssueQuestionFacts, sign: 1 | -1) => {
      if (!value.parentId) return
      const before = children.get(value.parentId) ?? NO_CHILDREN
      const after = { childCount: before.childCount + sign, childDoneCount: before.childDoneCount + sign * Number(value.done) }
      if (after.childCount) children.set(value.parentId, value.parentId, after)
      else children.delete(value.parentId)
    }
    if (!sameContainment(previous?.containment, next?.containment)) {
      if (previous?.containment) fileRoot(id, previous.containment, false)
      if (next?.containment) fileRoot(id, next.containment, true)
    }
    if (next?.containment) sequence = Math.max(sequence, next.containment.order)
    if (previous) change(previous, -1)
    if (next) { change(next, 1); facts.set(id, id, next) }
    else facts.delete(id)
  }
  return {
    fork: () => createIssueQuestions({ facts, children, roots, sequence }),
    set(id: string, row: Row | undefined) {
      const path = row && !row.archived && !row.deletedAt && typeof row.worktreePath === 'string' && row.worktreePath ? row.worktreePath : undefined
      const previous = facts.get(id)?.containment
      setFacts(id, row ? {
        parentId: typeof row.parentId === 'string' ? row.parentId : undefined,
        done: isFinished(row),
        ...(path ? { containment: { path, seq: Number(row.seq ?? 0), order: previous?.path === path ? previous.order : ++sequence } } : {}),
      } : undefined)
    },
    setFacts,
    fact: (id: string) => facts.get(id),
    childCounts: (id: string): IssueChildCounts => children.get(id) ?? NO_CHILDREN,
    containingIssueId(cwd) {
      let best = roots.get(cwd)?.answer.first()
      const consider = (path: string) => {
        const next = roots.get(path)?.answer.first()
        if (next && (!best || next.path.length > best.path.length)) best = next
      }
      for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) {
        consider(cwd.slice(0, at))
        consider(cwd.slice(0, at + 1))
      }
      return best?.id
    },
    clear() { facts = createKeyedAnswer<IssueQuestionFacts>(); children = createKeyedAnswer<IssueChildCounts>(); roots = createKeyedAnswer<Root>(); sequence = 0 },
  }
}
