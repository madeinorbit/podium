# POD-4868 — framed auto-continue and automation prompts, on the real Claude CLI

Question: once auto-continue's `continue` and an automation's prompt are typed inside Podium's
short frame (`[podium message <id> · from … · to your session]` … `[end podium message <id>]`,
no reply rules), does the CLI still resume errored work, and still take an automation prompt as
an instruction?

Method as in `../pod-4834-receipt-proof/README.md`: Claude Code 2.1.284, terminal UI in a
180×45 tmux pane; `HOME` and `CLAUDE_CONFIG_DIR` in a scratch directory (settings allow
`Bash(echo:*)`; onboarding done, the dummy key approved, the work directory trusted);
`ANTHROPIC_BASE_URL` pointing at `fake-model-server.ts` on localhost, a dummy
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and
`CLAUDE_CODE_MAX_RETRIES=0` so an outage errors the turn at once. Framed text was typed the way
Podium types it: a bracketed paste (`tmux paste-buffer -p`), then Enter. No real credentials.
Run 2026-09-29; the fake was restarted once between the two automation prompts (`marks.txt`), so
request numbers in `model-requests.jsonl` start again; `at` orders them.

The fake decides its answers, not a model: a turn whose last user entry contains `continue` in a
conversation holding ALPHA gets a Bash call `echo resumed-alpha`, one containing NIGHTLY gets
`echo nightly-ran`. So what this shows is the CLI's side, below. How a real model reads the frame
was not measured (it needs real credentials); every agent mail already reaches models in the
longer version of the same frame and is acted on.

## Results

| Step | What was typed | What the model received | What the CLI did |
|---|---|---|---|
| Outage on | `Do task ALPHA: …` | request, answered HTTP 500 | `API Error: 500 fake outage`; the turn ended errored |
| Outage off | framed `continue` (from `system:auto-continue`) | ONE user entry: the errored ALPHA prompt, then the framed `continue` (the CLI merges them, since the errored turn has no reply) | ran the returned tool call (`echo resumed-alpha`), sent its result, finished the turn |
| — | framed automation prompt (from `automation:aut_nightly`, NIGHTLY) | its own user entry after the previous answer, frame intact | ran the returned tool call (`echo nightly-ran`), sent its result, finished the turn |

History file (`transcript-user-records.jsonl`): each framed message is its own `user` record
with a new `promptId`, its text byte-for-byte the pasted frame, so the id Podium's transcript
match looks for (`podium message msg_…`) is in the record.

What this settles:

- A framed `continue` resumes an errored Claude turn the same way a bare one does: the model gets
  the original prompt together with the continue in one user entry, and the CLI carries out
  the reply.
- A framed automation prompt is submitted as an ordinary user turn (not rejected, not treated
  as a command) and the CLI carries out the reply.
- Both are recorded in Claude's history with the frame and its id, so they can be confirmed by
  id rather than matched by text.

Not covered: the other harnesses (Codex, OpenCode, Grok, Cursor) and Claude's SDK mode, and a
real model's reading of the frame.
