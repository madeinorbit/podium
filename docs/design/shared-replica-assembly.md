# Shared replica boot lifecycle

Web and mobile will open private data through `@podium/client-core/replica-assembly`.
It owns namespace retention and erasure, cache adoption, legacy queued-write
migration, the durable outbox, HTTP bootstrap and healing, feed delivery, transfer
progress, and disposal. Apps supply the transactional store, hydrated small-settings
storage with enumeration and flush, and the streaming download fetch. Database
names and storage prefixes stay unchanged so existing installations reopen their data.
Web keeps its cross-tab relay around the shared feed; native lifecycle and rendering
remain in the apps.

Both apps refuse startup when the store is unavailable or already in memory, or
when the principal marker cannot be persisted. This changes mobile's old memory
fallback: silently retiring a durable legacy queue into memory can lose unsent
work on restart. The failure is classified as blocked storage and offers retry.
Adapter degradation after a successful open retains its existing visible notice.
The AsyncStorage bridge must flush its namespace before migration or mounting.

The assembly runs both raw and principal-prefixed legacy queue migrations before
opening the outbox, using one clock and the authenticated member for attribution.
One migration summary reports adopted, parked, and rejected work on both apps;
unattributed cache refresh has a lower-priority notice. Sign-out stops the feed,
erases both storage regions, and flushes the settings bridge. Failed and abandoned
opens dispose their resources.

One progress store separates received rows and bytes from durable installation
and committed healing frames. Cold launches block until installation; warm data
stays usable during reconnects. App projections preserve their presentation.
Network failures use the kernel's bounded retry ladder. Authentication expiry
and malformed downloads stop the walk, preserve their cause, and require an
explicit recovery; expiry also notifies the app's credential owner.

Shared boot supervision reports a stall after 15 seconds without cancelling a
healthy slow open; cold downloads get 30 seconds. Failure takes precedence over
a stall, and late completion clears it. Shared server-call recovery probes
readiness and replays a query once; mutations are never replayed because their
response may have been lost after commit. Platform fetch adapters retain cookies,
bearers, workspace selection, and Expo's streaming guard.

Validation will run the normal lean gate and one focused file selection covering
both app wrappers, progress, boot failure, HTTP/auth recovery, migration, and
namespace behavior. Existing replica and outbox tests will run unchanged.
