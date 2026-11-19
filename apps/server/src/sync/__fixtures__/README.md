# Frozen one-row builder evidence

`one-row-oracles.json` captures the pre-generation builders, capture sources and kind-token
algorithm from commit `1d8ba77d9fe9a1c446c1736236d82218691f2dfd`. It was exported once on the
shared SQLite corpus by temporary test instrumentation in `6bc87e4c26`; the instrumentation
and all three executable `.before.ts` oracles were then deleted.

The capture compared old and new stream/build bytes for every one of the 18 row kinds and
proved that deliberately wrong new answers fail. It also compared all 207 capture trigger
statements, captured insert/update/delete identities and all 38 shape tokens before writing
the data. The capture log is attached to the issue.

The JSON contains the relevant raw SQLite input rows (with foreign-key parents), the clock,
the served effect kinds and the token generations. This keeps generated IDs and timestamps
fixed without normalizing or ignoring record fields. No server secrets or unrelated metadata
are included: only `meta['settings']` is needed. Tests replay the inputs in a fresh SQLite store
and compare JSON bytes, trigger text, capture identities and tokens directly to the frozen
outputs. They also retain the wrong-answer mutation check. The fixture has no automatic
snapshot-update path.
