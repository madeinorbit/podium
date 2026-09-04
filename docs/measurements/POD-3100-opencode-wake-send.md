# POD-3100 — OpenCode wake and send measurement

Measured 2026-08-29 22:31–22:42 UTC. Neither reported OpenCode symptom reproduced on the exact current `issue/1761-agent-runtime` tip. No product code was changed because no target contract was broken.

## Pins and isolation

- Integration base: `62bb4a749241c7c7bd85fbca59e86a9651e4f4de` (`dev+62bb4a7`, source digest `62bb4a7`). The branch advanced from `fbc2f18baf77d74d370c6469444b3c3d800b0a71` during the drive by a documentation-only commit, so the runtime was restarted and the batch repeated.
- Instance `p3100oc`; state `/tmp/podium-p3100-opencode-fbc2f18b/state`; agent home `/tmp/podium-p3100-opencode-fbc2f18b/agent-home`; scratch repo `/tmp/podium-p3100-opencode-fbc2f18b/repo`.
- Loopback-only ports: server 19910, hook 46910, relay 46911, source web 32110.
- Every sample re-read `/version` and `/proc/<pid>/{cwd,environ}`. Server PID 1738737 and daemon PID 1739380 pointed at this issue worktree; web PID 1755584 pointed at `apps/web`; all carried `PODIUM_INSTANCE=p3100oc`.
- The operator/default instance, `instance.json`, ports 19797 and 32090, and their processes were not changed, restarted, or repaired.

## Method and outcome

Four fresh conversations were launched through the source UI. Each used a unique exact-reply prompt and measured durable session creation, runtime bind, durable user row, direct provider-side prompt visibility, first output, and idle/composer-ready. Each then received a unique second prompt through the live composer, measuring those boundaries plus the `sessions.sendText` response.

Provider visibility came from the isolated per-session OpenCode server using credentials read locally from its journal. Only boolean prompt presence was retained; credentials were never printed or written to evidence. Every sample required `driverId=opencode-server`, an exact real-provider reply, an empty final queue, and no timeout.

- Fresh: 4/4 bound, drained the attempt-0 initial queue, reached the provider, returned the exact reply, and returned idle; 0 timeouts.
- Follow-up: 4/4 returned `{ ok: true, disposition: "delivered" }`, reached the provider, returned the exact reply, and returned idle; 0 queue rows and 0 timeouts.
- Positive control: 8/8 exact real-provider replies at the current pin.
- “Waking the agent” appeared transiently and cleared in every sample.

A separate negative control opened a new-task composer, filled a unique prompt, pressed plain Enter, and watched 10.077 seconds. It produced zero `sessions.sendText` responses, session count stayed 9, and queued-row count stayed 0. This is an ignored UI command: new-task submission is Launch or Command+Enter. It is not a queued message, failed wake, lost receipt, duplicate suppression, or provider failure.

## Latencies

Milliseconds from click or Enter; n=4, minimum / median / maximum. Independent polling means provider visibility may be observed before the durable row or HTTP response; the values identify boundaries rather than strict causal ordering within a polling interval.

| Fresh launch boundary | min | median | max |
| --- | ---: | ---: | ---: |
| session row | 757 | 843 | 1003 |
| live `opencode-server` bind | 4710 | 5223.5 | 5565 |
| visible Waking → bind | 3209 | 3769 | 3978 |
| durable user row | 6363 | 6581.5 | 6801 |
| provider prompt | 6730 | 6814 | 7137 |
| first output | 8512 | 9108.5 | 9231 |
| idle/composer ready | 8947 | 9864 | 9939 |

| Live follow-up boundary | min | median | max |
| --- | ---: | ---: | ---: |
| provider prompt | 79 | 246 | 377 |
| durable user row | 377 | 670.5 | 949 |
| delivered receipt response | 763 | 827.5 | 868 |
| first output | 1387 | 1885 | 2936 |
| idle/composer ready | 1925 | 2362 | 3709 |

Fresh-task Launch creates the session and initial queued input atomically; it does not call browser `sessions.sendText`, so there is no client-facing send receipt at that boundary. Its durable acknowledgement is the new session plus one `queued_messages` row at attempt 0. In all samples that row remained while starting, drained without retry after bind, and the exact prompt then appeared at the provider. The live follow-up path produced four explicit delivered receipts.

## Transition and ledger evidence

The fresh path repeated as: `starting` with one attempt-0 queue row → UI Waking → `live`, `opencode-server`, phase idle, composer ready → queue drained and phase working → durable user/provider prompt → output → idle with empty queue.

The follow-up path repeated as: Sending → delivered receipt/durable row/provider prompt → Working → output → idle, always with an empty queue.

The daemon logged OpenCode server binds for the four sessions at 22:31:13, 22:31:25, 22:31:38, and 22:31:53 UTC. Their isolated journals ended at `seq=33`, `turnEpoch=2`, `bindingVersion=1`, and `fencedTurnEpoch=2`, matching two accepted turns. The runtime event outbox had zero pending entries after the batch; all queued-message ledgers were empty. Raw evidence includes status/UI transitions, queue attempts, durable transcript observations, provider visibility, receipt bodies, exact replies, frame summaries, and process pins, with no secrets.

| Candidate | Evidence | Classification |
| --- | --- | --- |
| ignored UI submission | Plain Enter created no mutation, session, or queue row | Expected new-task contract |
| queued message | Every Launch created one attempt-0 row and drained it | Healthy |
| failed wake | Every fresh row reached live bind within 5.565 s | Not reproduced |
| lost receipt | Every follow-up delivered within 868 ms | Not reproduced |
| duplicate suppression | All unique prompts reached transcript/provider and received unique replies | Not reproduced |
| provider failure | Direct provider endpoint saw and answered all eight prompts | Not reproduced |

Reopening chat views did expose a separate presentation defect: rendered transcript rows multiply while the durable transcript remains unique. It is tracked independently as POD-3104 and was not used to explain either requested symptom.

## Stale sandbox delta

The operator clue was web digest `70fa13cce3587a169b22e4205cb3e9a88ab6b460`; current source was `62bb4a749241c7c7bd85fbca59e86a9651e4f4de`. Relevant changed files are Grok-only runtime/chat synchronization and tests: `apps/daemon/src/runtime/grok-acp-server.ts`, `apps/daemon/src/runtime/server-driver-home.test.ts`, `apps/web/src/features/chat/{ChatView.headless.test.tsx,TranscriptFeed.tsx}`, and `packages/agent-runtime/src/drivers/grok-acp/*`.

There is no changed OpenCode driver, session wake/inbox, runtime-gateway receipt path, composer submission path, or Waking-state component. The closest UI delta suppresses a Grok legacy overlay, so it cannot explain these OpenCode symptoms. No stale-to-current source change can honestly be named as the fix.

The most likely stale-sandbox delta is therefore unproved component/process state—mixed web/server/daemon pins or a stranded OpenCode child/binding—rather than the stale web digest itself. This is an inference from the absence of a relevant source delta and the healthy fully pinned instance; the operator sandbox was deliberately untouched, so its process state was not inspected.

The prompt symptom also has a concrete non-failure explanation: plain Enter in the new-task composer is ignored. If Launch or Command+Enter still produces no mutation, the next evidence needed is that sandbox's network request plus queue/receipt rows under separately authorized inspection.

## Refused fixture readings

A scrubbed-environment provider preflight initially lacked a user D-Bus and failed before OpenCode spawn; `PODIUM_NO_SCOPE=1` then passed the real provider/reply/idle control. Vite under Bun later crashed proxy cleanup on `socket.destroySoon`; the exact-tip source web was relaunched under Node on loopback and all pins were re-proved. Neither fixture failure entered target sample counts.
