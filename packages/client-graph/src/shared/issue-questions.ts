import { isFinished } from './predicates'
import { createKeyedAnswer, type KeyedAnswer } from '../query-result'

type Row = Readonly<Record<string, unknown>>
export interface IssueQuestionFacts { parentId?: string; done: boolean }
export interface IssueChildCounts { readonly childCount: number; readonly childDoneCount: number }
interface Seed {
  facts: KeyedAnswer<IssueQuestionFacts>
  children: KeyedAnswer<IssueChildCounts>
}
const NO_CHILDREN: IssueChildCounts = Object.freeze({ childCount: 0, childDoneCount: 0 })
export interface IssueQuestions {
  fork(): IssueQuestions
  set(id: string, row: Row | undefined): void
  setFacts(id: string, next: IssueQuestionFacts | undefined): void
  fact(id: string): IssueQuestionFacts | undefined
  childCounts(id: string): IssueChildCounts
  clear(): void
}

/** Raw direct-child counts, including archived and deleted children. Persistent
 * roots let resident changes shadow source contributions without a census. */
export function createIssueQuestions(seed?: Seed): IssueQuestions {
  let facts = seed?.facts.fork() ?? createKeyedAnswer<IssueQuestionFacts>()
  let children = seed?.children.fork() ?? createKeyedAnswer<IssueChildCounts>()
  function setFacts(id: string, next: IssueQuestionFacts | undefined) {
    const previous = facts.get(id)
    if (previous === next || (previous && next && previous.parentId === next.parentId && previous.done === next.done)) return
    const change = (value: IssueQuestionFacts, sign: 1 | -1) => {
      if (!value.parentId) return
      const before = children.get(value.parentId) ?? NO_CHILDREN
      const after = { childCount: before.childCount + sign, childDoneCount: before.childDoneCount + sign * Number(value.done) }
      if (after.childCount) children.set(value.parentId, value.parentId, after)
      else children.delete(value.parentId)
    }
    if (previous) change(previous, -1)
    if (next) { change(next, 1); facts.set(id, id, next) }
    else facts.delete(id)
  }
  return {
    fork: () => createIssueQuestions({ facts, children }),
    set(id: string, row: Row | undefined) {
      setFacts(id, row ? { parentId: typeof row.parentId === 'string' ? row.parentId : undefined, done: isFinished(row) } : undefined)
    },
    setFacts,
    fact: (id: string) => facts.get(id),
    childCounts: (id: string): IssueChildCounts => children.get(id) ?? NO_CHILDREN,
    clear() { facts = createKeyedAnswer<IssueQuestionFacts>(); children = createKeyedAnswer<IssueChildCounts>() },
  }
}
