# Expo HTTP sync integration

## Implementation

The mobile provider injects `HttpBootstrapSource` and `HttpDeltaSource`. Native
requests use `expo/fetch`; mobile web uses global fetch. Both reuse `bearerHeaders`
for bearer and workspace selector construction, matching `fetchMobileTransport`.
Native omits cookies; web includes cookies. HTTP 401 invokes the existing credential
expiry handler and remains a typed auth refusal at the shared HTTP source boundary.
The feed wrapper forwards `syncHttp` and `requestFreshWorld`, enabling the shared
HTTP handshake and rebootstrap behavior. Existing push fixtures remain for POD-3945
removal; the live provider no longer calls `sync.feedChangesSince`.

The adapter does not set `Accept-Encoding` or decode content codings in JavaScript.
Native gzip is the operator's selected platform behavior. Its actual negotiation is
unverified here. A missing reader permits buffering only an identity response with
a valid Content-Length no larger than 512 KiB; missing, malformed, oversized, or
compressed declarations fail before reading. Actual byte length is also checked.

Each HTTP attempt clears progress counts, including retries at the same snapshot.
Metadata supplies total rows; data records advance received rows. Bootstrap enters
saving at the certified completion chunk and becomes ready on durable installation.
Warm delta commits report saving via `heal-progress`; completion returns to ready.
`MobileSyncBoundary` retains the cold splash, 30-second trouble/retry surface, and
non-intercepting warm status capsule.

## Version refusal

Code inspection confirms `pairing.ts` rejects incompatible `/version` wire ranges
before auth status. `root-layout-shell.tsx` places `ServerProfileGate` outside
`MobileClientProvider`. A failed native profile preflight renders
`ActivationFailureView` before children mount; version mismatch is not eligible for
offline activation. Thus the existing wire-skew refusal is reachable before the
replica gate. The future capability/cutover refusal remains POD-3945's contract.
This is code-level evidence, not a device screen observation.

## Device verification: NOT RUN

No iOS device/simulator or Android emulator is available on this Linux host; device
and headed spawning are blocked. Per the operator's instruction relayed by POD-3933,
this does not block integration review. The operator's Mac/device path and all
on-device verification are tracked by **POD-4034**.

Not measured: request Accept-Encoding, response Content-Encoding, first application
NDJSON record time versus completion, cold install, warm heal, auth expiry surface,
and peak native JS heap for a 50 MB HTTP bootstrap versus the WebSocket baseline.
No device screenshots or build were produced. The staged world Map is unchanged;
no native memory reduction is claimed. Browser or Bun measurements are not native
evidence, and the mobile lane uses react-native-web in happy-dom.

POD-4034 should capture both coding headers against an HTTPS dev server using the
EAS device profile, timestamp the first application record and transfer completion,
observe progress while the transfer is still open, and exercise cold install, warm
heal, and revoked bearer recovery. Compare peak JS heap on the same device and
50 MB fixture for HTTP and the pre-cutover WebSocket build. If the native stack
omits Accept-Encoding (server defaults to zstd), or buffers gzip until completion,
report the finding to POD-3933 rather than adding a native zstd decoder or presenting
completion-only progress as streaming.

## Pre-existing mobile lane failure

The terminal confirmed-session remount assertion in
`apps/mobile/src/terminal/terminal-pane.test.tsx:238` expects `lastMountOpts.gridMode`
to be `server-grid`, but receives undefined. POD-3933 independently reproduced it
without this integration on the integration tip `f99b25a80` and clean `dev/mw`
`1b62bbcd9` (`dirty=0`). The file is also flaky: the coordinator observed two failures
on one clean-tree run and one on an immediate rerun of the same tree. This programme
does not change terminal files. The finding remains Proposed as POD-4036; no fix,
workaround, or staffing is part of this integration.

## Validation results

Commands used the pinned Bun 1.4.2 executable via PATH; global Bun on the host is
still 1.3.14. Checkout-local dependencies were installed with `setup:worktree`.
The issue branch was rebased onto integration tip `f99b25a80` before validation.

- `bun run test:mobile`: 913 passed, 1 failed, 4 skipped (147 files). The only
  failure is the pre-existing terminal assertion above. Mobile replica: 25 passed;
  fetch port: 11 passed; progress store: 6 passed. The HTTP assembly test confirms
  received-row progress while the stream is still open, withholding bootstrap
  installation until completion, and committing warm delta rows incrementally.
- `bun run test`: **lean gate green** after correcting a test-only HeadersInit
  table annotation. Typecheck and span-effect lint passed; the lean runner executed
  126 tests in 4 of 1,339 root node-project files (0.3%). This is not a full-suite
  result. The type annotation does not change the mobile test cases or runtime.

The first mobile run rejected this issue's abbreviated wire fixture; replacing it
with a complete issue record made the assembly test pass on the full mobile rerun.
The first lean attempt found the header-table type error; the corrected rerun
exited zero. No browser/native runtime success is inferred from these gates.
