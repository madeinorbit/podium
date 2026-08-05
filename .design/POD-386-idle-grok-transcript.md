# POD-386 — an idle grok session now has a conversation

A grok session that was started but never used showed nothing in Podium's chat
view. The conversation only appeared after the first message.

## What was actually wrong

The brief's suspicion was right, and stronger than expected. Verified against
grok **0.2.118** on this machine:

| launched as | session dir created at boot | SessionStart hook fires |
| --- | --- | --- |
| `grok` | no — nothing under `~/.grok/sessions/<cwd>/` at all | no |
| `grok --session-id <uuid>` | yes — `chat_history.jsonl`, `summary.json`, `updates.jsonl` | yes, immediately |

So a bare `grok` creates *no session state whatsoever* until its first turn. The
observer's polling discovery was not slow or mis-tuned — there was genuinely
nothing on disk to find, and no hook to hear. Tolerating the gap with an empty
state would have left the session unbound too: no resume ref, no transcript, no
chat until the user typed.

## The fix

Podium names the session instead of discovering it. A fresh grok spawn is now
launched as `grok --session-id <minted-uuid>`, and the daemon hands that same id
to the observer as the session's native id. Everything downstream — resume ref,
transcript path, causal binding — is known at spawn.

The id is minted per spawn rather than derived from the Podium session id: grok
rejects a `--session-id` that already exists, so a re-spawn of the same row must
not reuse one. `--session-id` is new-session only, so it is dropped when
resuming (grok errors there unless you also pass `--fork-session`, which would
fork rather than continue).

Declared as a capability (`newSessionIdFlag`), so the daemon's spawn path stays
harness-agnostic and the other four harnesses are untouched.

### One thing had to be fixed alongside it

Grok writes a synthetic turn into `chat_history.jsonl` at session creation: an
~8KB `<system-reminder>` skill listing wearing `role: "user"`. Podium's mapper
did not filter it (its heuristic looked for `system_reminder`; grok writes
`system-reminder`), so making the transcript readable at boot would have opened
every untouched session on a wall of injected context posing as the user's first
message. Records carrying grok's own `synthetic_reason` marker are now dropped —
the same call Claude Code's `isMeta` turns already get.

## Before / after

Both arms drive the real `grok` CLI and the real harness observer for 8 seconds,
with nobody typing:

```
arm: before (discovery)          arm: after (minted id)
launch: grok                     launch: grok --session-id 1ba4e457-…

resume ref  : (none)             resume ref  : 1ba4e457-ba9a-4936-bbf4-c464ac39ca06
transcript  : (none)             transcript  : ~/.grok/sessions/…/chat_history.jsonl
chat items  : 0                  chat items  : 0
```

The `after` arm's `0` is the correct answer, not the old one: the session is
bound, its transcript is resolved and readable, and it maps to an empty
conversation because nothing has been said yet.

## What changed

| file | change |
| --- | --- |
| `packages/harness/src/manifest.ts` | `newSessionIdFlag` capability + `newSessionId` launch option |
| `packages/harness/src/manifests/grok.ts` | emits `--session-id` for a fresh spawn |
| `apps/daemon/src/control/session.ts` | mints the id when the harness declares the capability and there is no resume |
| `apps/daemon/src/session-observers.ts` | binds the observer to the minted id |
| `packages/transcript/src/grok.ts` | drops grok's synthetic injected turns |

Covered by unit tests for the launch args and the transcript filter, and by a
daemon integration test that spawns grok with nothing on disk and asserts the
session binds anyway.
