/** The pool and client-core share the model's scalar lifecycle rules. */
export { isFinished, isClosed, isExcluded } from '@podium/model/browser'

/** Cancelled, duplicate and superseded work contributes no remaining progress (the active-work rule's, POD-5593). */
export { issueAbandoned } from '@podium/model/browser'
