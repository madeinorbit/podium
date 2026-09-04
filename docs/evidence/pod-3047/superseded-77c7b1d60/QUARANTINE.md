# HISTORICAL — do not read these as current

Readings and pins taken at epic tip `77c7b1d604e96162ec6c2b024612001aeeafce69`,
2026-08-28 16:03–16:26 CEST. **Superseded** by the readings one directory up,
pinned to `593e40ef55a2e0c68f68f7f9028def95dc18d507`.

The non-docs delta from `86d707d89` to `77c7b1d60` was **zero files**, and every
verdict at this pin matched the one before it — which is the whole value of this
set: it is a same-code reconciliation, and it agreed. `a3-repeats/` holds the
five-run A3 distribution taken here.

`593e40ef5` is the first tip in this drive whose delta genuinely touches these
cells: 18 non-docs files including `packages/agent-runtime/src/drivers/claude-sdk/runtime.ts`,
the whole `apps/daemon/src/claude-sdk-*` stack, `packages/transcript/src/claude.ts`
and a new `tool-transcript.test.ts`. That is why the set was re-driven rather
than argued forward.
