# Transcript DOM window

The candidate retains measured shells for loaded history and mounts rich message
rows within the viewport plus three viewports on each side. Selected rows,
focused controls, user-opened details and the preceding operator prompt remain
mounted while needed. Shell height includes the day mark and spacing; resolved
CSS heights are rounded back to the browser's layout unit so deep document
coordinates and CSSOM decimal rounding cannot accumulate spacer error.

The shared scroll controller remains the only writer of scroll position. A
prepend reconciles its stable shell anchor before the window chooses its buffer.
A search/minimap block jump restores the addressed row outside React's commit,
then the same controller aligns its actual geometry. Restored history does not
replay the arrival animation. Window updates use the same eager animation-frame
commit and three-viewport buffer used by POD-5880.

Native keyboard Find temporarily mounts all loaded rich rows. The browser needs
the original text ranges to preserve its match count, highlight and repeated
jumps. Opening yields to the browser and to app shortcut handlers; an
app-handled Ctrl/Cmd+F does not expand the transcript. Closing Find restores the
buffer and retains the committed selection. Select All similarly needs all rows
until its selection clears. Changes to width, fonts or display mode temporarily
remeasure loaded rows instead of estimating different wrapping.

**Decision still pending:** first opening native Find from the browser menu
bypasses the keyboard hook. The hidden-until-found fallback can lose a wrapped
return jump in Chromium after its browser-owned range is replaced. This is a
known limitation, not a passing Find result. The coordinator has the full-row
session policy and this limitation for review; the candidate is not landed.
The Mac shell has no native Find menu; its transcript search uses the shared
block-jump controller. Native Mac behavior still needs the coordinator's check.

The production proof uses a fixed corpus of 8,058 synthetic messages, with
paragraphs, lists, inline code, links, user prompts and assistant answers. Raw
corpus data is allocated up front in both arms. The original arm restores the
pilot's feed, shared scroll controller and stylesheet; all other modules and
fixture inputs match. Both fixtures are minified builds without work-meter
instrumentation, at a 1,600 by 900 viewport, with fonts settled before sampling.
This isolates rich rendering from graph storage and search postings. It does
not reproduce the operator's exact message mix or the native app's whole process.

Each phase counts all attached elements, forces Chromium GC, records JS heap
usage, and sums the browser's own renderer processes' Linux VmRSS. VmRSS includes
native renderer allocations; it is not WKWebView physical footprint. There is
no native Mac runner available to this lane. The coordinator owns any native
check after landing, as recorded in the issue mail.

Final paired capture is pending. The completed provisional captures have the
same 1,842,384px height at 8,058 messages, with 161,194 attached elements before
and 24,481 after (84.81% fewer). The buffered tail contains 16 rich rows.
Retained shells, text and loaded data still grow with history; this is a lower
slope, not a claim of flat whole-process memory. Final memory numbers and the
complete top-to-bottom-and-back capture will be saved alongside this report.

The proof drives real wheel input, native clipboard copy after a selection
leaves the viewport, and Chrome's actual Find bar on a private Xvfb display.
`window.find()` does not exercise the same hidden-text reveal path in Blink;
the collector uses native XTEST keyboard events instead. The final capture also
records a 400-row prepend while reading, 50 fast-scroll first-paint samples,
native 4000→6000→4000 Find, committed selection, an empty Find close, and Tab to
the first off-window message control. The screenshot includes Chrome's own
1/1 match indicator and original native highlight.

All validation runs on flatblock with checkout-local Bun 1.4.2, `node -> bun`,
one focused file per run, and the resource guard. Completed focused files have
15 window tests and 30 scroll tests green; two new stable-shell/layout-order
regressions await their final run. The preceding feed-motion run had 13 tests
green. The full typecheck, lean gate, final scan, normal web build, structural
census and landing belong to POD-5895; none is claimed green for this candidate.

To reproduce after frozen worktree setup on flatblock, use the pinned toolchain
and its copied shared libraries. The collector's private native-tool directory
also needs Xvfb, xdotool, xkbcomp, XKB data, PRoot and their libraries; the measured
checkout extracts their Debian packages under `.toolchain/native-find` rather
than installing host packages. PRoot binds that checkout's xkbcomp at the path
Xvfb expects, with `PROOT_NO_SECCOMP=1`. Every display/browser PID belongs to the
run and is cleaned up by the collector and resource guard.

```sh
python3 apps/web/harness/flatblock-budget.py --log=.artifacts/build-before.log -- \
  .toolchain/bun apps/web/harness/transcript-window-proof.ts before --build
python3 apps/web/harness/flatblock-budget.py --log=.artifacts/proof-before.log -- \
  .toolchain/bun apps/web/harness/transcript-window-proof.ts before
python3 apps/web/harness/flatblock-budget.py --log=.artifacts/build-after.log -- \
  .toolchain/bun apps/web/harness/transcript-window-proof.ts after --build
python3 apps/web/harness/flatblock-budget.py --log=.artifacts/proof-after.log -- \
  .toolchain/bun apps/web/harness/transcript-window-proof.ts after
python3 docs/measurements/pod-5889/evidence.py \
  --before .artifacts/transcript-window/before/report.json \
  --after .artifacts/transcript-window/after/report.json \
  --before-image .artifacts/transcript-window/before/window.png \
  --after-image .artifacts/transcript-window/after/window.png \
  --out .artifacts/transcript-window/evidence.html
```

The standalone HTML and screenshots are issue artifacts, not committed image
files. `--anchor-only` isolates one prepend and `--debug` omits the 50 fast-scroll
samples; neither is a complete production proof.
