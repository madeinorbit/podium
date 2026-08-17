# POD-1171 — the harness's file re-attachments were rendering as the operator's turn

## What the operator saw

Two right-aligned "You" bubbles, each holding nothing but a file chip, timestamped 00:44:

```
┌──────────────────────────┐
│  📄 ActivationShell.tsx  │   ← reads as: the human sent me this file
└──────────────────────────┘
┌──────────────────────────────────┐
│  📄 ExistingPodiumActivation.tsx │
└──────────────────────────────────┘
```

Nobody sent anything. From the transcript that produced that screenshot
(`issue-1157-sub-floor-type-in-three-setup-surfaces`, 22:44Z = 00:44 local):

```
150 assistant   22:44:26  tool_use:Bash          ← the AGENT ran a command
152 user        22:44:28  tool_result
154 attachment  22:44:28  edited_text_file  …/setup/ActivationShell.tsx
155 attachment  22:44:28  edited_text_file  …/setup/ExistingPodiumActivation.tsx
```

The Bash call rewrote both files; Claude Code noticed and re-attached them so its
context would not be stale. Its own UI shows nothing for these records.

## Why the chat drew a prompt

`packages/transcript/src/claude.ts` mapped three file-bearing `attachment`
subtypes to `role: 'user'` items. `ChatBlockView` renders any user item as the
operator's engraved right-aligned card — with no text left, all that survives is
the chip. Census of `attachment` subtypes across every transcript on this host:

| subtype | records | what it actually is |
| --- | --- | --- |
| `edited_text_file` | 1157 | file whose bytes changed on disk after a tool call |
| `file` | 34 | a path in the composer (`@mention`) — genuinely the operator's |
| `compact_file_reference` | 31 | path carried across a compaction seam |

The parser already makes exactly this call one branch down: string-content turns
tagged `promptSource: 'system'` are dropped *"rather than render a misleading
'You' bubble"*. The attachment branch never got the same treatment.

A second defect kept `file` wrong even where it belonged to the operator. The
media-marker fold in `packages/client-core/src/viewmodels/chat.ts` accepted only
`kind: 'image'` tags, so an `@mention` stood alone as its own bubble instead of
riding inside the prompt that named it.

## The fix

- Only `file` survives the parser. `edited_text_file` and
  `compact_file_reference` yield no items. Their paths need no allow-listing
  either — the `tool_use` that touched the file already contributed it
  (`knownPathsFor`).
- The fold accepts file tags alongside image tags, so an `@mention` renders as a
  chip inside its prompt.
- With no prompt to fold into, an image still earns its own row — someone
  uploaded a picture and wants to see it — but a marker that is nothing but file
  chips is dropped rather than left standing alone.

## Verification

Both code paths replayed over every Claude transcript on this host (376 files
carrying `attachment` records), pre-fix sources against post-fix sources:

```
ghost file bubbles   before 1272  ->  after 0
user blocks total    before 2825  ->  after 1553      (delta 1272 — only the ghosts)
prompts now carrying a folded file chip: 13
```

The `user blocks` delta equals the ghost count exactly: no real operator turn was
lost. On the screenshot's own transcript, 4 → 0, the first two being
`ActivationShell.tsx` and `ExistingPodiumActivation.tsx`.

Fixtures: `packages/transcript/src/claude.test.ts` covers each subtype (`file`
kept, the other two dropped, no-filename and non-file subtypes dropped) and the
duplicate-id guard; `apps/web/src/features/chat/chat.test.ts` covers the file
fold, a mixed image+file fold, the drop with no prompt to fold into, the
unchanged tag-less fallback, and that a marker never folds into an interrupt.

## Left alone

Slash-command records (`<command-name>/compact</command-name>`,
`<local-command-stdout>…`) carry neither `isMeta` nor `promptSource`, so they
still render as operator prompts. That is a separate defect — filed as POD-1195,
with a `discovered-from` edge back here. It matters to this change only because
at a `/compact` seam those bogus bubbles are what a restored `file` chip folds
into.
