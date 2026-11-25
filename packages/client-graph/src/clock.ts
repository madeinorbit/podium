export { DeadlineClock, deadlineClock, nextUp } from '@podium/mobx-helpers'

/** Every production untracked()/peek call site has a unique untracked-read tag.
 * A peek avoids loading; it still tracks the addressed row/residency when read in a derivation. */
export const UNTRACKED_READS: Readonly<Record<string, string>> = {
  // POD-7454: side state read behind a signal the reader observes (`signalledRead`),
  // or bookkeeping a derivation runs that decides no answer (`sideStateUpkeep`).
  'pool-sources-register': 'Upkeep: registers a source a screen attaches on first read; the published by-entity registry is observable.',
  'reader-register-routes': "Upkeep: files a watched question's routes; decides no answer.",
  'phone-section-member': "Lane membership inside the section's query result, whose subscribe delivers every filing change of its lane.",
  'reader-held-count': "Resident extras are counted behind the count question's watch atom; every extras change reports it.",
  'reader-identity-fork': 'Upkeep: builds the identity fork once per source; maintenance applies each later override to it.',
  'worklist-activate': "Upkeep: starts the candidates' filing reactions when the list is first observed; decides no answer.",
  'reader-unroute-query': "Upkeep: drops a released question's routes; decides no answer.",
  'reader-on-members': 'Upkeep: registers a membership listener; the caller reads the relation tracked.',
  'reader-on-question-members': "Upkeep: registers a question's member listener and routes; decides no answer.",
  'reader-linked-issue': 'Linked-issue answers are kept beside their question atom; publication compares each and reports the atom.',
  'reader-containing-issue': 'Containing-issue answers are kept beside their per-cwd atom; path routing rereads and reports changed ones.',
  'reader-issue-scope': 'Issue scope bits are kept beside the per-issue atom; residency and publication changes compare and report it.',
  'reader-session-reference': 'Session reference answers are kept beside their per-ref atom; token routing rereads and reports changed ones.',
  'notice-read-by-id': "Each notice answer is read after observing its key's watch atom; every membership change wakes that key.",
  'chat-context-read-by-id': 'Chat context rows are read after demand and the observable loaded set; order rows are observable boxes.',
  'settings-follow-list': 'Upkeep: opens a discovery list subscription on first read; decides no answer.',
  'pool-sources-ensure': "Upkeep: registers a lazy source's owner; the published by-entity registry is observable.",
  'sorted-lanes-subscribe': 'Upkeep: registers a lane subscriber; lane readers observe the lane map and atoms.',
  'collections-reload': "Upkeep: queues an unloaded record's disk read; the record arrives through the tracked tables.",
  'collections-retry': "Upkeep: forgets a refusal on a view's retry; the loader's markers notification wakes the readers, which ask again.",
  'row-exit-kind': "A found exit observes its row's exit signal, moved by every publication naming the row; a new exit also deletes the table slot the reader observes.",
  'collections-keyed-read': "Keyed marker/stub reads observe the key's demand atom; loader notifications reread each observed key and report only changed ones.",
  'collections-loader-read': 'PoolCollections TRACKED answers observe the marker, stub, connection or attachment atom they depend on; loader notifications report those atoms.',
  'collections-unloaded': 'Whether a record is on disk only changes with its table slot: an unload deletes the row the reader observes, a load adds it.',
  'collections-keep-record': 'Hold bookkeeping, not an answer: the reader keeps an existing lookup hold; the record itself is read from the tracked tables.',
  'collections-observe-marker': 'Marker bookkeeping before the keyed marker read, whose demand atom the reader observes.',
  'collections-hold-while-read': 'Hold bookkeeping keyed by the read demand atom the reader observes; it answers only whether a view observes that key.',
  'collections-hold-record': 'The hold entry for a key whose read demand atom the reader just observed; bookkeeping, not an answer.',
  'collections-tree-in-flight': "Whether an open view holds an ancestor's tree now; the reader then holds that tree too and observes its marker, which moves when the tree completes.",
  'seat-verdicts-first-read': "The first read builds an issue's entry from tracked rows; its owner and deadline bookkeeping is maintenance, and the entry's observable summary carries every later change.",
  'worktree-path': "The reader observes the path key's demand atom first; maintenance reports it whenever that key's canonical path changes.",
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
  'query-result-seed':
    'Seed demanded rows synchronously; row reactions and membership subscriptions maintain result atoms.',
  'lazy-batch-probe':
    "Ask whether @lazy runs inside a MobX batch; the probe computed must never become a reader's dependency.",
  'spawn-sort-peek':
    'Read addressed placement rows inside the spawn action without requesting cold payloads.',
  'fresh-record-placement':
    "Read held rows once when a create is pressed, to guess a new record's placement; its paint is fixed for the entry's life.",
  'command-target-held':
    'Ask once, when a command is reduced, whether the device holds its target; an absent target paints nothing and its result arrives through the feed.',
  'clock-store-snapshot':
    'Seed a React clock snapshot without subscribing its enclosing observer; the explicit store subscription owns later clock invalidation.',
  'task-cost-project-peek':
    "Read a held issue's repository without loading it; the stub and repository row answer otherwise, and the cost answer re-renders the groups.",
  'pulse-held-usage':
    'Leaving Pulse keeps the last usage reading on screen without holding account.usage; focus resumes the live read.',
  'work-search-child-peek':
    'Work search skips sub-tasks not in memory instead of loading them; the next query re-runs it.',
}
