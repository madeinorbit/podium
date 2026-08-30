# Product

## Register

product

## Platform

native iOS

(One Expo/React Native codebase. The first supported native release is iPhone-only on iOS 16.4 or later, distributed through TestFlight before App Store review, with automatic Light and Dark Mode. Dictation is available on iOS 26 where Apple's on-device speech model is supported. The `/mobile` web app remains an unsupported compatibility path, and Android is outside the first supported release. The app keeps one Podium design language while honoring iOS safe areas, system navigation, 44pt touch targets, accessibility settings, and reduced motion.)

## Users

The same solo operator as `apps/web` — a developer running multiple coding agents 24/7 on their own machines — but on their phone, away from the desk: on the couch, in transit, between meetings. Sessions are 30 seconds to a few minutes. One hand, glare, interruptions. A small team sharing an instance is secondary.

## Product Purpose

The phone is where parallel agent work keeps moving while the operator is away from the desktop. It opens on Work: the same issue-first operating picture as the desktop sidebar, with needs-human state visible on task and session rows. Decisions stay attached to their source — task questions on the task, transcript questions and offers in the session — while the app still makes it fast to start work and review evidence. Success: nothing sits waiting on the operator just because they left the desk, and navigation never becomes a second inbox to reconcile.

## Positioning

The same board, pocket-sized: see the work, follow its attention signal to the source, and answer there in under a minute from anywhere.

## Brand Personality

Identical to the desktop: fast, calm, precise, technical — a quiet cockpit. On the phone it leans even harder into glanceability: the answer to "does anything need me?" must be readable from the Work rows the moment the app opens.

## Anti-references

- The desktop app squeezed small: five-pane layouts crammed into 390px, hover-dependent affordances, dense tables that need pinch-zoom.
- AI-chat startup look: bubbly chat-first shells, sparkle icons, purple gradients.
- Notification-center soup: undifferentiated cards where a question, a review, and a status update all look the same weight.
- Web-in-a-frame: controls that ignore safe areas, system back, or the keyboard.

## Design Principles

1. **Work first, at phone scale.** The app opens on the issue-first Work list. Amber task and session signals answer "what needs me?" without inventing a separate mobile destination or count to reconcile.
2. **Decisions live at their source.** A task-level question is answerable on the task; an agent question or offer is answerable in its session transcript. Compact actions carry enough headline and evidence context to act on cold without turning navigation into a queue.
3. **Same state, same language.** Stages, issue colors, ID squares, agent-state grammar, and vocabulary mirror the desktop exactly; the phone is a different viewport, never a different product.
4. **Thumb and voice.** Primary actions live in thumb reach; composing a prompt favors dictation — big target, forgiving input, short required text.
5. **Calm speed.** Instant paint from the local replica, offline-safe writes, motion only as state.

## Accessibility & Inclusion

System appearance, Dynamic Type, VoiceOver semantics, 44pt targets, Reduce Motion, and native keyboard ownership are release requirements. Podium keeps its product vocabulary, issue colors, status meanings, and machine-data voice while iOS owns structural appearance and controls.
