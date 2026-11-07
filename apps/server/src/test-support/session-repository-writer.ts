/**
 * THE WRITER A REPOSITORY UNIT TEST WRITES WITH (POD-6601).
 *
 * `SessionRepository` takes the writer of whoever asked, per call. A unit test
 * that builds one over a fake ledger passes that fake as both of the
 * repository's own writers; this hands it back, so a test's writes go through
 * the same fake (its hooks, its failures) the repository's own writes do.
 */

import type { SessionWriter } from '../modules/sessions/lifecycle'
import type { SessionRepository } from '../modules/sessions/repository'

export function repositoryWriter(repo: SessionRepository): SessionWriter {
  return (repo as unknown as { ports: { writers: { live: SessionWriter } } }).ports.writers.live
}
