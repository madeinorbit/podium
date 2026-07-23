# Podium — YC Demo Narration (3:00)

Audience: YC partners. Technical, skeptical, watching a lot of these back to back. Register is
engineer-to-engineer — show the thing, state the tradeoff you took, move on. No slogans, no "and
this is the core idea", no closing manifesto. Every beat carries one non-obvious claim; if a line
isn't showing something on screen or saying something a competent engineer wouldn't already assume,
cut it.

Budget: ~140 wpm. Word counts per beat are listed — the script is 415 words and that is the ceiling,
not a target to grow into. **[SCREEN]** cues mark what's on camera. Cut *(parens)* first.

---

## Beat 1 — What it is (0:00–0:35) · 74 words

**[SCREEN: full shell, eight-ish agents live, spinners ticking, one card yellow]**

> Podium is an IDE for coding agents. I usually have eight or ten running.
>
> The panes in the middle are real terminals — Claude Code, Codex, Grok, the actual binaries in
> PTYs. Most agent platforms reimplement the agent loop against the model API. We don't. So hooks,
> permission modes, MCP, subagents work here on day one, and we never chase a CLI release.
>
> Left is workstreams. Right is the board.

## Beat 2 — Agents operate the system (0:35–1:15) · 96 words

**[SCREEN: new agent → Codex spawns into a native pane → type the prompt]**

> New agent, Codex. I'll ask for a feature:
>
> *"Implement export with Grok, and have Fable review it before merge."*
>
> Every agent gets the Podium CLI in its system prompt. So that one just filed a task, spawned a
> Grok implementer on its own git worktree, and queued a Fable reviewer behind it. They coordinate
> over agent-to-agent mail and an advisory merge lock — advisory, with no enforcement, because both
> sides are agents I prompted. That turns out to be enough.

**[SCREEN: RAM chip in the header climbing → memory view]**

> Three native agents and a build. I'm out of memory.

## Beat 3 — Adding a machine (1:15–1:55) · 97 words

**[SCREEN: super-agent → "set up a VPS" → one connect string]**

> So I add hardware. I ask the super-agent for a VPS and it hands back one string.
>
> **[SCREEN: VPS terminal, paste, install scrolling — pre-recorded, time-compressed]**
>
> That installs Podium, dials home to my instance, installs the three CLIs, and migrates my
> credentials across. Credential migration is the unglamorous part that makes this a one-liner
> instead of an afternoon — every agent CLI keeps auth somewhere different and none of them expect
> to be provisioned.
>
> **[SCREEN: back in the app — second machine chip in the header]**
>
> Second machine, same board. State lives in Podium; machines are interchangeable compute.

## Beat 4 — Handoff (1:55–2:35) · 92 words

**[SCREEN: right-click session → hand off to the VPS machine → departure/arrival morph]**

> Now I move the task that was choking my laptop. The branch, the worktree and the agent's context
> go with it. Work continues over there; my laptop goes quiet.
>
> **[SCREEN: superagent/CLI action — Claude's task picked up by a Codex successor]**
>
> Same move across models. Claude planned this one; Codex implements it. The task carries the
> context, so the successor starts where the last agent stopped instead of re-reading the repo.
>
> The thing that makes both of those one operation is that issues own branches — sessions never do.

## Beat 5 — Close (2:35–3:00) · 56 words

**[SCREEN: phone — same board, answer an agent's question, pocket it]**

> *(It follows me. An agent has a question at dinner — two taps, it keeps working.)*
>
> Ten agents is roughly a decision a minute arriving at you. So the interface has one rule: yellow
> means it needs you, and nothing else in the product may use it.
>
> That's Podium.

---

## Claims the demo has to actually land

Each is a thing a partner can't assume and shouldn't have to take on faith — so each has to be
visible on screen, not just spoken.

| Claim | Proof on camera |
|---|---|
| Real CLIs in real PTYs, not a reimplemented loop | Recognizable Claude Code / Codex chrome in the panes; a permission prompt or hook firing |
| Agents operate Podium itself | One prompt visibly produces a task + two more agents, unattended |
| Coordination is advisory, not enforced | Merge lock / agent mail visible on the board while both agents keep running |
| Machine onboarding is one string | Uncut paste → install scroll → machine chip appears |
| Compute is fungible, state isn't | Same task, same board, second machine |
| Attention is the scarce resource | Exactly one yellow thing on screen in every shell shot |

## Lines held in reserve (Q&A, not narration)

- *Why not build on the APIs?* We'd own the agent loop and inherit the maintenance of every
  vendor's feature surface. Running the binaries means their roadmap is our roadmap. The cost is
  ours: PTY resurrection, scrollback, and extracting structured state out of an ANSI stream.
- *What's actually hard here?* Not the UI. It's session state that survives a process, a machine,
  and a model change — and staying correct when ten agents touch one repo.
- *Why won't the vendors just do this?* Each of them ships one agent well. Nobody is incentivized to
  make their agent a peer of a competitor's on the same board.
- *Where does it break today?* Cross-harness handoff is scripted, not a menu action. Machine handoff
  is behind a feature flag. Say so if asked — the flow is real, the affordances aren't all built.

## Delivery notes

- Pre-record and time-compress the VPS install. The scroll is the shot; the wait is not.
- Keep one agent visibly *working* (braille spinner + mono timer) in every shell shot. That's the
  proof of life, and it's the only perpetual motion in the product.
- Make the memory pressure visibly bad before cutting to Beat 3 — Beat 2's ending sells Beat 3.
- The Beat 5 yellow line is a falsifiable claim about the screen. Ship the Signal-Rule de-amber fix
  (tray glyphs, "ago" stamps, feed pointers) before filming or cut the line.
- Beat 4's cross-model handoff has no UI — drive it from the superagent or CLI. Don't mime a menu
  that doesn't exist.
- If over time: drop the mobile parenthetical first, then Beat 2's last sentence. Never drop the
  Podium-CLI beat — it's the one thing no one else in this category is doing.
