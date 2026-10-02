/** Normalized replica facts joined at the row-source boundary (ADR 4 D7.3). */
import type { SliceDepEdge, SliceIssue } from './slice-types'

type Input = Readonly<Record<string, unknown>>
const NONE = Object.freeze({})
interface Memo {
  next: WeakMap<object, Memo>
  value?: SliceIssue
}
const composed: Memo = { next: new WeakMap() }

export function issueInput(
  projection: Input | undefined,
  userState: Input | undefined,
  gitState: Input | undefined,
  repo: Input | undefined,
  deps: readonly SliceDepEdge[],
  blocked: boolean,
  sessionFacts: SliceIssue['sessionFacts'],
): SliceIssue | undefined {
  if (!projection) return undefined
  let memo = composed
  for (const key of [
    projection,
    userState ?? NONE,
    gitState ?? NONE,
    repo ?? NONE,
    deps,
    sessionFacts ?? NONE,
  ]) {
    let next = memo.next.get(key)
    if (!next) {
      next = { next: new WeakMap() }
      memo.next.set(key, next)
    }
    memo = next
  }
  if (memo.value && memo.value.blocked === blocked) return memo.value
  // The git kind's identity is an issue id; its updatedAt is a probe timestamp.
  // Neither is the issue's durable identity or activity timestamp.
  const git = gitState && (({ id: _id, ...observation }) => observation)(gitState)
  memo.value = {
    ...projection,
    readAt: userState?.readAt ?? null,
    tuckedAt: userState?.tuckedAt ?? null,
    pinned: userState?.pinned ?? false,
    gitState: git,
    repoPath: repo?.repoPath ?? '',
    deps,
    blocked,
    sessionFacts,
  } as unknown as SliceIssue
  return memo.value
}
