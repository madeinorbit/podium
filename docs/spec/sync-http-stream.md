# HTTP sync stream v1

`GET /sync/bootstrap` and `GET /sync/delta` return UTF-8 NDJSON with
`Content-Type: application/x-ndjson`. Each complete JSON record occupies one LF-terminated
line; embedded newlines are JSON escapes. Each line parses independently. Batches are
bounded; there is never one JSON array for the whole transfer. Standard HTTP content
encoding may compress the stream. Bounds apply to decoded UTF-8 record bytes, excluding LF.
A buffering proxy may delay delivery but does not change the protocol.

The executable contract is `packages/protocol/src/messages/sync-stream.ts`, exported by
`@podium/protocol`. `SyncRecord` is the producer schema; `SyncRecordLenient` admits
unknown entity kinds through the existing `FeedChangeLenient`. Known malformed entity
values still fail. Unknown object fields are stripped as in the existing feed schemas.
`parseSyncRecord(line)` returns `{ kind: 'record', record }`, `{ kind: 'ignored', type }`
for a future record type, or `{ kind: 'refused', reason }` for malformed/oversized input.
These local parser refusals are distinct from HTTP refusals and server `syncError` reasons.
Unknown record types do not certify ranges or count as data lines (ADR 2 D4).
The transport decoder must bound its unfinished line buffer before calling this parser.

## Record vocabulary

| Type | Fields and meaning |
| --- | --- |
| `syncMeta` | First line, exactly once. `formatVersion: 1`, `mode: 'snapshot' \| 'delta'`, `transferId`, `feedId`, `epoch`, `seq`, `minAvailableSeq`, `wireVersion`, `wireSchemaDigest`, optional `totalRows`. `fromSeq` is required only in delta mode and forbidden in snapshot mode. |
| `feedBootstrap` | Existing `FeedBootstrapMessage` unchanged: certified range, positive upsert `changes`, `last`, optional `totalRows` and `countsByEntity`. Every chunk has `fromSeq: 0` and the snapshot cursor `seq: S`. |
| `feedDelta` | Existing `FeedDeltaMessage` unchanged: certified range and `changes`, including empty watermark batches. |
| `syncComplete` | Last line, exactly once on success: `transferId`, `seq`, `records` (data lines), `rows` (change rows). Its transfer and cursor must equal meta; counts must equal emitted data, including unknown entity rows. |
| `syncError` | Terminal failure replacing complete: `transferId` and closed `reason`. The stream closes after this line. |

Producers generate a cryptographically random, opaque `transferId` (for example a random
UUID), safe to log and containing no credentials or principal information. The schema
accepts a nonempty string; it cannot verify entropy. Epoch uses `FeedEpochField`.
`wireVersion` is the existing `WIRE_VERSION`; `wireSchemaDigest` is exactly the 16-hex-digit
value exposed by `/version`, not a new compatibility identifier. Never expose the server's
drizzle journal. `totalRows`, when present, is an exact scoped count cheaply obtained by
the producer; absence means unknown, not zero. Meta is the canonical total.

Closed `syncError.reason` values: `compressor-failed`, `read-failed`, `deadline`,
`cancelled`, `row-too-large`, `server-shutdown`, `authorization-changed`.
If transport or compressor failure prevents sending even the error, premature EOF still
fails the transfer. A client must treat every stream without `syncComplete` as failed,
regardless of rows received or a bootstrap chunk's `last` flag.

## Snapshot replacement and authorization

The snapshot is one consistent scoped world at cursor S. Every chunk carries the same
feed identity, S, and retention floor. Validate the existing frame invariants, require
`fromSeq: 0`, and require `last: true` only on the final data chunk. An empty world still
has one empty final bootstrap chunk. Stage all chunks until matching completion and counts
have been validated; atomically replace the world and install cursor S. There is no partial
bootstrap installation. In particular, the legacy `last` field alone does not authorize
installation on the HTTP path.

Under ADR 2 Amendment 1 D14, a snapshot at S plus the live feed from S remains correct
because visibility changes after S arrive as anchored evict/upsert rows. No scope generation
is transmitted. Authorization revoked during production can terminate the transfer with
`authorization-changed`; staged incomplete bootstrap state is discarded.

## Finite delta certificates and query

Query spelling: `/sync/delta?feedId=F&epoch=E&from=C&to=H`. The shared `feedId` and `epoch`
identify both full cursors `(F, E, C)` and `(F, E, H)`. Each named parameter occurs once;
`from` is required and `to` is optional. Encode identity strings with URL query escaping.
Sequences are nonnegative safe integers written in canonical decimal digits, without signs,
whitespace, fractions, or exponents. `to < from` is invalid. `SyncDeltaQuery` validates the
string-valued query object; `parseSyncDeltaQuery(URLSearchParams)` additionally rejects
repeated parameters and returns Zod's typed safe-parse result. Unrelated parameters are ignored.

Without `to`, the authority captures H once before reading; it never chases a moving head.
Meta carries C as `fromSeq` and H as `seq`. Every delta line has the same feed identity;
the first starts at C, each subsequent `fromSeq` equals the preceding `seq`, and the final
line ends at H. Rows are ordered within each certified `(fromSeq, seq]` and must satisfy
`validateFeedFrame`, including operation/value rules. `validateSyncDeltaChain(lines)`
checks the complete parsed transfer and returns an empty violation array on success.

A range with no visible changes and C < H still emits one empty `feedDelta` certifying
(C, H]. When C == H, meta followed directly by complete is valid. Filtered rows never
leave uncertified gaps. Consumers may commit validated delta certificates incrementally,
but must report an interrupted transfer as failed and must never claim H without the
matching complete; recovery starts at their last committed certificate.

## Pre-stream refusals

These responses contain no NDJSON records. Shared constants are `SYNC_REFUSAL_STATUS`
and `SYNC_RETRY_AFTER_HEADER`.

| HTTP status | Meaning |
| --- | --- |
| 401 | Unauthenticated. |
| 403 | No feed principal. |
| 409 | Delta requires bootstrap; JSON body described below. |
| 426 | Unsupported wire version. |
| 503 | Admission queue full; supply `Retry-After`. |

409 body: `{ "kind": "bootstrap-required", "reason": REASON }`, validated by
`SyncBootstrapRequired`. Closed reasons are `feed-identity-mismatch`,
`compacted-or-unknown`, `corrupt-payload`, `rescope`, `future-cursor`, and `invalid-target`.
`corrupt-payload` preserves the distinction between an unreadable retained row and a
retention miss; both require bootstrap recovery.
These retain the existing catch-up reason spellings; `FeedChangesSinceReply` itself
currently permits an optional free-form string and is unchanged. Malformed query input
is rejected before streaming; the endpoint owns its ordinary bad-request response.

## Bounds

- `SYNC_LINE_MAX_BYTES`: 16 MiB, a hard limit for any decoded record line excluding LF.
- `SYNC_BATCH_TARGET_BYTES`: 1 MiB, a producer batching target.
- `SYNC_BATCH_MAX_ROWS`: 500, a producer batching target ceiling.

Account for the complete serialized envelope when applying the line bound. A row that
cannot fit in a bounded line is a hard `row-too-large` failure, never silently omitted.
A row may exceed the target batch size and occupy its own line if the hard bound permits.

## WebSocket handoff and compatibility

`CAP_SYNC_HTTP_V1 = 'sync.http.v1'` in `hello.caps` means the client has adopted HTTP sync.
Cold start: HTTP snapshot → atomic install at S → WebSocket `hello.feedCursor = S` →
`feedResume`; gaps heal through finite HTTP delta streams. A capability-bearing peer
must never receive a pushed world. A rejected resume uses `feedResyncRequired` and the
client fetches a new snapshot. The handshake sub-issue supplies the runtime behavior.

Legacy push support remains only for clients without the capability until the programme's
native-build rollout condition is met. This additive feature does not change `WIRE_VERSION`.
The HTTP schemas do not join the WebSocket `ServerMessage`/`ClientMessage` unions, so this
addition does not change `wireSchemaDigest()` or trigger digest-skew reloads by itself.
