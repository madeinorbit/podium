# Why agents kept calling their own issue "POD-123"

Evidence behind the prime rewording and the CLI nudges. The rule itself lives in
`SELF_REF_RULE` (`packages/protocol/src/refs.ts`); the guide entry is
[podium-issues.md § Naming the issue you're on](podium-issues.md).

## The rule was real, and it was losing

Added 2026-07-22 in `979e194e` as a prime rule. Every session below post-dates it.

Scanned every transcript in `~/.podium/transcripts/local` carrying a prime line
(117 sessions, Claude Code and Codex alike), counting occurrences of the session's
own ref in assistant prose and discounting sanctioned forms (commit trailers,
filenames, session refs like `POD-344-B`, the `this issue (POD-N)` pairing):

| measure | result |
| --- | --- |
| primed sessions scanned | 117 |
| sessions with ≥1 bare self-ref in prose | **87** |
| bare self-ref segments / sanctioned uses | 498 / 84 |
| `podium offer` invocations naming their own issue | **218 of 928** |
| `podium issue state --set` naming their own issue | 115 of 684 |

The offer number is the one that matters: that text is the tray card headline.
Real examples — *"POD-355 merged to main and closed"*, *"POD-344 merged to main —
your phone needs one more step to get it"*.

## Five causes, heaviest first

1. **Prime demonstrated the violation before forbidding it.** The opening line was
   `You are working on POD-374: <title>` — the agent's first and most salient
   framing of its own issue was a bare ref, 25 lines above the rule that banned it.
   Everything else reinforced the ref: `--id 374` on every panel command, the
   branch `issue/374-…`, the mandated `Podium-Issue:` trailer, artifact filenames.
2. **Injected once per session.** `apps/daemon/src/prime-injector.ts` primes on
   SessionStart / first UserPromptSubmit and re-arms only on `PreCompact`. In the
   worst sessions (154 assistant turns, 37 self-refs) the rule sat ~150 messages
   back — and the violations cluster in end-of-work summaries, the farthest point
   from the injection.
3. **The two rules above it said the opposite, louder.** "Reference issues ONLY by
   their human-facing id" and "The canonical long form is `POD-557 (Issue title)`"
   are unconditional; the self-ref rule read as their footnote.
4. **It hedged, so agents hedged.** "or `this issue (POD-557)` where the ref
   matters, e.g. in mail or **reports**" — a handoff is trivially a report. Sessions
   that clearly saw the rule still drifted: POD-333 wrote the sanctioned form early,
   then plain "`POD-333` is closed" later.
5. **Nothing single-sourced or enforced it.** `TITLE_RULE`, `SPINOFF_RULE`,
   `LOCK_RULE`, `DELEGATION_RULE` all live in `@podium/protocol` so prime and the
   committed guides cannot drift. This one was a bare string in `reads.ts`, absent
   from every doc, with no validation on any surface.

Two scope gaps against the intent: the rule covered only "issue" (not the session,
not "I did it"), and said nothing about the offer headline — the surface it lost on.

## What changed

- **The demonstration carries the rule.** Prime now opens `You are working on this
  issue — \`POD-374\` (title). "This issue" is what you call it when you write to
  the user; the ref is for commands and for readers who cannot know which issue you
  mean.`
- **The hedge is gone.** The exception is drawn by *audience* — a reader who could
  not otherwise know which issue it is (another issue, mail to another agent, a
  commit trailer, a filename) — not by genre. It now also covers the agent: what
  you did is "I".
- **Single-sourced** as `SELF_REF_RULE` in `@podium/protocol`, consumed by prime and
  cited by `docs/agents/podium-issues.md`.
- **Nudged at the moment of the mistake.** `podium offer` and `podium issue state
  --set` print an advisory line when the submitted text names the caller's own
  issue. The write still lands — this only says how to phrase it next time.
  `bareSelfRefCount` stays silent on every sanctioned form, because a nudge that
  cries wolf gets tuned out.
- **The examples stopped teaching it.** `podium offer --help` and the guide's offer
  example both used `POD-12` for the caller's own issue.

## Re-measuring later

`bareSelfRefCount(text, ownRef)` is the same predicate the audit used. To re-run the
sweep, extract each transcript's own ref from its prime line (`You are working on
this issue — \`REF\``) and count it across assistant prose and `podium offer` /
`podium issue state` invocations.
