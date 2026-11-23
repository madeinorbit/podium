import type { IssueCommandDeps } from '../modules/issues/command-ctx'
import { readIssues } from '../modules/issues/issue-reader'
import type { SessionStore } from '../store'

/** The execution-private field reads (POD-6288) over a test's own store, as
 *  `relay.ts` wires them over the server's. */
export function executionFactsOf(store: SessionStore): IssueCommandDeps['executionFacts'] {
  return {
    rows: async (ids) => await readIssues(store.issues, ids),
    store: { grants: store.grants, sessions: store.sessions },
  }
}
