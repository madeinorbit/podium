export { DeadlineClock, nextUp } from '@podium/mobx-helpers'

/** Every production untracked()/peek call site has a unique untracked-read tag.
 * A peek avoids loading; it still tracks the addressed row/residency when read in a derivation. */
export const UNTRACKED_READS: Readonly<Record<string, string>> = {
  'header-attachment': 'The attachment census seeds contributions once; row and cold-change subscriptions maintain them.',
  'header-cold-seed': 'Seed the cold contribution from its declared summary; cold-change notifications refresh it.',
  'reader-identity-seed': 'Seed identity membership after watch registers invalidation; avoid tracking every history table entry.',
  'reader-resident-maintenance': 'Copy addressed resident facts during publication; maintained question atoms report changes.',
  'reader-repo-identity': 'Refresh a changed repository identity during publication; identity question atoms notify readers.',
  'query-membership-seed': 'Seed declared query membership; table and feed subscriptions maintain the result atom.',
  'query-membership-probe': 'Check addressed query membership during maintenance; the query subscription reports membership changes.',
  'board-column-seed': 'Seed a board column from its declared stage questions; table and feed subscriptions maintain the column result.',
  'board-column-probe': 'Check one issue against a column\'s stage questions during maintenance; the column subscription reports membership changes.',
  'transcript-order-snapshot': 'Take the phone transcript items once per order change; the list keys on ids and each row observes its own message.',
  'launch-session-seed': 'Probe session residency without borrowing dependencies; addressed rows and catalog membership track changes.',
  'launch-session-presence': 'Choose resident session detail without a table dependency; catalog membership and row summaries track changes.',
  'issue-hidden-presence': 'Probe residency without a duplicate dependency; resident facts or the cold summary track changes.',
  'pool-seat-seed': 'Seed retained seat identities during residency maintenance; relation publications maintain them.',
  'seat-membership-maintenance': 'Read seat membership during verdict maintenance; publication queues refresh the maintained summary.',
  'seat-session-maintenance': 'Read an addressed session without loading or observing it; publication queues refresh seat verdicts.',
  'seat-issue-maintenance': 'Read an addressed issue without loading or observing it; publication queues refresh seat verdicts.',
  'visibility-issue-peek': 'Read a cold visibility row without requesting payload; the row reader tracks its residency atom.',
  'visibility-session-peek': 'Read a cold visibility session without requesting payload; the row reader tracks its residency atom.',
  'pool-session-position': 'Read the cold insertion position while loading a session; the addressed session residency owns invalidation.',
  'pool-auxiliary-presence': 'Observe auxiliary row presence only; acquisition returns a stable reader handle, not live row fields.',
  'pool-cold-presence': 'Avoid observing an absent table slot; the cold residency atom already reports summary and promotion changes.',
  'pool-formal-parent': 'Read the plain parent twin after observing the source table slot or cold residency address.',
  'pool-hidden-presence': 'Avoid allocating residency atoms for resident rows; their tracked table slot reports replacement.',
  'query-result-seed': 'Seed demanded rows synchronously; row reactions and membership subscriptions maintain result atoms.',
  'lazy-batch-probe': 'Ask whether @lazy runs inside a MobX batch; the probe computed must never become a reader\'s dependency.',
  'spawn-sort-peek': 'Read addressed placement rows inside the spawn action without requesting cold payloads.',
}
