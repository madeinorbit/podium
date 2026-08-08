# POD-609 — what the native AskUserQuestion menu actually takes

Podium answers an agent's question by typing into the live Claude Code menu, so the
payload it types IS the feature. The reading in the issue came from the minified
bundle; this is the check that it holds in a real terminal, because the failure it
describes is silent — the agent just keeps waiting.

**Method.** A throwaway `claude --model sonnet` was spawned in a PTY the driver owns
(python `pty.openpty` + a small ANSI screen model, so the assertions read the SCREEN,
not the redraw stream), prompted to call `AskUserQuestion` and nothing else. Bytes
were then written to the PTY exactly the way the server writes them. Build under
test: **2.1.226**.

---

## 1. Unpaced digits are not "mostly fine" — they do nothing

A two-question ask, both digits in ONE write (`"11"`, what back-to-back `sendInput`
calls coalesce into):

```
←  ☐ Color  ☐ Size  ✔ Submit  →       ← 2.5s after the write: unchanged
Pick a color
❯ 1. Red
  2. Blue
```

Neither question was answered and the dialog did not advance. The CLI's key parser
folds a multi-character chunk into a SINGLE key event whose name is the whole string,
so `"11"` arrives as the key `"11"`, matches no digit, and is dropped. The old
comma payload (`"1,3\r"`) died the same way: `"1,3"` was one dead key, and only the
trailing CR was real — which then toggled whatever row happened to be focused.

**One keystroke per PTY write.** The driver used 150ms; the shipped script uses 120ms,
comfortably above the parser's own 50ms byte-run window.

## 2. Paced digits land — and stop on a step nobody was pressing

Same ask, `1` … 150ms … `1`:

```
←  ☒ Color  ☒ Size  ✔ Submit  →
Review your answers
 ● Pick a color   → Red
 ● Pick a size    → Small

Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
```

Both questions were answered and the dialog sat here, agent still blocked. **This is
the bug.** A single CR (the focused row is "Submit answers") committed it:

```
● User answered Claude's questions:
  ⎿  · Pick a color → Red
     · Pick a size → Small
```

## 3. A multi-select does not advance on its own — Tab moves off it

One `multiSelect` question, `1` … `3`:

```
Pick fruits
❯ 1. [✔] Apple
  2. [ ] Banana
  3. [✔] Cherry
  4. [ ] Type something
     Submit
```

The digits toggle boxes and nothing advances. **One Tab** moves to the next tab —
and past the last question that tab IS the review step:

```
Review your answers
 ● Pick fruits   → Apple, Cherry
Ready to submit your answers?
❯ 1. Submit answers
```

Then CR submits. Extra Tabs are harmless (the tab index clamps at Submit), but one
is enough.

## 4. The mixed shape, end to end

Two questions, Q1 multi-select, Q2 single-select — `1`, `2`, `Tab`, `1`, `CR`:

```
←  ☒ Fruit  ☒ Size  ✔ Submit  →
Review your answers
 ● Pick fruits    → Apple, Banana
 ● Pick a size    → Small
```

…and the CR delivered `Pick fruits → Apple, Banana / Pick a size → Small`.

## 5. Free text rides the same script (POD-599's path, on a multi-question ask)

Two questions, Q1 answered through the native Other row — `3`, `podium typed this`,
`CR`, then `1` for Q2, then the confirm `CR`. This is the exact byte script the
server now emits, and it is worth showing because the text is written as ONE
multi-character chunk: the parser still folds it into a single key event, but a
focused text field inserts that sequence, so it lands as the custom answer.

```
←  ☒ Color  ☒ Size  ✔ Submit  →
Review your answers
 ● Pick a color   → podium typed this
 ● Pick a size    → Small
```

```
● User answered Claude's questions:
  ⎿  · Pick a color → podium typed this
     · Pick a size → Small
```

Note what the free-text CR does on a MULTI-question ask: it commits the field and
advances — it does not submit the dialog. The closing confirm is still owed.

---

## The contract that came out of it

Per question, in order, one keystroke per write:

| question shape | keystrokes |
| --- | --- |
| single-select | the digit — it selects AND advances |
| multi-select | one digit per pick (toggles), then `Tab` to leave the question |
| answered as free text | the Other digit (`optionCount + 1`), the text, `CR` — plus the `Tab` if the question is multi-select |

then, once every question is answered:

| ask shape | closing keystroke |
| --- | --- |
| a LONE single-select question | none — it auto-submitted on the digit |
| anything else | `CR` on "Ready to submit your answers?" |

The asymmetry in that second table is why the closing CR is conditional: on the lone
single-select path the dialog is already gone, and a blind CR would land in the
composer instead.

Encoded in `apps/server/src/modules/sessions/inbox.ts` (`answerAskUserQuestion`),
pinned in `apps/server/src/modules/sessions/oracle-commands.test.ts`, and written up
for other harness work in `docs/agent-harness-reference/claude.md` §6.

**Why the shape rides with the answer.** The server cannot infer "multi-select" from
the indices when only one option was picked, and guessing wrong strands the ask on
that question — so the cards send `multiSelect` with each choice
(`AskAnswerChoice`). Several picks still imply it, which keeps an older client
working.
