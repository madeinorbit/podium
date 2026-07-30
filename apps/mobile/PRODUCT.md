# Product

## Register

product

## Platform

adaptive

(One Expo/React Native codebase. Today it ships as the phone web app served at `/mobile` (PWA focus); native iOS/Android store builds are expected later. It renders one Podium design language on both platforms while honoring each OS's guarantees: safe areas, system back, 44/48pt touch targets, reduced motion.)

## Users

The same solo operator as `apps/web` — a developer running multiple coding agents 24/7 on their own machines — but on their phone, away from the desk: on the couch, in transit, between meetings. Sessions are 30 seconds to a few minutes. One hand, glare, interruptions. A small team sharing an instance is secondary.

## Product Purpose

The phone is where parallel agent work keeps moving while the operator is away from the desktop. The app's job, in priority order: (1) decide & unblock — answer agent questions, judge offers (merge, send back), see what's blocked; (2) fire off work — start a task or session, speak or type a short prompt; (3) review evidence — artifacts, session activity, the task board. Success: nothing sits waiting on the operator just because they left the desk.

## Positioning

The same board, pocket-sized: every decision an agent is waiting on, answerable in under a minute from anywhere — with the full power to start the next piece of work.

## Brand Personality

Identical to the desktop: fast, calm, precise, technical — a quiet cockpit. On the phone it leans even harder into glanceability: the answer to "does anything need me?" must be readable from the lock-screen moment the app opens.

## Anti-references

- The desktop app squeezed small: five-pane layouts crammed into 390px, hover-dependent affordances, dense tables that need pinch-zoom.
- AI-chat startup look: bubbly chat-first shells, sparkle icons, purple gradients.
- Notification-center soup: undifferentiated cards where a question, a review, and a status update all look the same weight.
- Web-in-a-frame: controls that ignore safe areas, system back, or the keyboard.

## Design Principles

1. **Attention first, at phone scale.** The first screen is the triage stack: what needs you, ranked. Everything else is one tap deeper.
2. **Every card is decidable.** A question, offer, or review card carries enough evidence (headline, one-line stance, artifact thumbnail) to act on cold, in five seconds — actions inline, never buried in a detail screen.
3. **Same state, same language.** Stages, issue colors, ID squares, agent-state grammar, and vocabulary mirror the desktop exactly; the phone is a different viewport, never a different product.
4. **Thumb and voice.** Primary actions live in thumb reach; composing a prompt favors dictation — big target, forgiving input, short required text.
5. **Calm speed.** Instant paint from the local replica, offline-safe writes, motion only as state.

## Accessibility & Inclusion

Best effort, matching the desktop: readable contrast, 44pt+ touch targets, honor platform reduced-motion and system font scaling where feasible.
