# POD-187 — demo script

Target length **~4:00**. Rig = local demo host on `:18788`, second macOS app, container
"VPS". Everything below is matched to what this rig can actually do.

Thesis (the thing the other draft missed): **you don't start agents, you get work done.**
The task is the unit. Agents are just who's on it right now. Every beat serves that.

---

## 1. Narrator plan — click path + word points

### Beat 1 · The board (0:00–0:30)

**Screen** Podium, sidebar full, one row yellow. Don't touch anything.

- Ten agents running, one screen
- Shows *work*, not agents
- "I never think: start an agent"
- Task = unit. Agent = who's on it now

### Beat 2 · Orientation (0:30–1:05)

**Click** hover sidebar → click **MER-2** → point at right rail → point at a terminal pane.

- Left = everything in flight
- **Yellow = needs me.** The one rule. Nothing else may use it
- Middle = *real* terminals — Claude Code / Codex / Grok binaries in a PTY
- We didn't rebuild the agent loop → hooks, permissions, MCP, subagents work day one
- Right = the task: purpose, branch, diff, shell in its worktree

### Beat 3 · One ask, three agents (1:05–2:00)

**Click** New agent → **Codex** → repo **meridian-web**.
**Type** (copy-paste ready):

```
Add a CSV export button to the Reports page. The API already serves it at
GET /export?report=<id>. File it as a task, put Grok on the implementation in
its own worktree, and have Claude review it before anything merges.
```

Backups if that flops on camera — both are untouched on `main` with no work
committed on their branches, so an agent starts genuinely from zero:

```
/search returns every match (MRD-5) — the dashboard is pulling 4k rows on a
two-character query. Make it cursor-based, 25 per page.
```
```
Every empty state in the dashboard just says "No data" (MER-3). Give them some
life — an illustration and a useful next action per surface.
```

Do NOT reuse **MER-2** or **MRD-1** as prompts: both already carry committed work on
their branches (MER-2 is the review-card showcase, MRD-1 the content-flow one), so
asking an agent to redo them reads as incoherent on camera. `main` itself is
untouched in both repos, which is why the CSV-export prompt above still works.

- Every agent gets the **Podium CLI** in its system prompt
- Not just code: files tasks, spawns agents, messages them, drives all of Podium
- Watch: filed the task → Grok implementing on its own worktree → Claude queued behind to review
- They coordinate over agent mail + an **advisory** merge lock
- Advisory, no enforcement — both are agents I prompted. Turns out that's enough

### Beat 4 · Out of RAM (2:00–2:15)

**Screen** memory chip in header climbing → hover it.

- Three native agents and a build
- Out of memory
- "This is where every agent setup stops scaling"

### Beat 5 · Add a machine (2:15–3:00)

**Click** Settings → **Machines** → **Add machine** → **Copy command**.
**Switch** to the VPS terminal (window already open, prompt reads `root@podium-vps`).
**Paste** → let it scroll (time-compress in the edit).
**Switch** back → Settings → Machines: second machine now listed.

- One command
- Installs Podium → dials home → installs Claude Code, Codex, Grok → **moves my logins across**
- Credential migration = the unglamorous part. Every CLI stores auth somewhere different, none expect provisioning
- That's the difference between one paste and an afternoon
- Second machine, same board. State lives in Podium → machines are just compute

### Beat 6 · Handoff to the other machine (3:00–3:30)

**Right-click** the task from Beat 3 (or its Codex session) → **Handoff** → pick **podium-vps**.
Watch the departure/arrival animation, then the row goes quiet locally.

- Move the work that was choking the laptop
- Branch + worktree + the agent's context go with it
- It picks up over there. My laptop goes quiet

### Beat 7 · Handoff across models (3:30–3:50)

**Right-click** the same task → **Assign agent** → **Codex**.

- Same move, different axis: Claude planned it, Codex implements
- Doesn't re-read the repo — the task carries the context
- Both work for one reason: **the task owns the branch. Sessions never do**

### Beat 8 · Close (3:50–4:05)

**Screen** back to the board, wide. Let it sit. Don't click anything.

- Ten agents ≈ a decision a minute arriving at you
- So the interface has one job: tell me which one needs me
- "That's Podium."

---

## 2. Full narration

> **[Beat 1 — the board]**
>
> This is Podium. I've got about ten coding agents running right now, and this is the only
> screen I look at. Not because it shows me agents — it shows me work. I never think
> "start an agent." I think "this needs to get done." The task is the unit here. The agent
> is just whoever's on it right now.
>
> **[Beat 2 — orientation]**
>
> On the left, everything in flight. Yellow means it needs me — that's the one rule in this
> product, and nothing else is allowed to use that colour.
>
> In the middle, real terminals. That is actually Claude Code, Codex and Grok — the real
> binaries, in a PTY. Most platforms reimplement the agent loop against the model API. We
> don't. So hooks, permission modes, MCP and subagents work here on day one, and we never
> chase a CLI release.
>
> On the right, the task itself: what it's for, its branch, the diff, and a shell sitting in
> its worktree.
>
> **[Beat 3 — one ask, three agents]**
>
> So — let's get something done. New agent, Codex.
>
> *"Add CSV export to the reports page. Have Grok implement it on its own worktree, and put
> Claude on review before anything merges."*
>
> Every agent here gets the Podium CLI in its system prompt. So it doesn't only write code —
> it can file tasks, spawn other agents, message them, and drive the rest of Podium.
>
> And there it goes: it filed the task, put Grok on the implementation in its own worktree,
> and queued Claude behind it to review. They coordinate over agent-to-agent mail and take an
> advisory lock on the merge. Advisory — no enforcement — because both sides are agents I
> prompted. That turns out to be enough.
>
> **[Beat 4 — out of RAM]**
>
> And now my laptop is the bottleneck. Three native agents and a build, and I'm out of memory.
> This is the point where every agent setup stops scaling.
>
> **[Beat 5 — add a machine]**
>
> So I add hardware. Settings, machines, add machine. It gives me one command.
>
> That installs Podium on the box, dials home to my instance, installs Claude Code, Codex and
> Grok, and moves my logins across. That last part is the unglamorous one: every agent CLI
> keeps its auth somewhere different, and none of them expect to be provisioned. It's the
> difference between one paste and an afternoon.
>
> Done. Second machine, same board. The state lives in Podium, so machines are just compute.
>
> **[Beat 6 — handoff]**
>
> Now I move the work that was choking my laptop. Right-click, hand off, pick the machine.
> The branch, the worktree and the agent's context go with it. It carries on over there, and
> my laptop goes quiet.
>
> **[Beat 7 — across models]**
>
> Same move on a different axis. Claude planned this one — I'll let Codex implement it. It
> doesn't start by re-reading the repo, because the task carries the context.
>
> Both of those are a single operation for the same reason: the task owns the branch.
> Sessions never do.
>
> **[Beat 8 — close]**
>
> Ten agents is roughly a decision a minute arriving at you. Which is why the whole interface
> has exactly one job: tell me which one needs me.
>
> That's Podium.

---

## 3. Prep list

### Windows to have open (in this z-order)

1. **Podium demo app** (macOS, isolated HOME) — full screen, sidebar showing meridian-web +
   meridian-api, at least one yellow row. Superade theme.
2. **VPS terminal** — its own window, prompt reading `root@podium-vps`, big font, cleared.
3. **Settings → Machines** — pre-navigated in a second Podium tab/window so Beat 5 is one click.
4. **Phone** (mobile app, same board, logged in) for Beat 8 — separate capture.

### Rig state

- Demo host up on `:18788` (state `~/.podium-demo`, edge, bound `0.0.0.0`).
- Demo app running under `HOME=/Users/till/.podium-demo-home` with `PODIUM_ALLOW_MULTI=1`.
- Machines list = **only** `MBP-Cofo.local` before the take.
- Feature flags on (Settings → Experimental): **Session handoff** ✅ (already enabled),
  optionally **Git panel** (needed if you point at the diff in Beat 2) and
  **Messages panel** (needed if you want to show agent mail in Beat 3).

### Container "VPS"

```bash
docker run -d --name podium-vps --hostname podium-vps \
  -p 2222:22 debian:bookworm-slim sleep infinity
docker exec -it podium-vps bash -lc \
  'apt-get update && apt-get install -y curl ca-certificates git openssh-server && \
   mkdir -p /run/sshd && echo "root:podium" | chpasswd && \
   sed -i "s/^#\?PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config && \
   /usr/sbin/sshd'
```

On camera use `ssh root@localhost -p 2222` (prompt reads `root@podium-vps`) rather than
`docker exec` — `docker exec` gives away that it's a container.

Pre-pull `debian:bookworm-slim` before the take so the paste isn't waiting on a download.

### Reset between takes

```bash
docker rm -f podium-vps          # then re-run the two commands above
```
…and revoke the machine in Settings → Machines so the list is clean again.
