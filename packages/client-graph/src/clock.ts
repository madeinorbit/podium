export { DeadlineClock, deadlineClock, nextUp } from '@podium/mobx-helpers'

/** Every production untracked()/peek call site has a unique untracked-read tag.
 * A peek avoids loading; it still tracks the addressed row/residency when read in a derivation. */
export const UNTRACKED_READS: Readonly<Record<string, string>> = {
  'warmup-list-plan': 'Plan a warm-up list change into slices; only the list is tracked, each slice reaction observes its own rows.',
  'warmup-slice-next': 'Schedule the next warm-up slice from a slice\'s first run; the slice tracks only its rows.',
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
  'pool-seat-seed': 'Seed retained seat identities during residency maintenance; relation publications maintain them.',
  'seat-membership-maintenance': 'Read seat membership during verdict maintenance; publication queues refresh the maintained summary.',
  'seat-session-maintenance': 'Read an addressed session without loading or observing it; publication queues refresh seat verdicts.',
  'seat-issue-maintenance': 'Read an addressed issue without loading or observing it; publication queues refresh seat verdicts.',
  'visibility-issue-peek': 'Read a visibility row without starting a load; the row reader tracks its table slot.',
  'visibility-session-peek': 'Read a visibility session without starting a load; the row reader tracks its table slot.',
  'pool-session-position': 'Read the insertion position from the device index; the demanded position atom owns invalidation.',
  'pool-auxiliary-presence': 'Observe auxiliary row presence only; acquisition returns a stable reader handle, not live row fields.',
  'pool-formal-parent': 'Read the plain parent twin after observing the source table slot.',
  'query-result-seed': 'Seed demanded rows synchronously; row reactions and membership subscriptions maintain result atoms.',
  'lazy-batch-probe': 'Ask whether @lazy runs inside a MobX batch; the probe computed must never become a reader\'s dependency.',
  'spawn-sort-peek': 'Read addressed placement rows inside the spawn action without requesting cold payloads.',
  'fresh-record-placement': 'Read held rows once when a create is pressed, to guess a new record\'s placement; its paint is fixed for the entry\'s life.',
  'command-target-held': 'Ask once, when a command is reduced, whether the device holds its target; an absent target paints nothing and its result arrives through the feed.',
}
