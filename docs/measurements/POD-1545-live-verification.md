# POD-1545 — `issue start --model/--effort`, verified against the live instance

Measured on **ludovico, 2026-08-03**, against the running server after `main` moved to
`f00e901d` and `podium-redeploy.service` restarted `podium-server` + `podium-daemon`
(`ActiveEnterTimestamp=Mon 2026-08-03 10:19:48 CEST`). The `podium` CLI is a wrapper that
runs the live main checkout's source directly, so it carries the same commits.

Every read-back below comes from `podium session status`, whose `runtime:` line reports the
**observed** harness/model/effort of the running agent — not from `issue start`'s own echo.
A flag that is parsed and then dropped looks identical to success in that echo, which is the
failure this whole exercise is aimed at.

## 1. Explicit flag beats the issue's stored value

Fixture POD-1550, stored `effort=low`:

```
$ podium issue show 1550 | grep effort
agent=claude-code model=auto effort=low

$ podium issue start --id 1550 --effort high
started #1550 (issue/1550-pod-1545-live-check-a @ …/.worktrees/issue-1550-pod-1545-live-check-a)
  68ecdcb3-862b-45c6-900c-1ffa877dd9fb (claude-code) model=default effort=high machine=ludovico

$ podium session status 68ecdcb3-862b-45c6-900c-1ffa877dd9fb
68ecdcb3-862b-45c6-900c-1ffa877dd9fb live/idle
runtime: harness=claude-code model=claude-opus-5 effort=high context=unknown
```

The launched session **runs at high**. The flag persisted, as documented:

```
$ podium issue show 1550 | grep effort
agent=claude-code model=auto effort=high
```

## 2. No flag ⇒ the stored value, not a default

Fixture POD-1551, stored `effort=low`, started with no flag:

```
$ podium issue start --id 1551
  9bfd39fb-d1de-452c-a45c-601697f8dca8 (claude-code) model=default effort=low machine=ludovico

$ podium session status 9bfd39fb-d1de-452c-a45c-601697f8dca8
runtime: harness=claude-code model=claude-opus-5 effort=low context=unknown

$ podium issue show 1551 | grep effort
agent=claude-code model=auto effort=low        # stored value untouched
```

## 3. Both dimensions, explicitly

Fixture POD-1552:

```
$ podium issue start --id 1552 --model claude-sonnet-5 --effort medium
  47737521-2d3e-4f04-9aa4-3ed46f93c574 (claude-code) model=claude-sonnet-5 effort=medium machine=ludovico

$ podium session status 47737521-2d3e-4f04-9aa4-3ed46f93c574
runtime: harness=claude-code model=claude-sonnet-5 effort=medium context=unknown
```

## 4. It can say NO — and nothing is created

```
$ podium issue start --id 1550 --effort banana
podium issue: claude-code: unknown effort "banana" — not in the model catalog
(the model catalog was refreshed 38m ago). Valid efforts: "low", "medium", "high", "xhigh", "max".

$ podium issue start --id 1550 --model claude-opus-9
podium issue: claude-code: unknown model "claude-opus-9" — not in the model catalog
(the model catalog was refreshed 38m ago). Did you mean "claude-opus-5", "claude-opus-4-8",
"claude-opus-4-7"? Pass --force-unknown-model to spawn with it anyway.

$ podium issue show 1550                       # after both refusals
stage=backlog P2 ready=true blocked=false
agent=claude-code model=auto effort=low        # profile untouched too
```

The valid-effort ladder is printed outright rather than left to "did you mean": that
suggester needs an 0.85 similarity to fire, so `banana` matched nothing and the message
previously fell through to *"That model supports no reasoning-effort levels"* — which was
simply false.

This refusal is also the capability probe that proves the **server** carries the change and
not merely the CLI: the proc input is a non-strict `z.object`, so a server without
`defaultModel`/`defaultEffort` would have silently stripped them and started the issue.

## 5. Already-started issues no longer swallow the flags

Found while running the above. Re-starting a started issue returns early by design, so the
new flags were accepted, dropped, and `started #n` printed anyway:

```
# before the follow-up fix
$ podium issue start --id 1551 --model zzz
started #1551 (issue/1551-pod-1545-live-check-b @ …)     # 'zzz' silently ignored

# after (live, same command)
$ podium issue start --id 1551 --model zzz
podium issue: #1551 is already started — --model/--effort apply only to the session start
spawns. Use `podium issue update --id 1551 --model/--effort` to change the issue's profile,
then `podium issue add-session 1551` to spawn a session that runs it.

$ podium issue start --id 1551                            # plain re-start: still a no-op
started #1551 (issue/1551-pod-1545-live-check-b @ …)
```

## Fixtures

POD-1550 / POD-1551 / POD-1552 were throwaway sub-issues of POD-1545. Their sessions were
stopped, the issues closed, and their branches and worktrees deleted after the run.
