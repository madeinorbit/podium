# POD-2819 — the epic's only "headless worse" cell

*POD-2777's matrix had one red against the epic's own bar: `codex / attach`
FAILED on the headless driver and PASSED on its PTY. This is that cell, driven
until it said what was actually wrong, and then green.*

```
                                  codex         opencode      claude
behaviour                         H     T       H     T       H     T
attach a file          BEFORE     FAIL  PASS    PASS  FAIL    —     FAIL
attach a file          AFTER      PASS  PASS    PASS  FAIL    —     PASS
```

Re-driven on POD-2777's rig, unchanged, per-cell pinned, every control fired.

---

## THE SHORT VERSION

Three claims were on the table. **One was true, one was false, and the third —
the obvious fix — was false in a way that passes an ordinary test.**

| the claim | verdict |
|---|---|
| the driver declares image-only and codex accepts more than images | **TRUE.** The app-server names seven input kinds. The declaration was the regression. |
| the image it *does* declare was not read back, so a declared capability does not work | **FALSE.** The pixels reach the model. POD-2777's nonce image is what the model cannot read exactly — 1 exact hit in 9 trials, and 4 of 6 digits on the miss, where guessing is 1 in 10 per digit. |
| `claude / attach` FAIL is either this epic's regression or a pre-existing gap | **NEITHER.** Claude reads an attached file on the epic tip AND on today's main. The FAIL was claude's onboarding modal eating the turn — identically on both builds. |

---

## 1. THE DECLARATION WAS FALSE, AND THE SERVER SAYS SO ITSELF

The driver refused a text file with a typed `unsupported` reading *"Codex accepts
image attachments only"*. That refusal was honest about the declaration. The
question the brief asked first was whether the declaration was honest about
codex — established **before any code changed**, and against the protocol rather
than against documentation.

`codex app-server generate-json-schema` emits the schema the binary holds about
itself, and `UserInput` there has seven variants. But a generated schema sitting
beside a moving binary is exactly the kind of artefact that rots, so the claim
rests on something the running server does instead. Hand it a variant it does not
know and it enumerates the ones it does:

```
turn/start: {"code":-32600,"message":"Invalid request:
  unknown variant `localFile`, expected one of `text`, `image`,
  `localImage`, `audio`, `localAudio`, `skill`, `mention`"}
```

**That error is the negative control.** It is codex describing its own accepted
set, in its own words, at the version actually installed (0.149.1).

So `kinds: ['image']` was never true. The cell was a real regression against the
epic's bar, and it was in the *declaration*, precisely as the brief suspected.

Reproduce: `bun docs/evidence/pod-2819/codex-input-variants.ts enumerate`

## 2. THE MENTION TRAP — the obvious fix, and why it looked like it worked

`mention` is `{ name, path }`: codex's own `@`-mention, the thing its TUI builds
when you reference a file. It is in that list. It is the typed, protocol-native
vehicle. **It does not work, and the first measurement here said it did.**

The mention arm "passed" — the agent produced the secret. What the agent had
actually done was run `rg --files -uu`, then `find /tmp/... -type f`, locate the
staged file itself, and `sed` it. The secret came back because the agent went
hunting, not because the attachment was delivered.

**An answer-scored probe cannot tell delivery from hunting.** The model's own
input can: `thread/start` returns the thread's rollout JSONL path, and that file
records the exact prompt the model was sent. Re-scored there, with each arm in a
uniquely named root sharing no parent with any other (the hunting agent had found
a *sibling arm's* file):

```
DROPPED    mention, name matching the staged basename
DROPPED    mention, name differing from it
DROPPED    mention with `@name` written into the text beside it
DELIVERED  the path written into the text
```

The server accepts a `mention` part and the model is never shown it. So files
ride in the prompt text — the same shape the terminal driver builds, the same
shape the web composer has always sent (`paths.join('\n') + '\n' + text`), and
the one POD-2777 measured codex PASSING with on its PTY. Images keep
`localImage`: that half puts pixels in front of the model and was never broken.

This cost a commit. `2427e9f` shipped the mention and the cell stayed red;
`52f4043` corrects it. Both are in the history rather than squashed, because the
trap is the interesting part.

Reading: `readings/input-vehicles-scored-on-the-model-prompt.json`

## 3. THE IMAGE WAS NEVER BROKEN — the nonce is

The brief called this one unambiguous: *"the driver claims a capability and does
not deliver it"*. Driven, it does not hold up, and saying so is worth more than a
fix nobody needed.

The FAIL was reproduced first, on the rig, at the epic tip. Then the transcript
was read back off the same socket the probe used:

```
SECRET IN PIXELS  139665   — drawn into the image, present nowhere else
THE AGENT SAID    179625   — six digits, four of them right
```

Four of six positions correct is not a session that saw no image. Per digit,
chance is 1 in 10; P(≥4 of 6 by guessing) ≈ **1 in 790**, and that ignores the
agent producing exactly six digits at all. Repeated raw against the protocol,
across nine readings in total, the pattern holds: mean **4.1 of 6 digits
correct** against **0.6 expected by chance**, and **one exact match in nine**.

The image reaches the model. POD-2777's `nonce-png.ts` draws a 5×7 bitmap font
whose `3` has a flat top — which is a `7` in its top half — and the recurring
confusions in the readings are exactly `3↔7`, `8↔3`, `9↔5`, `5↔6`. The file's own
comment worried about the right thing ("no letter pairs a model can transpose")
and then picked confusable digit glyphs. `detail: auto|low|high|original` was
tested and is not the mechanism: the arm that passed was the one sending **no**
`detail` field, and `high` failed.

**This branch is now unreachable anyway**, which is the tidy part: the attach
probe only draws an image when text staging is REFUSED, and codex no longer
refuses text. The cell is scored on the text falsifier, like every other driver's.
Filed as a rig defect rather than repaired here, because POD-2777's readings were
taken with the file as it stands and silently changing it under them would make
its own evidence unreadable.

Reading: `readings/image-nonce-legibility.json`

## 4. CLAUDE — not a regression, and not a pre-existing gap either

The brief was explicit: do not assume, say which, with the measurement. Claude
binds `claude-pty` whatever the preference says, so the cell cannot be a
headless-driver regression — but the terminal driver it binds is 1,554 lines this
epic ADDS against main, so "pre-existing" needed measuring too.

A second instance was stood up on **today's main** (`2066935`) — its own state
root and port, because p2777's root has been migrated by the epic's server and
pointing main at it would ask a build to read a schema from its own future. The
shape driven is the one main HAS: `sessions.sendText` takes no `attachments`
there, so both arms send what main's composer sends, `paths + '\n' + text`, which
is byte-identical to what the epic's terminal driver builds server-side.

| build | shape | verdict |
|---|---|---|
| main `2066935` | path-first (the product's shape) | **PASS** — `FILESECRET-DD958E` in 7.7s |
| main `2066935` | path-inline | **PASS** — 6.2s |
| epic tip `5b25f9a` | path-first | **PASS** — `FILESECRET-1F69AE` in 7.4s |
| epic tip `5b25f9a` | path-inline | **PASS** — 6.7s |

**Claude reads an attached file on both builds.** So what was POD-2777's FAIL?

The screen said it. Claude's environment-onboarding dialog — *"Set up auto mode
for your environment?"* — arrives PARTWAY THROUGH a session, after the first turn
has already answered. The next injected turn goes into the dialog rather than the
composer, its Enter selects the highlighted option, and the session ends up
sitting on `/auto-mode-setup` having run it. Claude's own transcript
(`~/.claude/projects/…/*.jsonl`) holds the control turn and nothing else: the
attach turn never reached claude at all.

POD-2777's TUI primer runs once, ten seconds in, and clears the dialogs it was
written for. This one is not one of them, because it is not a first-run dialog.
So the probe here primes again immediately before the measured send, and reports
REFUSED — not FAIL — if a modal is still on screen when the window closes.

**Two things fall out, and only one is a rig fact.** The rig fact is the primer's
blind spot. The other is a product question: `sessions.sendText` answered
`{ok:true, disposition:'delivered'}` for a turn that never reached the agent,
observed on BOTH builds, and a caller cannot tell that from a turn that ran. It
lands on the epic's own named residual risk — `claude-screen.ts`, which DOES
classify this dialog as `needs_user` and evidently did not stop the send. Filed
separately; it could not be re-isolated on demand here because the dialog is
once-per-home and had already been dismissed.

Readings: `claude-main-2066935-*.log`, `claude-epic-5b25f9a-*.log`, and
`claude-epic-rig-attach-FAIL-the-modal.log` for the original failure.

**No token was rotated.** Claude authenticates by OAuth only and a refresh in
either home invalidates the other holder. Both arms were driven with 293 minutes
of validity remaining and 252 remaining afterwards, and both agent homes' copies
were verified byte-identical to the live credential at the end — so neither rig
ever refreshed, and the operator's sessions were never touched.

---

## THE CELL, BEFORE AND AFTER

Same rig, same probes, same controls; per-cell pinned.

| arm | before (`35c1d1e`) | after (`5b25f9a`) |
|---|---|---|
| codex / **headless** (`codex-app-server`) | **FAIL** — text refused as declared, and the image it does declare was not read back | **PASS** — read the file and echoed `FILESECRET-4CQAWS` in 33.0s |
| codex / **terminal** (`generic-pty`) | PASS | **PASS** — echoed `FILESECRET-BHVPQL` in 19.1s |

Both arms now score on the STRONG falsifier — a secret present in the file's
bytes and nowhere else — rather than on an image the model reads four digits of.

---

## RE-RUNNING ANY OF THIS

```bash
# the protocol question, no Podium in the loop
bun docs/evidence/pod-2819/codex-input-variants.ts

# the cell itself, on POD-2777's rig
P2777_REPO=$PWD bash docs/evidence/pod-2777/drive-up.sh
P2777_REPO=$PWD P2777_ONLY=attach bun docs/evidence/pod-2777/drive.ts codex

# claude, on today's main
bash docs/evidence/pod-2819/drive-up-main.sh
( . docs/evidence/pod-2819/drive-env-main.sh; PODIUM_PASSWORD=p2819 \
  bun docs/evidence/pod-2819/claude-attach.ts /tmp/pod-2819/repo path-first )
```

## WHAT THIS COST, RECORDED SO IT IS NOT PAID AGAIN

Three readings here were wrong before they were right, and each was caught the
same way — by asking what the *instrument* could see, not what the answer said.

1. **`mention` "passed" because the agent went hunting.** Caught by reading the
   model's own prompt out of the rollout instead of trusting the reply.
2. **The image "failed" because the nonce is illegible.** Caught by reading the
   agent's actual words instead of a boolean "did the secret come back".
3. **`path-inline` "also failed" on claude.** Caught by noticing the second arm
   ran on a session the FIRST arm had already wedged. One shape per session now.

The shape is the same each time: **a probe that scores only the final answer
cannot tell a working mechanism from a lucky one.**
