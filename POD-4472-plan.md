# POD-4472 plan: hooks behind the adapter (WIP note, delete before review)

## Shape (from POD-4471 worked example)
- `packages/harness/src/adapters/codex/transcript.ts` + `store/store.ts`: grammar lives
  in adapter, Store receives narrow typed SUBSET. Same for instrumentation:
  `adapters/<h>/instrumentation.ts = { install(destination), payloadCodec, hookTransport }`,
  `adapters/<h>/state.ts` = screen/hook state rules (translate fns) moved out of
  `agent-state/<h>.ts`. Generic reducers (causal.ts, reducer.ts,
  transcript-classifier.ts) stay generic as `driver/families/terminal/observer.ts` (new).

## Deletes
- apps/daemon/src/codex-hooks.ts, grok-hooks.ts, hook-ingest.ts (transport stays?
  ingest is the loopback HTTP server — check: hookTransport 'loopback-http' means the
  TRANSPORT stays generic, per-harness part is codec+install), hook-payload.ts,
  runtime/terminal-instrumentation.ts harness switch.
- NOTE: runtime/registry.ts is MINE; session/registry.ts is POD-4512's. Check path.

## Capability-flag replacements (session-observers.ts)
- L709 `checkpoint.provider === 'claude-code'` + L1537
  `observationLease?.provider === 'claude-code'` → `observationProtocol === 'claude-causal'`
  (already used at L775, L1649, L1703).

## Consumers of new section type (in adapter.ts)
- Terminal family Driver.create installs via `sections.instrumentation.install`;
  Driver.observe decodes via `sections.instrumentation.payloadCodec`.
  Family subset: {runtime, state, instrumentation, launch, environment, composer}.
- injection.ts send-proof + prompt-hook fingerprint read `adapters/<h>/runtime.ts`.
- `instrumentationRequired` keeps meaning: required install failure = spawn REFUSAL.

## Pitfalls
- Decode ORDER: hook events are causal source of turn edges → run runtime-event tests.
- claudePromptHookFingerprint stays an INJECTED port (POD-2021 boundary manifest).
- Known reds, do NOT chase: opencode-attach.test.ts 1/76; agent-state/opencode.test.ts (POD-4517).
- Do not touch POD-4509 files (claude-sdk family, engines.ts, host.ts, host-runtime.ts,
  opencode-attach.test.ts) or POD-4512 files (session/{daemon-session,registry}.ts,
  control/session.ts, runtime/terminal-driver.ts, machine-runtime/handlers/headless-driver/watch.ts).

## Open questions (resolve while reading)
1. Does hook-ingest.ts (loopback HTTP server) stay as generic transport with per-harness
   codec plugged in, or move? Brief says hook-ingest.ts DELETED — so transport must live
   somewhere generic (hookTransport: 'loopback-http' is just a discriminant).
2. Where does `prepareTerminalInstrumentation` / `installTerminalInstrumentation` go?
   Probably terminal family create path via sections.
3. observer.ts: new file housing generic reducers, or re-export shim?
4. session-observers.ts still needs SOME hook routing (onHookPayload) — via adapter codec.
