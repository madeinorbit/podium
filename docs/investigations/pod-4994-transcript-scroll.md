# Transcript scrolling stability

Desktop ChatView and the phone Expo client had several independent position
writers and layers that could discard the reader's message. Phones normally
enter `/mobile`, including a cached-desktop-shell redirect, so both clients
require the same contract. The visible symptoms are different expressions of
these races. POD-4999 records the additional phone findings; they are included
in this implementation.

## Causes

| Mechanism in the previous implementation | Result |
| --- | --- |
| `loadOlderAnchored` captured a row once and its layout effect cleared the anchor on any change to `blockCount`, `renderStart`, or `rowsToRender`. Paging changes `renderCount` before the asynchronous compute worker returns the enlarged row graph. | The intermediate commit consumed the anchor without inserting history. When history finally mounted, the viewport stayed at its old numerical offset inside the new, earlier section. |
| Scroll events cleared a pending anchor whenever `scrollTop` changed during a request. | Moving while a page was in flight left its eventual insertion completely unanchored. The correct reference is the reader's latest position, not either the old request position or no position. |
| `useTranscriptWindow` always selected `rows.slice(rows.length - renderCount)`. | Each appended row beyond the window limit removed a row from the mounted top, including while the reader was in history. The scroll coordinate system moved under them. |
| Newest-window reconciliation could replace the held items with a shorter snapshot. | Activity reconciliation, heartbeat refreshes, and reconnects could remove the actual message being read. No DOM-only correction can retain a message absent from the data. |
| Installed `use-stick-to-bottom` 1.1.6 deferred scroll interpretation and ignored it while `resizeDifference` was nonzero. Its wheel handler looked for the shorthand `overflow` equaling `auto` or `scroll`, whereas the feed combines horizontal clipping and vertical scrolling. It had no touch-intent listener. | Upward movement concurrent with streaming could miss escape recognition. A later resize could follow the tail again. The shorthand mismatch weakened the early wheel escape on this particular scrollport. |
| Jump and send used `ignoreEscapes: true` for 350 ms. During that interval the library's scroll handler assigned its saved `lastScrollTop` back to the element. | Actual new reader input could be undone. Multiple queued scroll events and writes could alternate between two positions. |
| The library rearmed follow on content shrink near its 70 px bottom band and exposed `isAtBottom || isNearBottom` to the UI. | Layout changes could silently reinstate follow, and the jump control could disappear even though the reader had escaped it. |
| Browser anchoring remained enabled alongside explicit prepend correction and bottom-following. Minimap and pinned-shelf forwarding also wrote independently. | Multiple authorities could respond to the same geometry change or user action, with ordering dependent on the engine and frame timing. |
| A row was rendered directly without a day label, but under a differently keyed Fragment with one. Paging can move the leading date boundary. | React could replace a retained row merely because its day label moved, breaking element identity and selection. |

These are source-level findings, supported by regression scenarios. They do not
prove which individual race occurred in an unrecorded device session. The old
Safari investigation in `pod-1160-safari-scroll-anchoring.md` describes an earlier
scroll implementation; its engine-specific remedies are not carried forward
without fresh evidence against the current normal-order DOM.

The phone list adds these mechanisms:

| Mechanism | Result |
| --- | --- |
| Drag/touch/wheel sets `operatorMoved` without clearing `pinned`; content callbacks still test `!operatorMoved || pinned`. | A content update between gesture intent and its first scroll event can send the reader back to the tail. Search has the same gap. |
| Installed RN Web 0.21 has no `maintainVisibleContentPosition` implementation, although the FlatList requested it. | History prepends cannot depend on the anchoring promised by the native prop. |
| The web FlatList windows variable-height Markdown through estimated/unmounted cell geometry. | Cell-window changes move the coordinate system without a retained DOM reading anchor; this is a source-level candidate for the reported invisible boundaries. |
| Any scroll measurement within 48 px rearms native pinning, including layout-induced movement. | Shrink, viewport changes, and adjustments can silently reinstate following. |
| Mobile SessionConversation newest refreshes did not retain loaded history while reading. | The source could remove the phone's actual reading message too. |

One further paging boundary applies to both clients: a short or collapsed page
may fit inside the viewport. Upward input at its top cannot change `scrollTop`,
so an autoload trigger that depends solely on scroll events never runs. Browser
wheel, touch, and keyboard intent now requests history at that boundary; a native
drag on an underfilled page does the same. The loading guard still excludes a
second request while the current page is in flight.

That browser regression also exposed an event-classification gap after a range
shrink. The browser can clamp to the new maximum before delivering its scroll
event. Layout reconciliation now acknowledges that clamp when the previous
observed offset is outside the new legal range. Its eventual event cannot
masquerade as upward reader movement and request history. Neutral resizes still
leave pending genuine reader movement intact.

## The scrolling contract

There are exactly two modes: **following** and **reading**. The mode records
reader intent. It is not inferred from a resize, message arrival, a timer, or
the agent's working state.

| Event | Following | Reading |
| --- | --- | --- |
| Content or viewport changes | Place the tail at the bottom before paint. | Keep a retained message at its viewport offset. |
| Upward wheel, touch, keyboard, or scrollbar input | Release immediately, before browser movement. | Continue reading and refresh the anchor as movement arrives. |
| Older history is requested or committed | Enter reading. | Preserve the latest reading position through every intermediate commit. |
| Reader scrolls downward to the actual bottom | Follow. | Resume follow, allowing only 2 px for fractional geometry. |
| Explicit Jump or send | Follow immediately. | Follow immediately. New upward input can release immediately. |
| Search/deep link | Enter reading and position the target within this scroller. | Position the target within this scroller. |
| Hide/show the same pane | Preserve intent. | Preserve intent and reading position. |
| Switch conversation | Open the new conversation at its tail. | Open the new conversation at its tail. |

The shared `client-core/react/transcript-scroll` controller is the only browser application scroll writer. Minimap and shelf wheel
forwarding call it. Native browser anchoring is excluded on this scrollport;
ordinary browser wheel/touch/keyboard movement still does the scrolling.
[The browser anchoring API](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-anchor)
exists specifically to opt a controlled scroll region out of native adjustments.

## Position conservation

The reading anchor holds a stable row identity, its retained element, its
viewport offset, and the scroll offset at capture. Let `r` be the row's current
viewport offset, `a` its captured viewport offset, `s` the current `scrollTop`,
and `s0` the captured `scrollTop`. The correction is:

```text
layout displacement = r - a + (s - s0)
new scrollTop       = s + layout displacement
```

The final term preserves user movement that the compositor has already applied
but whose scroll event has not yet reached JavaScript. Without it, a restore
can undo the reader's latest movement. Growth below the anchor contributes no
displacement, even when it happens at the same time as a prepend. A total
`scrollHeight` delta cannot make that distinction.

The anchor persists through loading-only commits and is updated after each
correction or accepted reader scroll. React layout effects cover row commits;
one ResizeObserver watches the growing content, its rows, and the viewport, covering
image/font reflow and pane/composer/keyboard size changes. Exact writes record
their resulting offset so their later scroll events do not masquerade as input.
There is no settling timer and no period during which reader input is rejected.

Corrections are clamped to the actual scroll range. Absolute pixel conservation
can be impossible at a range boundary: after a previously short page grows,
there may still be insufficient content below the anchor to place it at its
former offset. That constraint never reinstates following or removes the held
history.

Observing row sizes also detects opposing changes above and below the reader
that cancel in total content height. A content-box-only observer misses that
movement, even though the visible message has changed position.

## Identity and retention

Rows carry their stable transcript item id as `data-row-key`, independently of
absolute indices used by search and the minimap. Every row always has the same
keyed Fragment parent, whether or not it carries a date label. Tool rows expose
the ids of their member items as anchor aliases: a page can merge older tools
into the leading batch and change its first-item key without removing the held
item. Both mounted-head retention and DOM anchor lookup handle that case.
Phone row keys use item identity rather than paging cursors, which can change
without creating a different message.

While reading, the rendered window retains its mounted leading row instead of
sliding forward on live appends. Newest reads merge into the loaded history,
preserving the history paging cursor and an older read in flight. Explicit
source resets remain authoritative. Returning to follow permits the existing
tail-window trimming behavior again. The legacy controller also stopped activity
refreshes and heartbeat probes entirely after paging. Hosts with this explicit
retention policy keep reconciling safely: reading retains history and resumed
follow permits trimming.

Retention is deliberately conservative. Continued live output while reading
can grow the mounted window. The previous implementation already grew it for
every history page; it was not a fully bounded virtualizer. If this becomes a
measured memory problem, a measured variable-height virtualizer with stable
keys and spacers is the appropriate next step. Deleting the reader's content
without preserving its geometry is not a memory policy.

The anchor conserves a row's position. It cannot preserve the exact word inside
a row whose own text is rewritten, nor a row removed by an authoritative source
reset. Those are data/content changes rather than permission to jump to the tail.

## Phone adapters

The phone web viewport uses RN Web's actual ScrollView and the shared browser
controller. Loaded rows remain mounted in normal DOM order, with stable wrapper
keys and no estimated list spacers. Settled row shaping and memoized Markdown
remain independent of streaming footer changes. SessionConversation sends
follow intent synchronously to the data controller's retention policy.

Native iOS/Android retains FlatList with native visible-content anchoring. A
small native adapter owns follow intent, alongside [native visible-content
anchoring](https://reactnative.dev/docs/scrollview#maintainvisiblecontentposition): drag releases immediately; content and
viewport callbacks follow only while following; dimension-induced scroll events
cannot rearm it; an actual downward return to within 2 px of the bottom can.
Jump and send target the measured content/viewport heights without an input
lockout. Native search retains the existing unmeasured-index fallback.

The browser DOM retention policy applies to the phone too. Paging or continued
output while reading can grow mounted history; a future bounded implementation
must use measured variable-height spacers and preserve the visible stable key.
An estimated list that discards the reading coordinate system is unsuitable.

## Verification scope

The exact regression files exercise the production hook rather than a mocked
follow library: asynchronous paging commits, movement during a request,
compositor movement before event delivery, simultaneous tail and prefix growth,
immediate escape after Jump, viewport changes, selection, actual-bottom rearm,
retained render-window heads, refresh retention, paging epochs, and source resets.

`transcript-scroll.browser.e2e.ts` bundles the production controller into a small
isolated fixture, including the production phone RN Web ScrollView adapter,
and drives wheel/keyboard and Chromium compositor touch input.
It observes retained message offsets and consecutive frames after a prepend.
It does not use operator sessions or claim to verify the native desktop shell
or physical iOS/Android scrolling. Native adapter event-order regressions
exercise its intent and dimension guards; native list anchoring is platform-owned. WebKit phone emulation uses real
keyboard input; Playwright supports neither wheel input nor compositor drags in mobile WebKit.

## Validation record

- Focused cached typecheck for `@podium/web`, `@podium/mobile`,
  `@podium/client-core`, and `@podium/e2e`: 18 tasks successful.
- Thirteen targeted regression files passed across the completed focused runs.
  The final shared-scroll file executed 21 tests; the native adapter file
  executed 9; the phone conversation file executed 3, including paging followed
  by activity refresh and resumed follow.
  All runs used `bun run test:file`; this is focused evidence, not a full-suite
  or lean-gate result.
- The real browser lane selects `transcript-scroll` on `chromium-desktop`,
  `chromium-pixel`, and `webkit-iphone`, exercising both production browser
  viewports. **The final run passed all 6 scenarios in 43.8 seconds**, including
  short-page paging and clamp classification, with no import errors or
  quarantined suites. The Pixel project uses real compositor touch; mobile
  WebKit uses keyboard input because its Playwright backend does not support
  wheel input or compositor drags.

Browser preparation initially exceeded the mobile export's default Node heap;
the successful runs used `NODE_OPTIONS=--max-old-space-size=4096`. The runner also
redundantly exports mobile after the workspace build. The separate discovered
issue POD-5013 records that preparation defect. Shared `test:heavy` lease waits
accounted for additional validation delay.

The validation above ran on the original source checkout. The owned changes
were then transferred to `issue/4994-transcript-scrolling`, based on local
`dev/mw`, preserving its newer delivery, offline-machine, and shelf-order
changes. No running operator session or deployment was modified for verification.

The complete `dev/mw`-based candidate was validated on 2026-10-01:

- `bun run test`: lean gate green, with 25 successful typecheck tasks,
  span-effect lint green, and 153 boot/configuration tests in 4 of 1685
  collected files (0.2%).
- One `bun run test:file` invocation selected the eleven changed regression
  files: 29 mobile, 86 web, and 28 controller tests passed (143 total).
  These checks include the newer delivery and machine-presence integration.
- The six browser scenarios above were completed before the transfer; they
  were not rerun for this integration. Platform-owned native anchoring and the
  desktop shell retain the verification limits described above.
