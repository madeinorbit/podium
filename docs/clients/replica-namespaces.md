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
inactive and disappear when their old namespace is removed; this is the accepted
beta migration behavior, to revisit before multi-member use.

POD-401 retention is unchanged: sign-out erases only the acting namespace, at most
three namespaces are retained, and inactive namespaces expire after 30 days.
Data is not encrypted at rest. When quota prevents recording the new namespace,
the existing policy evicts inactive namespaces and retries. No eager eviction is
added by the tuple upgrade.

| Acceptance case | What remains |
| --- | --- |
| Web: full localStorage under old namespace | Boot evicts inactive namespaces only as needed for the marker, using existing quota recovery; evicted transactional regions are also erased. |
| Sign-out of successor with room for both namespaces | Successor cache and outbox are erased. Old cache, side data and queued work remain inactive until normal retention removes them. |
| Offline startup after upgrade | Web uses exactly one retained tuple marker; legacy markers cannot supply a missing boundary. Multiple tuples are ambiguous and fail closed. Mobile requires a profile with both server-confirmed fields. |
| Legacy mobile profile removal | Existing cleanup intents still erase their original profile-based namespace. New intents record the server tuple when it is available. |
