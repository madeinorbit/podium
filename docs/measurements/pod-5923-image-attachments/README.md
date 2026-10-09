# How programs record a typed image attachment (POD-5923)

Measured on 2026-10-09 on flatblock, before the matcher was changed. **Every
Claude Code image send failed proof on all three measured versions.** Claude
keeps the text byte for byte, but it records each typed image path as an image.
Podium's reader then removed trailing spaces from the text. Codex and Grok
failed only when the message was nothing but image paths.

## Method

[`measure.ts`](measure.ts) types each case through Podium's production typing
path. It builds the text as the terminal driver's `send()` does: each attachment
path on its own line, ahead of the text. It then sends the text through
`createTerminalInjection`, using a bracketed paste and the 90 ms CR, into a real
CLI process in the production Bun PTY backend. The attachments are real files
under `<scratch HOME>/.podium/uploads/<uuid>/`: two PNGs (32×24, 24×32) and a
`.txt` file.

Every run uses a new scratch HOME. The environment is a credential-free
allowlist. Claude gets a visibly fake API key. The model is
[`fake-model-server.ts`](fake-model-server.ts) on `127.0.0.1:45923`. It sends a
fixed reply, and holds the reply for 8 s when a prompt contains `SLOWSETUP`, so
that the next case is typed while the program is busy. Each run first refuses an
occupied port. The run then stops its recorded CLI PID and any process whose
command line names its unique scratch directory. Codex 0.162.0 leaves behind a
managed app-server daemon copied into `CODEX_HOME`. The fake is stopped by
**port** after checking that it owns the port. Claude's paste-wrapper gate
(`tengu_virtual_pancake`) is on, which was the live session's form
([POD-4982](../pod-4982-claude-pasted-content/README.md)).

| Program | Binary sha256 (prefix) | Run file |
|---|---|---|
| Claude Code 2.1.283 | `1859583ce3292059` | [claude-2.1.283.run.json](claude-2.1.283.run.json) |
| Claude Code 2.1.286 | `fe503f65c6289d59` | [claude-2.1.286.run.json](claude-2.1.286.run.json) |
| Claude Code 2.1.295 | `4503bfe11a6c7fcc` | [claude-2.1.295.run.json](claude-2.1.295.run.json) |
| Codex 0.162.0 | `50ed828f357c655a` | [codex-0.162.0.run.json](codex-0.162.0.run.json) |
| Grok 1.0.46 | `41626a5329232414` | [grok-1.0.46.run.json](grok-1.0.46.run.json) |

Claude 2.1.283 and 2.1.286 are the official release binaries. Their checksums
match each release manifest. Each `<label>.jsonl` holds every native record
written for each case. Image data longer than 512 characters is replaced by its
size and digest. All text is synthetic.

## What each program records

`P` means a typed image path, and `T` means a typed `.txt` path.

| Typed (`paths…\ntext`) | Claude 2.1.283 / 2.1.286 / 2.1.295 | Codex 0.162.0 | Grok 1.0.46 |
|---|---|---|---|
| `P\ntext` | `[Image #1]text` + image block; path in a separate `isMeta` record, same `promptId` | as typed | as typed |
| `P\nP\ntext` | `[Image #2] [Image #3]text` + 2 blocks; one `isMeta` record, both paths | as typed | as typed |
| `P\nline one \nline two  \n…` | `[Image #4]line one \nline two  \n…`: **trailing spaces kept** | as typed | as typed |
| `P` | `[Image #5]` + block; `isMeta` record | `local_image{path}` + text `[Image #1]` | text chunk `[Image #1] ` + image chunk |
| `P\nP` | `[Image #n] [Image #m]` + 2 blocks | as typed | text chunk `[Image #1] [Image #2] ` + 2 image chunks |
| `P\n<1,100 characters>` | `[Image #6]\n\n<pasted_content …>\n…\n</pasted_content …>\n` | as typed | as typed |
| `T\ntext` | as typed | as typed | as typed |
| `P\nT\ntext` / `T\nP\ntext` | `[Image #n]T\ntext` in **both** orders | as typed | as typed |
| `P\ntext`, busy | `queue-operation enqueue` `[Image #n]text`, then the same records | as typed | as typed |

Claude removes **every** line that is an existing image file's path, wherever it
is, and puts space-separated `[Image #N]` placeholders in front of the remaining
lines. The image numbers count across the session. The paths are written in the
`isMeta` "companion" record, after the prompt record and its attachment records.
That record has the same `promptId`. The prompt record keeps the rest of the text
exactly: trailing spaces, inner lines and the paste envelope.

All three Claude versions behave the same way. **The plain-path form reported
for 2.1.286 (`msg_fdc5372e`) was not reproduced with an existing PNG.** The
plain form is what every non-image path gets here (`T`). The matcher accepts
both forms.

Codex and Grok change the text only when the whole paste is image paths. Codex
did not convert even then for two paths. Grok writes its own copy of the image
(`file://…/images/image-<uuid>.png`), never our path.

## Before and after

[`verdicts.ts`](verdicts.ts) runs the checked-out production reader and send
proof over these records. It reports the prompt entries per case, whether the
first entry is the send, and, for a busy Claude case, whether the queue record
holds it. These were the results on dev/mw `112e91abcb`. Every case not listed
was already proven.

| Program | Case | Entries before → after | Proven before → after |
|---|---|---|---|
| Claude, each version | every case with a PNG (11 of 13) | 2 → 1 | **no** → yes |
| Claude, each version | busy cases: queue record holds the send | — | **no** → yes |
| Codex 0.162.0 | `path-only`, `busy-path-only` | 1 → 1 | **no** → yes |
| Grok 1.0.46 | `path-only`, `busy-path-only` | 2 → 1 | **no** → yes |
| Grok 1.0.46 | `two-images-path-only` | 3 → 1 | **no** → yes |

The causes were the following:

1. The prompt entry has no path (it is in the companion), so the typed
   `P\ntext` never equalled `text`.
2. Claude's reader removed spaces before **every** line end of any prompt with
   an image, so text with a trailing space could not match even after the path
   was restored.
3. The companion record, and Grok's image chunks, counted as more prompt
   entries.
4. A queue record and Codex/Grok path-only text still held the `[Image #N]`
   placeholders.

## The rule now (`promptEntryMatches`)

An entry is the send when its text equals the typed text under the program's
measured tolerance after undoing only the measured change:

- Remove as many typed path lines as the entry has images (image blocks, or
  placeholders left in its text).
- Remove the placeholders from the recorded text.
- Where the reader lifted the paths into `toolPaths`, the removed lines must be
  those paths, in order.

Each attachment is then accounted for as a line of the text or as an image of
the entry. A send that was only image paths is matched by an entry with no text
and that many images. Claude's reader now removes only the markers, with the one
space after a placeholder and a line holding only markers. Every other byte
stays. The companion record and Grok's later image chunks of the same prompt are
not prompt entries.

`packages/harness/src/image-attachment-echo.test.ts` holds every case of every
lane to that rule. Each entry must match its own send. It must not match any
other case's send, unless no record could tell the two sends apart: the same
words and the same kinds of attachment.

## Reproduce

```sh
bun docs/measurements/pod-5923-image-attachments/measure.ts \
  --program claude --binary <claude> --label claude-<version>
bun docs/measurements/pod-5923-image-attachments/measure.ts \
  --program codex --binary <codex> --label codex-<version>
bun docs/measurements/pod-5923-image-attachments/measure.ts \
  --program grok --binary <grok> --label grok-<version>
bun --conditions=@podium/source docs/measurements/pod-5923-image-attachments/verdicts.ts
```

Set `TMPDIR` to a filesystem with roughly 600 MB free for Codex, whose copied
app-server lives in the scratch HOME. The scratch directory is deleted after a
run unless `--keep` is given.
