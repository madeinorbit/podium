# Client replica namespaces

The authenticated server supplies `syncBoundaryId` and `memberId` separately.
Self-hosted boundaries use the installation identity; hosted boundaries use the
workspace ID. Clients encode the pair as a JSON tuple for IndexedDB/SQLite,
localStorage/AsyncStorage, cross-tab routing, and profile cleanup. Commands still
attribute work to the member ID alone. Local profile IDs identify credentials and
endpoints, not replica data.

Re-pairing a phone to the same installation and member reopens the same namespace,
even with a new local profile ID. A member-ID rename opens a different namespace
within the same boundary. A browser domain change cold-starts storage because
origins remain physically isolated: this is logical identity, not storage continuity.

The namespace-format upgrade cold-starts the tuple once. It does not copy the
old member-only web namespace or profile-based mobile namespace, including queued
commands. Subsequent starts reuse the tuple's data. Old queued commands remain
inactive; retention preserves their namespaces while work is pending. Revisit
the migration before multi-member use.

Sign-out explicitly erases only the acting namespace. Automatic retention targets
three namespaces and expires inactive namespaces after 30 days, but both rules
apply only when the durable outbox is empty and there are no unsent drafts.
Pending work can keep any number of namespaces, on web and phone. Unreadable
authored storage is retained too. Confirmed composer drafts are reloadable;
dirty drafts, including empty clears and older drafts without a dirty flag, are not.

Data is not encrypted at rest. When quota prevents recording the new namespace,
retention reclaims only clean inactive caches and retries. Automatic cleanup never
deletes transactional outbox rows or the settings homes containing drafts and
legacy outboxes: another writer can add work after the clean check. Explicit
sign-out and profile removal still erase those homes.

| Acceptance case | What remains |
| --- | --- |
| Web: full localStorage under old namespace | Boot reclaims clean inactive caches as needed for the marker. Unsent work never gives way for quota. |
| Sign-out of successor with room for both namespaces | Successor cache and outbox are erased. Old cache, side data and queued work remain; automatic retention cannot remove pending work. |
| Five workspaces with pending writes or drafts | All five retain their data and replay their own work on return. Phone tests rehydrate the AsyncStorage bridge between workspace switches. |
| Offline startup after upgrade | Web uses exactly one retained tuple marker; legacy markers cannot supply a missing boundary. Multiple tuples are ambiguous and fail closed. Mobile requires a profile with both server-confirmed fields. |
| Legacy mobile profile removal | Existing cleanup intents still erase their original profile-based namespace. New intents record the server tuple when it is available. |
