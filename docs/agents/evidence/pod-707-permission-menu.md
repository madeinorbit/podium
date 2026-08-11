# POD-707 — what the native permission menu actually offers

Podium wants to let a person approve or deny a harness permission ask from the web
chat instead of the terminal. Answering means typing into the live Claude Code
menu, so — exactly as in [POD-609](./pod-609-ask-menu-drive.md) — the payload it
types IS the feature. This is the static half of that work: what the shipped
bundle says the payload and the menu contain. Build read: **2.1.226**
(`~/.local/share/claude/versions/2.1.226`).

The empirical half (driving a real menu in a PTY) is **not done** — see §5.

---

## 1. The hook payload carries the subject; Podium was dropping it

The `PermissionRequest` input schema, read off the bundle's validator:

```js
uqE = Ee(() => nx().and(Se({
  hook_event_name: xt("PermissionRequest"),
  tool_name: $(),
  tool_input: po(),
  permission_suggestions: dt(J7n()).optional(),
})))
```

`nx()` is the base every hook shares:

```js
nx = Ee(() => Se({
  session_id: $(), transcript_path: $(), cwd: $(),
  prompt_id: $().optional(), permission_mode: $().optional(), agent_id: …
}))
```

So the ask arrives with **`tool_input` in full**. `translateClaudeHookPayload` kept
only `tool_name` (as `AgentNeed.summary`) and discarded the rest, which is the
whole reason the chat could say no more than "needs permission".

`permission_suggestions` is a discriminated union of **rule mutations**, not
user-facing labels:

```js
J7n = fA("type", [
  { type: "addRules",    rules: […], behavior, destination },
  { type: "replaceRules", … }, { type: "removeRules", … },
  { type: "setMode", mode, destination },
  { type: "addDirectories", … }, { type: "removeDirectories", … },
])
```

These are what the menu's "yes, and don't ask again" rows commit. Their presence
is reportable; their menu position is not (§3).

## 2. The `Notification` fallback carries nothing usable

Podium also subscribes `Notification` with `matcher: "permission_prompt"`. That
payload carries a rendered `message` string, not the tool call. It can say a
permission is pending; it cannot say what of. Any card built on the subject must
degrade when this is the only channel that fired.

## 3. The menu's option list is variable — ordinals are not addressable

The permission dialog builds its options as an array **seeded with the accept-once
row, then conditionally pushed, then closed with the reject row**:

```js
let Q5l = [HCE];                       // HCE = { label:"Yes", value:"yes", … }
if (Ych) Q5l.push({ …, value:"yes-exact"  })
if (Xch) Q5l.push({ …, value:"yes-prefix" })
RCE = (Q5l.push({ label:"No", value:"no", feedbackConfig:{ type:"reject" } }), Q5l)
```

Observed `value` slugs across the permission dialogs: `yes`, `yes-exact`,
`yes-prefix`, `yes-always`, `yes-dont-ask-again`, `yes-dont-ask-again-domain`,
`yes-enable-auto-mode`, `toggle` (View raw script / View workflow summary), `no`.

Which rows exist depends on the tool and the rule that matched — a Bash ask can
offer exact-command and prefix rules, a network ask offers a domain rule, a skill
ask offers neither. **So "No" is index 2, 3, 4 or 5 depending on the ask**, and a
digit that denies one prompt approves-and-persists another.

> This is the finding that shapes the feature: Podium must not offer a
> "don't ask again" button, and must not deny by digit. A card that mislabels
> which key means "no" is worse than no card.

## 4. Two keys are structurally stable — one of them with a caveat

- **Esc → reject.** The reject row is rendered `No, and tell Claude what to do
  differently (esc)`, and the dialogs wire `onCancel: () => _t("no")`. This
  matches the Esc that already backs AskUserQuestion's skip.
- **`1` → the accept-once row.** The array is *seeded* with the `value:"yes"`
  entry at every permission call site read, so position 1 is the plain yes.

  **Caveat, unresolved statically.** Under `yesInputMode` the first entry is not a
  plain row but a text field:

  ```js
  if (o) u.push({ type:"input", label:"Yes", value:"yes",
                  placeholder:"and tell Claude what to do next",
                  allowEmptySubmitToCancel: !0 })
  ```

  `yesInputMode` defaults to `!1` at all three component definitions but is passed
  a live variable at all three call sites, so it cannot be ruled out by reading.
  If it is ever on for an ordinary tool ask, a blind `1` focuses a field instead of
  approving — and a following empty CR would *cancel* (`allowEmptySubmitToCancel`).
  That is the silent-no-op failure class POD-609 exists to prevent.

## 5. What is still owed

POD-609's lesson was that the bundle read is necessary and not sufficient: unpaced
digits looked obviously fine and did nothing. The same standard applies here, and
the following is **not yet verified against a real menu**:

1. Does `1` approve an ordinary Bash ask, or can it land in a `yesInputMode` field?
2. Does Esc reject cleanly, and what does the agent receive as the rejection?
3. Does the reject path need a settle delay before the next input, as the ask menu's
   confirm does (`MENU_CONFIRM_DELAY_MS`)?

Until those are answered in a PTY the way POD-609 was, the answer path stays
unshipped; the subject-carrying half of this issue (§1) does not depend on them.
