# Product

## Register

product

## Platform

web

(This file governs `apps/web` and the Tauri desktop app, which is a thin wrapper around the same web dist with minor extra functionality. `apps/mobile` is a separate React Native app with its own components and UX concept — it gets its own PRODUCT.md when design work starts there.)

## Users

A developer running multiple coding agents at once, self-hosting Podium on their own machines. Solo operator first: deep work at a desktop between check-ins, and a phone used to glance at the board, answer an agent's question, or kick off the next task. A small team sharing one instance and one board is the secondary audience — multi-user must stay legible, but the design optimizes for the solo operator.

## Product Purpose

Podium is an IDE for getting more done with coding agents. It increases the number of simultaneous tasks the operator can tackle without going mad, and runs agents for them 24/7 — locally, on a VPS, or in the cloud — even while they sleep. Success looks like an operator confidently juggling more parallel agent work than they could hold in their head, because the UI holds it for them.

## Positioning

The agent IDE that multiplies your parallel throughput: native agents in real PTYs (no abstraction tax), a best-in-class UI that controls your attention, and a context layer — CLI, agent-to-agent messaging, a shared task system — that lets agents know and do everything themselves, on your machines or in the cloud.

## Brand Personality

Fast, calm, precise, technical. A quiet cockpit with terminal-native confidence: dense and exact, keyboard-fast, with restrained signs of life (working dots, live rails) that never shout. Reference: Linear — crisp density, instant interactions, opinionated defaults.

## Anti-references

- SaaS dashboard cliché: metric-card grids, gradient accents, marketing gloss inside the product.
- AI-chat startup look: bubbly chat-first layouts, sparkle icons, purple gradients, mascot energy.
- Enterprise DevOps console: Jenkins/Grafana-style utilitarian sprawl, cluttered toolbars, inconsistent panels.
- Electron-app blandness: generic cross-platform chrome that feels like a website in a frame, not a tool.

## Design Principles

1. **Guard the operator's attention.** The UI's job is triage: surface the agent that needs you, quiet everything that doesn't. Attention is the scarce resource the product exists to multiply.
2. **Earned familiarity, Linear-grade craft.** Instant interactions, crisp density, opinionated defaults. The tool disappears into the task; strangeness needs a purpose.
3. **Native agents, no veneer.** Real CLIs in real PTYs are the product's honesty — the UI frames the terminal, it never fakes or abstracts it.
4. **Same state, any distance.** Desktop deep work and a phone check-in read the same board the same way; glanceability is a feature, not a mobile fallback.
5. **Calm speed.** Fast means no waiting and no choreography — motion conveys state, never decoration.

## Accessibility & Inclusion

Best effort, no formal WCAG target: readable contrast and keyboard basics throughout; dense terminal surfaces are exempt from formal auditing.
