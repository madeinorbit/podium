# Native session metadata

Session titles, observed model/effort, transcript colour and live context percentage
cross the driver boundary as `metadata` runtime events. Each observation retains a
source (`osc`, `native`, or `transcript`) and the standard causal envelope. A
snapshot carries the latest observation for each kind, including its original
envelope; it does not restamp those values to the snapshot request time.

Transcript callbacks retain the native record timestamp when available. OSC and
native callbacks that supply no timestamp use their first sighting time. Neither
metadata observation nor reconnect bootstrap advances session activity time.
Metadata is independent of turn completion and remains admissible after a turn
closes. Change-only sources use retained delivery so a lost final update does not
wait indefinitely for another change. The durable server projection cursor moves
only after metadata application succeeds.

On contract bind, the server requests a snapshot to restore missed metadata. The
same per-kind generation/cursor fence handles the snapshot and accepted events,
including a snapshot racing a newer live update. Latest driver metadata survives
bounded event-log trimming. Compatibility frames and contract events use the same
setters and title debouncer, making duplicate sightings idempotent.

The existing native sources remain: transcript colour/model/context parsers,
native title and model observers, and allowed terminal OSC titles. Codex OSC
spinner/cwd titles are refused at both the producer and metadata projection;
Codex native summaries are allowed. Stable-title filtering and spinner stripping are shared with the driver, so
animation never becomes retained metadata traffic. Quiet-window publication and
first-real-prompt fallback remain server policy.
Curated user naming remains separate from the observed title.

Observed model and effort never rewrite requested configuration. Missing effort
preserves the last observed effort; explicit colour-reset values and zero context
usage remain meaningful updates. Context percentage is live session metadata,
not historical cost, account usage or quota. The existing `usage()` compatibility
read remains available without becoming the server's metadata source.
