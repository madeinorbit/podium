# Shared session control identity (POD-1081)

**Status:** decided for implementation · **Phase 5 / POD-292 child** · **2026-08-02**

Governing sources: `docs/multi-user-readiness.md` §2 (session control substrate), §4 note 2
(concurrent PTY input is a control problem), §5 Phase 5 row; ADR 9 D5 (agent delegation +
attribution pair); ADR 3 Amendment 1 (principal from transport, apply-time re-auth); ADR 7
Amendment 1 D12 (presence vs session-control facts).

This document records the product decisions this issue must make explicitly. Cursor/selection UI
is Phase 6 (POD-293). Concurrent text editing is not in scope (ADR 1 `op-stream` carve-out).

---

## 1. Identity on `controllerId`

`controllerId` remains a **websocket connection id** (device/binding). It is not a person and is
not rebranded as a user id. Identity rides beside it:

| Field | Layer | Meaning |
|---|---|---|
| `controllerId` | connection | Which socket may send controller-gated frames |
| `controllerIdentity` | principal | WHO is driving — user, or agent + on-behalf-of |

`controllerIdentity` is a `PresenceIdentity`:

- `{ kind: 'user', user }` — a human holds control
- `{ kind: 'agent', agentIdentity, onBehalfOf }` — an agent holds control for its human

Stamped **only** from the authenticated transport principal (ADR 3 D7). Payload display names are
inert. Broadcast on existing frames — `attached` and `controllerChanged` — not a parallel event.

An agent holding control is the **normal case**, not an edge: when no human connection holds
control, `controllerIdentity` resolves to the session's agent principal
`(agentIdentity, onBehalfOf)` from SessionBinding / owner. Rights are always the agent's scope
intersected with its human's **current** rights (ADR 9 D5 A1), resolved live at every apply.

---

## 2. PTY input attribution — live vs durable

**Decision: LIVE server state for keystroke-level PTY input. Durable rows for intentional sends.**

Attribution that lives only in an unstructured log is not attribution. The property is: the
server can answer "who produced this input?" from **its own state**, stamped from the transport
principal (ADR 3 D7), never from a frame payload.

| Path | Where the answer is stored | Why |
|---|---|---|
| Raw PTY keystrokes (`input` frames from the controller socket) | **Live server state** — `SessionTerminal.lastInputAttribution` (queryable while the session is live); also stamped on the daemon-bound `input` frame for the hop | Watchers need "human or agent right now". Per-keystroke durable history is not built (volume). Survives client reattach; blank after server restart (same class as presence) |
| Inbox / chat / answer / queued sends | **Durable** — `QueuedInboxMessage.principal` (delegation reference + attribution pair) | Intentional turns; product already depends on "did a person or an agent ask this?" (`humanQuestionAskedBy`) |

`lastInputAttribution` is the model pair `{ actor, onBehalfOf }`. Client frames may carry an
`attribution` field; the attach path **never threads it** — `client-control` passes only
`data`, and `SessionInbox` stamps from `ClientPrincipal`.

---

## 3. Take-control policy

Today: first attacher wins; `requestControl` transfers immediately; disconnect reassigns to the
next attached client. That shape is preserved and given identity + rights checks.

### Who may drive (take control)

| Principal | Drive? |
|---|---|
| Session owner | Always |
| Grantee with `write` or `manage` on the session (or parent issue, when ownership inherits) | Yes |
| Grantee with only `read` | No — watch only |
| Instance `admin` | Yes — break-glass fleet intervention (decided here; not ambient for members) |
| Agent | Yes, within its scope ∩ human's **current** rights; never wider than its human |

### Who may watch (attach / spectate)

Owner, any grantee with `read`|`write`|`manage`, and admins — subject also to machine `use` (below).

### Machine use is independent of session sharing

Attach (and therefore watch **and** drive over a PTY) also requires machine **`use`**
(ADR 9 D6 M1). Session share alone must not become a back door to code execution. Both checks
apply; denied attach fails closed as `terminalOutcome: unauthorized` (same shape as a session the
principal cannot see — no existence oracle).

### Request vs preemption

**Preemption.** `requestControl` transfers immediately; the current controller cannot refuse.
Rationale: (1) matches shipped behaviour and last-foregrounded-wins clients; (2) a refuse/accept
UX is Phase 6 presence UI, not this issue; (3) terminal input is not collaborative text — two
drivers is always wrong, so the product answer is exclusive control with an explicit handoff,
not a negotiation protocol.

**Race between two authorized claimants.** Last successful apply wins. Each transfer broadcasts
`controllerChanged` with the new `controllerId` + `controllerIdentity`, so the previous driver
**observes** the loss — a silent takeover is rejected as worse than a refused one. Unauthorized
claimants get `terminalOutcome: unauthorized` and the current controller is unchanged.

**Today's single-operator degradation.** One shared credential resolves every human to the first
admin. Owner checks and grants are live but every connection is the same person; machine `use`
holds for that owner. Behaviour matches pre-multi-user first-attacher / requestControl, with
identity now stamped (always the same user).

### Idle and disconnect

| Event | Behaviour |
|---|---|
| Controller **disconnects** | Control reassigns to the next attached client that **may drive**; else `controllerId = null` and identity falls back to the agent principal when one exists |
| Controller **idle** | No automatic reclaim. No reaper. Matches "revoke is live at apply, never a background sweeper" (ADR 9 D5 A1) |
| Human access **revoked** while their agent holds control | Cleared at the agent's **next apply** (input / requestControl / inbox send). No reaper |

### Broadcast

Preserve `controllerChanged` as the sole transfer event. Payload:

```
{ type: 'controllerChanged', sessionId, controllerId, controllerIdentity, geometry }
```

---

## 4. Occupancy and `clientCount`

Who is watching is **per-room presence** (POD-1078 / stream plane). This issue does not build a
second occupancy mechanism.

`clientCount` on `SessionMeta` remains a **session-control fact** (ADR 7 D12 — it is not presence
state and does not become a durable presence row). Its **source** is room occupancy:

```
clientCount = occupancy({ kind: 'session', id }).length
```

Occupancy is **per principal** (ADR 7 D9.4): two tabs of the same user are one member. That is a
deliberate semantic shift from the old attach-set size (which counted connections).

**PTY attach auto-joins the session room** (and detach leaves it), so watching a terminal and room
membership stay one mechanism. Clients may still `presenceSubscribe` for cursor payloads; join is
idempotent.

When a presence port is unavailable (unit tests without the stream plane), the attach-set size is
the fallback so existing incident behaviour stays observable. Production composition always injects
the presence port.

Attached PTY clients (`SessionTerminal.clients`) still exist for frame delivery and controller
gating; they are not a second "who is here" product surface.

---

## 5. What is deliberately unchanged

- Controller gating on PTY sends (only `controllerId` may type)
- Queued-send semantics on the inbox path
- Spectator join (attach without control when another controller exists)
- Epoch/seq resync on reconnect (`sinceSeq` / `resumed`)
- Chat/inbox routing around controller gating (explicit user acts, not competing keyboards)

---

## 6. Acceptance map

| Criterion | Mechanism |
|---|---|
| controllerId resolves to a principal | `controllerIdentity` on `attached` / `controllerChanged` |
| PTY input attributed; live vs durable decided | §2; `lastInputAttribution` live; inbox rows durable |
| Take-control policy documented + implemented | §3; `session-control-policy.ts` |
| Attach/watch visibility-gated; machine use independent | attach path + `terminalOutcome` |
| Occupancy from presence rooms; clientCount derived | §4 |
| Revoke human → agent loses control at next apply | policy re-check on apply; no reaper |
| Existing gating / queue / spectator / reconnect | unchanged under existing chaos/ledger tests |
