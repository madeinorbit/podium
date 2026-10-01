/**
 * POD-4953 temporary input, until POD-4949 supplies normalized homes.
 * This is the ONLY join to the old issue record. Durable values come from
 * the projection; the old record supplies readAt, tuckedAt, pinned, gitState,
 * repoPath and commentCount. Internal feed spellings are adapted here too.
 * No view, selector, replica, or mutation owner is created by this adapter.
 */
import type { SliceIssue, SliceDepEdge } from './slice-types'

type Input = Readonly<Record<string, unknown>>
const composed = new WeakMap<object, WeakMap<object, SliceIssue>>()
const NO_TEMPORARY_INPUT: Input = Object.freeze({})

export function temporaryIssueInput(
  projection: Input | undefined,
  temporary: Input | undefined,
  deps?: readonly SliceDepEdge[],
  blocked?: boolean,
  sessionFacts?: SliceIssue['sessionFacts'],
): SliceIssue | undefined {
  // Older fixtures and pending inserts may arrive before their projection.
  // Once the normalized row exists, no durable legacy field wins over it.
  if (projection === undefined) return temporary as unknown as SliceIssue | undefined
  const old = temporary ?? NO_TEMPORARY_INPUT
  let joined = composed.get(projection)
  if (joined === undefined) {
    joined = new WeakMap()
    composed.set(projection, joined)
  }
  const cached = joined.get(old)
  if (cached !== undefined && (deps === undefined || cached.deps === deps) && cached.blocked === blocked && cached.sessionFacts === sessionFacts) return cached
  const asked = projection.asked as { question?: string; options?: string[]; at?: string; by?: string } | null | undefined
  const hasAsked = Object.hasOwn(projection, 'asked')
  const row = {
    ...projection,
    readAt: old.readAt,
    tuckedAt: old.tuckedAt,
    pinned: old.pinned,
    gitState: old.gitState,
    repoPath: old.repoPath ?? '',
    commentCount: old.commentCount,
    draft: projection.isDraftVessel ?? projection.draft ?? old.draft ?? false,
    origin: projection.intentOrigin ?? projection.origin ?? old.origin,
    humanQuestion: hasAsked ? asked?.question : projection.humanQuestion ?? old.humanQuestion,
    humanQuestionOptions: hasAsked ? asked?.options : projection.humanQuestionOptions ?? old.humanQuestionOptions,
    humanQuestionAskedAt: asked?.at,
    humanQuestionAskedBy: asked?.by,
    // Edges are a normalized feed input. Legacy-shaped test projections can
    // spell them inline; the production source supplies the issueDeps lane.
    deps: deps ?? projection.deps ?? [],
    blocked,
    sessionFacts,
  } as unknown as SliceIssue
  joined.set(old, row)
  return row
}
