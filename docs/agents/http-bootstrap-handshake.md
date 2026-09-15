# HTTP bootstrap handshake

A `FeedSink` constructed with `HttpBootstrapSource` advertises `sync.http.v1` through
`SocketHub`. Compose that same source into the replica authority's `bootstrap` port;
compose `HttpDeltaSource` into `changesRange`. Platforms select these sources. Existing
`PushedBootstrapSource` compositions retain their pushed-world behavior until cutover.

A cursorless capable hello receives `feedResume` at the server head. A resumable cursor
receives `feedResume` at that cursor. A refused cursor receives `feedResyncRequired`,
with its publisher positioned at the current head so live delivery continues during
HTTP recovery. No capable admission or version change sends a WebSocket bootstrap.

The cold replica fetches the snapshot over HTTP, buffers concurrent deltas, and atomically
installs at S with contiguous frames above S applied once. Frames covered by S are dropped;
a gap heals through `/sync/delta`. Reconnects present the installed cursor and heal without
a second snapshot unless the authority requires recovery.

A routine socket drop during an HTTP walk clears buffered frames and marks an install-time
heal, without aborting the transfer or changing its generation. Explicit replica `disconnect()`
still cancels the walk. Reconnection during that walk leaves it running.

## Bounds and recovery

The hub drops a backlog exceeding 256 deltas and asks the replica to rebootstrap over HTTP,
without closing the socket. During a walk/heal the replica holds at most 10,000 live frames;
an overflow discards the buffer and restarts the bounded bootstrap ladder. The server's
existing D9 send-queue bound sheds slow peers with `feedResyncRequired`, which takes the
same HTTP recovery path. These bounds do not accumulate an unbounded world or delta queue
on the server. The snapshot staging map remains proportional to the scoped world.
