# POD-770 — the AskUserQuestion dialog has a SECOND layout, and it eats the classic script

The operator typed a custom answer into a two-option question in the web chat and
pressed Enter. The agent received **option 1**, with option 1's preview quoted back,
and no free text. Nothing anywhere reported a failure.

POD-609 characterized the native menu and pinned the script the server types. It
characterized **one** dialog. This is the other one.

**Method.** Same as POD-609: a throwaway `claude --model sonnet` in a PTY the driver
owns, an `@xterm/headless` screen model so assertions read the SCREEN rather than the
redraw stream, and bytes written exactly the way the server writes them. Build under
test: **2.1.228**. The layout switch was first read out of the bundle, then confirmed
on screen; the fixed scripts were then replayed **through `SessionInbox` itself**, so
what ran against the CLI is the server's own keystroke plan, not a retyped guess.

---

## 1. When previews are present, it is not a list

Ask for one single-select question whose options carry `preview` text:

```
 ☐ Approach
Pick an approach
❯ 1. Alpha                        ┌──────────────────────────────────────────┐
  2. Beta                         │ PREVIEW-ALPHA-MARKER                     │
                                  └──────────────────────────────────────────┘
                                  Notes: press n to add notes
────────────────────────────────────────────────────────────────────────────────
  Chat about this
Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
```

Options in a narrow left column, the focused option's preview on the right, a
**Notes** field under it, and a "Chat about this" row. **There is no Other row.**
The CLI reaches for this layout when `!multiSelect && options.some(o => o.preview)`.

Note what the footer does NOT list: digits. They are handled, but not as selection.

## 2. The classic free-text script commits option 1

The server's script for a typed answer was `otherIndex` (= 3 here), the text, `CR`:

```
● User answered Claude's questions:
  ⎿  · Pick an approach → Alpha
```

`PODIUM-CUSTOM-ANSWER` appears nowhere. Each keystroke fails on its own:

- **`3` is dropped.** The handler bounds-checks `digit - 1 < options.length` and
  ignores anything past the end. It also `preventDefault`s first, so the key is
  consumed either way.
- **The text is one dead key event.** As in POD-609, a multi-character chunk folds
  into a single key event whose name is the whole string — and with no focused text
  field to insert it, it matches nothing.
- **The `CR` selects the highlighted row**, which is still the first one.

That is the whole bug: the recommended option is deliberately listed first, so the
substitution lands on exactly the answer the operator was declining to give.

## 3. A plain option answer hangs instead

Same layout, the server's option script — a bare digit `2`, no CR:

```
  1. Alpha                        ┌──────────────────────────────────────────┐
❯ 2. Beta                         │ PREVIEW-BETA-MARKER                      │
```

The highlight moved and **nothing else happened**. In this layout a digit is a
cursor move, not a selection; the dialog stays up and the agent stays blocked. A
second, quieter failure hiding behind the first.

## 4. The scripts that work

`2` … `CR`:

```
● User answered Claude's questions:
  ⎿  · Pick an approach → Beta
```

`n` … `PODIUM-CUSTOM-ANSWER` … `CR`:

```
● User answered Claude's questions:
  ⎿  · Pick an approach → (notes only)
```

…and the agent's next turn quotes the text back verbatim. `n` opens the Notes
field; its Enter answers with the typed text and no option selected. Both were
replayed from `SessionInbox`'s own plan (`["2","\r"]` and
`["n","PODIUM-CUSTOM-ANSWER","\r"]`) at the inbox's own 120ms spacing.

The lone-question auto-submit from POD-609 still holds here — the CR that selects
is also the one that submits — so the closing confirm stays conditional exactly as
it was.

---

## The contract that came out of it

Per question, one keystroke per write, now keyed on which dialog is up:

| question shape | option answer | free-text answer |
| --- | --- | --- |
| single-select, no previews | the digit | Other digit (`optionCount + 1`), text, `CR` |
| single-select, ANY option has `preview` | the digit, then `CR` | `n`, text, `CR` |
| multi-select (never previews) | one digit per pick, then `Tab` | Other digit, text, `CR`, then `Tab` |

then, once every question is answered, the closing keystroke is unchanged: none for
a lone single-select, `CR` on "Ready to submit your answers?" for everything else.

**Why the layout rides with the answer.** The server never sees the dialog, and the
two layouts are indistinguishable from the indices alone — the same reason
`multiSelect` already travels. The cards derive it with `isPreviewLayout()` in
`packages/client-core/src/viewmodels/ask-question.ts` and send `previewLayout` on
the choice.

**And why an unanswerable choice is now a refusal.** The old loop `continue`d past a
choice it could not express and kept typing the rest. On a multi-question ask that
leaves the skipped question sitting on its first row for the closing CR to commit —
the same silent substitution, one layer up. `answerAskUserQuestion` now validates
every choice before a single byte moves and returns `{ok:false, reason}`, and the
cards surface it as "not delivered — choose again" instead of settling into "sent".

Encoded in `apps/server/src/modules/sessions/inbox.ts` (`answerAskUserQuestion`),
pinned in `apps/server/src/modules/sessions/oracle-commands.test.ts` and
`inbox.test.ts`, and written up in `docs/agent-harness-reference/claude.md` §6.
