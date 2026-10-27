# First Flights moments

The shell already mounts `TipHost` and the sidebar badge. Import `useTipMoment` and
`TipCard` from `@/features/tips`. Do not add another host or write the log yourself.

- Use one registration per ID. Keep it mounted with `active: false` when possible
  so the guide can replay it. Use a unique anchor name on a visible real element.
- `active` means the trigger has happened and this moment is eligible. Keep it true
  while queued. Setting it false cancels a queued moment or dismisses a visible one.
  The engine queues on a false-to-true change or first registration, not each render.

```tsx
const cards: TipCard[] = [{
  anchor: 'my-moment-composer',
  title: 'Aim high.',
  body: 'Say what you want and how to run it. Agents follow your plan.',
  extra: <Legend />,
  onShow: () => startGhostDemo(),
  onHide: () => restoreDraft(),
  cta: { label: 'Write my task', onClick: () => composer.current?.focus() },
}]
useTipMoment('first-prompt', { active: first, cards })
return <div ref={composer} data-tip-anchor="my-moment-composer">…</div>
```

- Inline card arrays and callbacks work. There are at most two cards; extra cards are
  ignored. Keep titles to five words and bodies to twenty. An optional `extra` can
  render a legend or examples. A CTA replaces the Next/Got it label, advances the
  tip, then runs its callback. Only a user click may open panels, tabs or files.
- `onShow` runs when each card opens; `onHide` runs before advancing, dismissing,
  disabling, or unmounting. Undo demos there. Demo text must never enter the real
  draft. Use `useReducedMotion` from `@/lib/use-reduced-motion` for custom animation.
- Missing, hidden, offscreen or scroll-clipped anchors skip quietly. If no card showed, the log
  stays unseen. To retry, activate again when the anchor is available. If an anchor
  disappears after showing, the moment is dismissed and seen. The engine never
  scrolls an anchor into view or opens its containing panel.
- A name carried by several mounted elements resolves to the first fully visible one,
  and replay picks the registration whose first anchor is on screen. For a trigger
  that waits for its element to be on screen, gate `active` on
  `useTipAnchorVisible(element)`: it uses the same criterion as the engine, so each
  time the anchor comes fully into view is a new activation. Pass null once
  `useTipUnseen(id)` is false; keep the registration and anchor for replay.
- One moment shows at a time. Keyboard input postpones queued tips for three seconds;
  closing a tip starts a twenty-second gap. Replay uses the same queue, ignores
  seen-state and `active`, and still needs the registration and anchor to exist.
  An unmounted logged moment stays in the guide with a return-to-moment hint.
- Tips announce their title and body politely without moving focus. F6 moves focus
  to the tip controls; F6 again returns to the prior control. Keyboard dismissal
  also restores that control. Card changes preserve focus, and tall cards scroll.
- The engine records `shown` once per opened moment, then `finished` or `dismissed`.
  Esc, × and outside clicks dismiss. Skip tips records `skipped-all`; the log marks
  all seven seen and disables tips. Nothing shows before `log.ready && log.enabled`.

`types.ts` is the shared log contract with POD-2195. `tip-log-source.ts` selects the
account-scoped log; `MemoryTipLog` serves tests and harnesses only.
No registration means no visible UI. The badge retires when all seven are seen.

For isolated preview, open `/harness/tips.html` with `bunx vite --config vite.tips.config.ts` from `apps/web`. Its controls cover queueing, missing anchors, replay and reduced motion.
