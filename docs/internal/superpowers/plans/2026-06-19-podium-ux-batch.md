# Podium UX Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 13-item batch of Grok/Codex harness fixes, chat-view restyle + minimap fix + image input, sidebar WORK ITEMS restructure + repo reorder/sort, system theme mode, and native-default start screen.

**Architecture:** Correctness-critical logic is extracted into **pure, unit-tested functions** (session binding, title filtering, transcript classification, minimap geometry, work-item partitioning, repo sort, theme/mode resolution, panel-mode selection, upload GC), then wired into the existing React/relay/daemon code. Interactive UI (sidebar, chat, image input, native resize, scroll) is additionally verified at runtime in the Playwright harness — not just build + review.

**Tech Stack:** TypeScript, React 19, shadcn/ui-on-Base-UI + Tailwind v4 (`apps/web`), tRPC + WebSocket relay (`apps/server`, `apps/daemon`), xterm.js (`packages/terminal-client`), filesystem-observer harnesses (`packages/agent-bridge`), Zod settings (`packages/core`), Vitest, Playwright (`e2e/`).

## Global Constraints

- Test runner: `bun run test [path]` (Vitest, `--passWithNoTests`). Typecheck: `bun run typecheck`. Lint: `bun run lint` (Biome).
- Web logic tests: `apps/web/test/*.test.ts`. Package tests: co-located `*.test.ts`. Vitest aliases `@podium/*` to package `src` (see `vitest.config.ts`).
- Follow existing code style: 2-space indent, single quotes, no semicolons where Biome omits them, named exports. Match the surrounding file.
- Branch: `feat/ux-batch-2026-06-19` (already created; spec at `docs/superpowers/specs/2026-06-19-podium-ux-batch-design.md`).
- Reuse existing types: `TranscriptItem`, `TranscriptTag` (`@podium/protocol`), `SessionMeta`, `PodiumSettings` (`@podium/core`). Do not duplicate.
- Protocol/settings changes require deploying web + backend together; keep `normalizeSettings` migrations backward-compatible (parse old blobs without throwing).
- Commit after each task (frequent commits). Use the repo's commit trailer convention.

---

## Phase 1 — Harness bug fixes

### Task 1: Grok session binding (new chat ≠ old transcript)

**Files:**
- Create: `packages/agent-bridge/src/agent-state/grok-binding.ts`
- Create: `packages/agent-bridge/src/agent-state/grok-binding.test.ts`
- Modify: `packages/agent-bridge/src/agent-state/grok.ts` (use the helper in `findLatestGrokSessionPaths`/`observeGrokState`; persist the bound id)

**Interfaces:**
- Produces: `chooseGrokSessionDir(opts: { dirs: GrokDirInfo[]; watermarkMs: number; boundId?: string }): string | undefined` where `interface GrokDirInfo { id: string; createdMs: number; mtimeMs: number }`.
  - If `boundId` is set and present in `dirs`, return it (never re-bind).
  - Else return the `id` with the greatest `mtimeMs` among dirs with `createdMs >= watermarkMs`.
  - Else `undefined` (nothing fresh enough yet).

- [ ] **Step 1: Write the failing test** — `grok-binding.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { chooseGrokSessionDir } from './grok-binding'

const dirs = [
  { id: 'old', createdMs: 1_000, mtimeMs: 9_000 }, // pre-existing, still being written
  { id: 'new', createdMs: 5_000, mtimeMs: 6_000 },
]

describe('chooseGrokSessionDir', () => {
  it('binds the session created after the spawn watermark, not the freshest mtime', () => {
    expect(chooseGrokSessionDir({ dirs, watermarkMs: 4_000 })).toBe('new')
  })
  it('keeps an already-bound dir even when a newer dir appears', () => {
    expect(chooseGrokSessionDir({ dirs, watermarkMs: 4_000, boundId: 'old' })).toBe('old')
  })
  it('returns undefined when nothing is newer than the watermark', () => {
    expect(chooseGrokSessionDir({ dirs, watermarkMs: 99_000 })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `bun run test packages/agent-bridge/src/agent-state/grok-binding.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `grok-binding.ts`

```ts
export interface GrokDirInfo {
  id: string
  createdMs: number
  mtimeMs: number
}

/** Pick the Grok session dir to observe. Binds to the session created after the
 *  spawn watermark (not merely the freshest mtime, which an actively-written
 *  prior session would win), and never re-binds once a dir is chosen. */
export function chooseGrokSessionDir(opts: {
  dirs: GrokDirInfo[]
  watermarkMs: number
  boundId?: string
}): string | undefined {
  const { dirs, watermarkMs, boundId } = opts
  if (boundId && dirs.some((d) => d.id === boundId)) return boundId
  const fresh = dirs.filter((d) => d.createdMs >= watermarkMs)
  if (fresh.length === 0) return undefined
  return fresh.reduce((best, d) => (d.mtimeMs > best.mtimeMs ? d : best)).id
}
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Wire into `grok.ts`** — Read `packages/agent-bridge/src/agent-state/grok.ts:101-185`. Replace the mtime-only selection in `findLatestGrokSessionPaths` with `chooseGrokSessionDir`. Establish `watermarkMs` at observer start (`Date.now()` when the spawn begins; for reattach use the persisted bound id via `boundId`). Use the directory's birthtime (`fs.stat().birthtimeMs`, fall back to `ctimeMs`) for `createdMs`. Persist the resolved `sessionId` on the observer so subsequent polls pass it as `boundId`. Keep the existing `onSession` callback contract.

- [ ] **Step 6: Verify integration** — `bun run test packages/agent-bridge` and `bun run typecheck`. Manually reason through the two-session case in the diff.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "fix(grok): bind new session to its own transcript via spawn watermark"`

---

### Task 2: Grok title chatter — debounce + transient filter

**Files:**
- Create: `packages/agent-bridge/src/title-filter.ts`
- Create: `packages/agent-bridge/src/title-filter.test.ts`
- Modify: `apps/server/src/relay.ts` (title case ~L866–881: debounce + filter before broadcast)

**Interfaces:**
- Produces: `isTransientTitle(title: string): boolean` — true for empty/whitespace, titles containing C0/ANSI control or braille/spinner glyphs, or all-punctuation.
- Produces: `makeTitleDebouncer(emit: (t: string) => void, delayMs?: number): { push(t: string): void; flush(): void; dispose(): void }` — drops transient titles, emits only the last stable title after `delayMs` (default 500) of quiet; coalesces bursts.

- [ ] **Step 1: Write the failing test** — `title-filter.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { isTransientTitle, makeTitleDebouncer } from './title-filter'

describe('isTransientTitle', () => {
  it('flags spinner/braille and control-laden titles', () => {
    expect(isTransientTitle('⠋ thinking')).toBe(true)
    expect(isTransientTitle('\x1b[2K')).toBe(true)
    expect(isTransientTitle('   ')).toBe(true)
  })
  it('keeps a normal title', () => {
    expect(isTransientTitle('Fix the minimap bug')).toBe(false)
  })
})

describe('makeTitleDebouncer', () => {
  it('emits only the last stable title after the quiet window', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const d = makeTitleDebouncer((t) => seen.push(t), 500)
    d.push('⠋ working'); d.push('⠙ working'); d.push('Refactor parser')
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['Refactor parser'])
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `bun run test packages/agent-bridge/src/title-filter.test.ts`.

- [ ] **Step 3: Implement** — `title-filter.ts`

```ts
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const CONTROL = /[\x00-\x1f\x7f]/
const SPINNER = /[⠀-⣿⠠⠋⠹]|[|/\\\-]\s*$/ // braille + ascii spinner tails

export function isTransientTitle(title: string): boolean {
  const t = title.trim()
  if (t.length === 0) return true
  if (CONTROL.test(title)) return true
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true
  if (/[⠀-⣿]/.test(t)) return true
  return false
}

export function makeTitleDebouncer(
  emit: (t: string) => void,
  delayMs = 500,
): { push(t: string): void; flush(): void; dispose(): void } {
  let pending: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (pending !== undefined) emit(pending)
      timer = undefined
    }, delayMs)
  }
  return {
    push(t) {
      if (isTransientTitle(t)) return
      pending = t
      arm()
    },
    flush() {
      if (timer) clearTimeout(timer)
      if (pending !== undefined) emit(pending)
      timer = undefined
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**.

- [ ] **Step 5: Wire into relay** — Read `apps/server/src/relay.ts` around the `'title'` case. Hold one `makeTitleDebouncer` per session (Map keyed by sessionId), created lazily; `push` each incoming title; the debouncer's `emit` does the existing `sessionTitleChanged` broadcast. Dispose on session removal/disconnect. Keep the first real title snappy if desired by allowing `delayMs` small for the first emit (optional; default 500 is fine).

- [ ] **Step 6: Verify** — `bun run test packages/agent-bridge` + `bun run typecheck`. Confirm relay session-removal disposes the debouncer (no leak).

- [ ] **Step 7: Commit** — `fix(grok): debounce + filter transient agent titles`

---

### Task 3: Grok native view fills only top-left quarter on return

**Files:**
- Modify: `packages/terminal-client/src/terminal-view.ts:144-154` (`fit()`)
- Modify: `packages/terminal-client/src/session-mount.ts:123-128` (viewport-change → retry fit)
- Test (runtime): `e2e/` harness

**Interfaces:**
- `fit()` keeps its current return type but must not silently treat a zero/failed measurement as a successful fit.

- [ ] **Step 1: Read** `terminal-view.ts:140-160` and `session-mount.ts:110-160` and `dom-viewport.ts`.

- [ ] **Step 2: Implement fit-retry** — In `terminal-view.ts` `fit()`, detect a failed/zero measurement (FitAddon throw, or container `clientWidth/clientHeight === 0`, or computed cols/rows < 2) and signal it (return `undefined`/`false` rather than the stale grid). In `session-mount.ts`, on viewport-change/tab-show, call `fit()`; if it reports not-ready, schedule a `requestAnimationFrame` retry (cap ~10 frames / ~300ms) until it succeeds, then `sendResize()` and trigger the existing redraw nudge. Guard against overlapping retry loops.

- [ ] **Step 3: Unit-guard the readiness check if isolable** — if a pure `isFittable(el)` / `computeGrid` guard can be split out, add a small test in `terminal-view` test files asserting zero-size → not fittable. (Existing `viewport.test.ts` is the pattern.)

- [ ] **Step 4: Runtime verify** — Using the `e2e/` Playwright harness: open a Grok (or any) native pane, switch to another pane and back (and/or resize the window), then assert the xterm grid dimensions match the container (e.g. `term.cols`/`rows` consistent with `clientWidth/Height` ÷ cell size; no large empty region). Document the assertion in the test.

- [ ] **Step 5: Run** `bun run test packages/terminal-client` + `bun run typecheck`.

- [ ] **Step 6: Commit** — `fix(terminal): re-fit native view on tab return until container is measurable`

---

### Task 4: Codex transcript classification

**Files:**
- Create: `packages/agent-bridge/src/transcript/__fixtures__/codex-rollout.jsonl` (captured)
- Create: `packages/agent-bridge/src/transcript/codex.golden.test.ts`
- Modify: `packages/agent-bridge/src/transcript/codex.ts:12-98`

**Interfaces:**
- Keep `codexRecordToItems(record: unknown): TranscriptItem[]` signature; fix its behavior.

- [ ] **Step 1: Capture a real fixture** — From a live Codex session, copy a representative slice of `~/.codex/sessions/.../rollout*.jsonl` (a few user turns, assistant turns, a tool call + output, and any reasoning/encrypted records) into the fixture file. Redact any secrets. This is the source of truth — do not hand-invent record shapes.

- [ ] **Step 2: Write the golden test** — `codex.golden.test.ts` reads the fixture line-by-line through `codexRecordToItems`, flattens to `TranscriptItem[]`, and asserts the sequence of `{ role, toolName?, answer? }` plus that no user/assistant message is dropped and tool calls pair with results. Encode the *expected* array explicitly from a manual read of the fixture.

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codexRecordToItems } from './codex'

const lines = readFileSync(new URL('./__fixtures__/codex-rollout.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean)

describe('codexRecordToItems', () => {
  it('classifies the captured rollout without dropping messages', () => {
    const items = lines.flatMap((l) => codexRecordToItems(JSON.parse(l)))
    const shape = items.map((i) => ({ role: i.role, tool: i.toolName, answer: i.answer }))
    // EXPECTED — fill from a manual read of the fixture (no placeholders):
    expect(shape).toEqual([
      { role: 'user', tool: undefined, answer: undefined },
      { role: 'assistant', tool: undefined, answer: undefined },
      { role: 'tool', tool: 'shell', answer: undefined },
      // …complete this array from the real fixture…
    ])
  })
})
```

- [ ] **Step 3: Run to verify it fails** — `bun run test packages/agent-bridge/src/transcript/codex.golden.test.ts` (current parser drops/mislabels).

- [ ] **Step 4: Rework `codex.ts`** — Map `event_msg` user_message → user (clean text). For `response_item` of `ptype==='message'`, classify by the record's **actual** role (`user` and `assistant`, not assistant-only) and skip Codex-internal preamble markers explicitly (matched by content, not by silently dropping a whole role). Classify `function_call`/`function_call_output` as tool call/result with resilient id pairing (match on `call_id` || `id`; if unpaired, still emit the call and the orphan result rather than vanish). Skip reasoning/encrypted records explicitly. Keep `firstCodexPrompt`/`summarizeCodexHeadRecords` behavior.

- [ ] **Step 5: Run to verify it passes**; also `bun run test packages/agent-bridge` for regressions.

- [ ] **Step 6: Commit** — `fix(codex): correct transcript role classification + tool pairing`

---

### Task 5: Chat scroll — pin to bottom on reset/switch-in (Codex jumps)

**Files:**
- Modify: `apps/web/src/ChatView.tsx` (scroll effects ~L151-189; subscribe ~L76)
- Test: `apps/web/test/chat.test.ts` (extend) + runtime in `e2e/`

**Interfaces:**
- No new exports; behavior change in ChatView scroll effects.

- [ ] **Step 1: Read** `ChatView.tsx:150-210` and how `hub.subscribeTranscript` signals a reset (does it replace vs append? confirm in `store.tsx`/`SocketHub`). If a reset flag isn't surfaced to ChatView, thread one through (e.g. subscribe callback receives `(items, meta?: { reset?: boolean })`).

- [ ] **Step 2: Implement** —
  1. On a `reset:true` batch, set `pinnedToBottom.current = true`, `didInitialScroll.current = false` so the one-shot snap re-fires.
  2. Add a `ResizeObserver` on the stream element: while `pinnedToBottom.current`, re-pin to bottom on size growth (covers async markdown/code layout that currently causes jumps). Disconnect on unmount.
  3. Snap to bottom when the pane becomes visible/active if pinned (for the keep-mounted panel deck): observe an `isActive`/visibility prop or an `IntersectionObserver` on the scroller.

- [ ] **Step 3: Test** — Add a unit test in `chat.test.ts` for any extracted pure helper (e.g. `shouldPinOnReset`). Then runtime-verify in `e2e/`: load a session with a tall transcript, switch away and back, assert `scroller.scrollTop + clientHeight ≈ scrollHeight` (within the 80px threshold). Document the assertion.

- [ ] **Step 4: Run** `bun run test apps/web` + `bun run typecheck`.

- [ ] **Step 5: Commit** — `fix(chat): pin to bottom on transcript reset and pane switch-in`

---

## Phase 2 — Minimap

### Task 6: Minimap markers track real scroll position

**Files:**
- Modify: `apps/web/src/chat.ts` (`minimapSegments` ~L74-89 → DOM-offset based, or add `minimapTicksFromOffsets`)
- Modify: `apps/web/src/ChatView.tsx` `Minimap` (~L669-763)
- Test: `apps/web/test/chat.test.ts` (extend) + runtime in `e2e/`

**Interfaces:**
- Produces: `interface BlockOffset { index: number; top: number; height: number }` (ratios in [0,1]) and `measureBlockOffsets(scroller: HTMLElement): BlockOffset[]` reading `[data-block]` children (`offsetTop`/`offsetHeight ÷ scroller.scrollHeight`).
- `MinimapTick { index: number; role: TranscriptItem['role']; answer?: boolean; top: number; height: number }` built by zipping `blocks` metadata with measured offsets.

- [ ] **Step 1: Write the failing test** — pure mapping helper in `chat.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { ticksFromOffsets } from '../src/chat'

it('maps block offsets to linear tick ratios matching scroll space', () => {
  const blocks = [
    { item: { role: 'user', answer: false } },
    { item: { role: 'assistant', answer: true } },
  ] as any
  const offsets = [
    { index: 0, top: 0, height: 0.1 },
    { index: 1, top: 0.1, height: 0.9 },
  ]
  const ticks = ticksFromOffsets(blocks, offsets)
  expect(ticks[0]).toMatchObject({ role: 'user', top: 0, height: 0.1 })
  expect(ticks[1]).toMatchObject({ role: 'assistant', answer: true, top: 0.1 })
})
```

- [ ] **Step 2: Run to verify it fails**.

- [ ] **Step 3: Implement** `ticksFromOffsets(blocks, offsets): MinimapTick[]` in `chat.ts` (join by index; carry role/answer). Keep `minimapSegments` only if still used as a pre-measurement fallback; otherwise remove it and its tests.

- [ ] **Step 4: Run to verify it passes**.

- [ ] **Step 5: Wire `Minimap`** — Replace the log-weight rendering. Add a `measureBlockOffsets(scroller)` call inside the existing scroll/ResizeObserver effect (and when `blocks` change), store ticks in state. Render each tick absolutely positioned via `top`/`height` ratios (color by role/answer as today). The viewport box (`scrollTop/scrollHeight`) and `scrubTo` (`f * scrollHeight - clientHeight/2`) are already linear — now consistent with the ticks. Re-measure after layout (rAF) so first paint is correct.

- [ ] **Step 6: Runtime verify** — In `e2e/`: with a known transcript, read a user tick's `top`, click it, assert the corresponding `[data-block]` is centered in the viewport (`getBoundingClientRect` near the scroller center). Document the assertion.

- [ ] **Step 7: Run** `bun run test apps/web` + `bun run typecheck`. **Commit** — `fix(chat): minimap ticks/box/click share one DOM-offset scroll space`

---

## Phase 3 — Settings + PWA

### Task 7: "System" theme mode

**Files:**
- Modify: `apps/web/src/theme.tsx`
- Modify: `apps/web/index.html:4-28` (anti-flash script)
- Modify: `apps/web/src/SettingsView.tsx:431-480` (AppearanceSection)
- Test: `apps/web/test/theme.test.ts` (create)

**Interfaces:**
- `ThemeMode = 'light' | 'dark' | 'system'`.
- Produces: `resolveDark(mode: ThemeMode, prefersDark: boolean): boolean` — `system ? prefersDark : mode === 'dark'`.

- [ ] **Step 1: Write the failing test** — `theme.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { resolveDark } from '../src/theme'

describe('resolveDark', () => {
  it('follows the system preference in system mode', () => {
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
  })
  it('honors explicit light/dark regardless of system', () => {
    expect(resolveDark('dark', false)).toBe(true)
    expect(resolveDark('light', true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**.

- [ ] **Step 3: Implement** — Export `resolveDark`. Widen the stored mode type to include `'system'` (localStorage `podium.theme.mode`). In `ThemeProvider`, when mode is `system`, subscribe to `window.matchMedia('(prefers-color-scheme: dark)')` `change` and re-`applyTheme`; resolve `.dark` via `resolveDark`. Update `<meta name="theme-color">` from the resolved value. Clean up the listener when mode leaves `system` / on unmount.

- [ ] **Step 4: Run to verify it passes**.

- [ ] **Step 5: Anti-flash script** — Update `index.html` inline script to read the stored mode and, when `system` (or unset), use `matchMedia('(prefers-color-scheme: dark)').matches` to toggle `.dark` before mount.

- [ ] **Step 6: Settings UI** — AppearanceSection: make the mode control a 3-way Light / Dark / System group bound through `useTheme()`.

- [ ] **Step 7: Runtime verify (optional)** — `e2e/` with `page.emulateMedia({ colorScheme })`: set mode=System, flip the emulated scheme, assert `<html>` `.dark` toggles. **Commit** — `feat(theme): add System mode following prefers-color-scheme`

---

### Task 8: New agents start native by default (configurable)

**Files:**
- Modify: `packages/core/src/settings.ts` (`SessionDefaults` add `startScreen`)
- Modify: `packages/core/src/settings.test.ts` (extend)
- Create: `apps/web/test/panel-mode.test.ts`
- Modify: `apps/web/src/AgentPanel.tsx:43-70` (`initialMode`)
- Modify: `apps/web/src/SettingsView.tsx` (Sessions tab control)

**Interfaces:**
- `SessionDefaults.startScreen: 'native' | 'chat' | 'auto'` (default `'native'`).
- Produces: `initialPanelMode(a: { startScreen: 'native'|'chat'|'auto'; chatCapable: boolean; isMobile: boolean; saved?: 'native'|'chat' }): 'native'|'chat'`.
  - `saved` (per-session override) wins if set and `chatCapable`.
  - else `auto` → `isMobile ? 'chat' : 'native'`; `chat` → `'chat'` (if capable); `native` → `'native'`.
  - non-chat-capable always → `'native'`.

- [ ] **Step 1: Write failing tests** —

```ts
// settings.test.ts (extend)
it('defaults startScreen to native', () => {
  expect(normalizeSettings({}).sessionDefaults.startScreen).toBe('native')
})
// panel-mode.test.ts
import { describe, expect, it } from 'vitest'
import { initialPanelMode } from '../src/AgentPanel'
describe('initialPanelMode', () => {
  it('opens native by default', () =>
    expect(initialPanelMode({ startScreen: 'native', chatCapable: true, isMobile: false })).toBe('native'))
  it('auto uses device heuristic', () =>
    expect(initialPanelMode({ startScreen: 'auto', chatCapable: true, isMobile: true })).toBe('chat'))
  it('per-session saved override wins', () =>
    expect(initialPanelMode({ startScreen: 'native', chatCapable: true, isMobile: false, saved: 'chat' })).toBe('chat'))
  it('non-chat-capable forced native', () =>
    expect(initialPanelMode({ startScreen: 'chat', chatCapable: false, isMobile: true })).toBe('native'))
})
```

- [ ] **Step 2: Run to verify they fail**.

- [ ] **Step 3: Implement** — Add `startScreen` to `SessionDefaults` (Zod enum, default `'native'`); `normalizeSettings` carries it. Export `initialPanelMode` from `AgentPanel.tsx` and replace the inline `initialMode()` body with it, reading `settings.sessionDefaults.startScreen` from the store. Change the manual Native/Chat toggle persistence from the global `MODE_KEY` to a **per-session** key (e.g. `podium.panelMode.<sessionId>`), read as `saved`.

- [ ] **Step 4: Run to verify they pass**.

- [ ] **Step 5: Settings UI** — Sessions tab: add a "New session opens on" control (Native / Chat / Auto) bound to `sessionDefaults.startScreen`.

- [ ] **Step 6: Runtime verify** — `e2e/`: create a new agent, assert it mounts the native terminal (not ChatView). **Commit** — `feat(sessions): default new agents to native screen, configurable`

---

### Task 9: PWA leaves too much space at the bottom

**Files:**
- Modify: app shell layout (identify: `apps/web/src/App.tsx`/`Workspace.tsx`/`index.css`/`index.html`)
- Test: `apps/web/test/pwa.structure.test.ts` (extend)

- [ ] **Step 1: Diagnose** — Inspect the root/app-shell height + safe-area usage. Look for `100vh` (vs `100dvh`) on the shell and any bottom `env(safe-area-inset-bottom)` applied both globally and in the composer (double inset). Reproduce in the browser harness in `display-mode: standalone` (`e2e/` `page` with PWA emulation or inspect computed styles).

- [ ] **Step 2: Fix** — Use `100dvh` for the app shell height; apply `env(safe-area-inset-bottom)` exactly once (the composer already does at `ChatView.tsx:372`). Remove redundant bottom padding/min-height that manifests as empty space in standalone.

- [ ] **Step 3: Test** — Extend `pwa.structure.test.ts` to assert the shell uses `dvh` (or no stray bottom padding) per the existing test's static-assertion style.

- [ ] **Step 4: Runtime verify** — In `e2e/` standalone emulation, assert no large empty region below the composer (composer bottom ≈ viewport bottom minus the single safe-area inset). **Commit** — `fix(pwa): use dvh + single safe-area inset to remove bottom gap`

---

## Phase 4 — Sidebar / IA

### Task 10: Settings schema for sidebar sort/order

**Files:**
- Modify: `packages/core/src/settings.ts` (add `sidebar`)
- Modify: `packages/core/src/settings.test.ts`

**Interfaces:**
- `PodiumSettings.sidebar: { repoSort: 'alphabetical'|'lastUsed'|'custom'; repoOrder: string[] }` (defaults `lastUsed`, `[]`).

- [ ] **Step 1: Failing test** —

```ts
it('defaults sidebar sort to lastUsed with empty custom order', () => {
  const s = normalizeSettings({})
  expect(s.sidebar.repoSort).toBe('lastUsed')
  expect(s.sidebar.repoOrder).toEqual([])
})
```

- [ ] **Step 2: Run to verify it fails**.
- [ ] **Step 3: Implement** — Add the `sidebar` Zod object with defaults; ensure `normalizeSettings({})` and an old blob both parse.
- [ ] **Step 4: Run to verify it passes**. **Commit** — `feat(core): add sidebar repoSort/repoOrder settings`

---

### Task 11: Partition sessions into WORK ITEMS buckets

**Files:**
- Modify: `apps/web/src/derive.ts`
- Modify: `apps/web/test/derive.test.ts`

**Interfaces:**
- Produces: `partitionWorkItems(sessions: SessionMeta[], pinnedSessionIds: Set<string>): { attention: SessionMeta[]; working: SessionMeta[]; pinnedPanels: SessionMeta[] }`.
  - Pinned sessions → only `pinnedPanels` (never attention/working).
  - Unpinned: `attention` if waiting (needs-answer/permission) OR finished/idle OR errored/exited; else `working` if phase ∈ {working, compacting} (or `busy`); else excluded.
  - Precedence attention > working. Archived excluded.

- [ ] **Step 1: Read** `derive.ts` for the existing `SessionMeta` fields used (`agentState.phase`, `status`, `archived`, the existing chat-activity logic) so the bucket predicates match real values.

- [ ] **Step 2: Failing test** — `derive.test.ts`

```ts
import { partitionWorkItems } from '../src/derive'
it('partitions unpinned sessions and keeps pinned in pinnedPanels', () => {
  const s = (id, phase, status='live') => ({ sessionId: id, status, agentState: { phase } }) as any
  const sessions = [s('a','idle'), s('b','working'), s('c','awaiting-input'), s('p','working')]
  const { attention, working, pinnedPanels } = partitionWorkItems(sessions, new Set(['p']))
  expect(attention.map(x=>x.sessionId)).toEqual(['a','c'])
  expect(working.map(x=>x.sessionId)).toEqual(['b'])
  expect(pinnedPanels.map(x=>x.sessionId)).toEqual(['p'])
})
```

(Adjust phase literals to the real enum discovered in Step 1.)

- [ ] **Step 3: Run to verify it fails**.
- [ ] **Step 4: Implement** `partitionWorkItems` with predicates matching the real phase/status enums.
- [ ] **Step 5: Run to verify it passes**. **Commit** — `feat(sidebar): partition sessions into attention/working/pinned buckets`

---

### Task 12: Repo sort comparator

**Files:**
- Modify: `apps/web/src/derive.ts`
- Modify: `apps/web/test/derive.test.ts`

**Interfaces:**
- Produces: `sortRepos<T extends { id: string; name: string }>(repos: T[], mode: 'alphabetical'|'lastUsed'|'custom', order: string[], lastUsedAt: Map<string, number>): T[]`.
  - alphabetical: by `name` (locale, case-insensitive).
  - lastUsed: by `lastUsedAt` desc, unknown → 0 (end), tiebreak name.
  - custom: by index in `order`; ids not in `order` appended in lastUsed order.

- [ ] **Step 1: Failing test** —

```ts
import { sortRepos } from '../src/derive'
const r = (id) => ({ id, name: id.toUpperCase() })
it('sorts by mode', () => {
  const repos = [r('b'), r('a'), r('c')]
  const lu = new Map([['a',1],['b',3],['c',2]])
  expect(sortRepos(repos,'alphabetical',[],lu).map(x=>x.id)).toEqual(['a','b','c'])
  expect(sortRepos(repos,'lastUsed',[],lu).map(x=>x.id)).toEqual(['b','c','a'])
  expect(sortRepos(repos,'custom',['c','a'],lu).map(x=>x.id)).toEqual(['c','a','b'])
})
```

- [ ] **Step 2: Run to verify it fails**.
- [ ] **Step 3: Implement** `sortRepos`; derive `lastUsedAt` per repo from the most recent session activity across its worktrees (add a small helper if needed).
- [ ] **Step 4: Run to verify it passes**. **Commit** — `feat(sidebar): repo sort comparator (alpha/lastUsed/custom)`

---

### Task 13: Sidebar render restructure

**Files:**
- Modify: `apps/web/src/Sidebar.tsx`
- Modify: `apps/web/src/derive.ts` (`sidebarSections` to emit the new order)
- Test (runtime): `e2e/`

- [ ] **Step 1: Read** `Sidebar.tsx` fully + `sidebarSections` in `derive.ts`.

- [ ] **Step 2: Implement structure** (top→bottom):
  1. Top icon button bar: **add Search + Add-repo** buttons here (move from the WORKTREES header block at `Sidebar.tsx:122-145`).
  2. **WORK ITEMS** umbrella with: **NEEDS YOUR ATTENTION** (always expanded), **WORKING** (collapsible, default collapsed, header shows count e.g. `WORKING · {n}`, expand state in localStorage), **PINNED PANELS** (existing `PanelRow` list). Use `partitionWorkItems` (Task 11).
  3. **WORKTREES** header placed **above** **PINNED WORKTREES**, then pinned worktrees, then regular repos sorted via `sortRepos` (Task 12).
- [ ] **Step 3: Reuse** existing `PinnedSection`, `PanelRow`, `RepoBlock`, `WorktreeBlock` components; add a small collapsible wrapper for WORKING with a count badge.

- [ ] **Step 4: Runtime verify** — `e2e/`: assert section order, that WORKING starts collapsed showing a numeric count, expands on click, and that Search/Add-repo now live in the top bar and open their flows. Document assertions.

- [ ] **Step 5: Run** `bun run test apps/web` + `bun run typecheck`. **Commit** — `feat(sidebar): WORK ITEMS (attention/working/pinned) + WORKTREES header + top-bar search/add`

---

### Task 14: Repo drag-to-reorder + persistence

**Files:**
- Modify: `apps/web/src/Sidebar.tsx` (drag handlers + sort selector UI)
- Modify: `apps/web/src/store.tsx` (persist `sidebar` via settings set)
- Test (runtime): `e2e/`

- [ ] **Step 1: Sort selector UI** — small dropdown in the WORKTREES area bound to `settings.sidebar.repoSort`; changing it persists via the existing `trpc.settings.set` round-trip.

- [ ] **Step 2: Drag-reorder** — Make repo rows draggable (native HTML5 DnD: `draggable`, `onDragStart/Over/Drop`, compute the new id array). On drop: write `sidebar.repoOrder` and set `repoSort='custom'`, persist via settings set. Reorder is enabled in all modes but only rendered as the effective order in custom (per spec).

- [ ] **Step 3: Runtime verify** — `e2e/`: drag a repo above another, assert the order persists (reload/refetch) and the selector flipped to "custom". Document assertions.

- [ ] **Step 4: Run** `bun run test apps/web` + `bun run typecheck`. **Commit** — `feat(sidebar): drag-to-reorder repos, persists custom order`

---

## Phase 5 — Chat restyle

### Task 15: Chat view "transcript / document" restyle (Direction B)

**Files:**
- Modify: `apps/web/src/ChatView.tsx` (block rendering, composer chrome, search bar)
- Modify: `apps/web/src/index.css` (`.chat-md` and any chat tokens)
- Test (runtime): `e2e/` visual + behavior

- [ ] **Step 1: Implement Direction B** —
  - Full-width column (raise max-width from 760px to the wider document width from the mockup; keep readable line length for prose).
  - **Rails only on user + final Answer**: user message gets an accent left rail (use the session/identity color or blue), Answer (`item.answer`) gets a primary (amber) left rail; **intermediate assistant narration has no rail** and no border — just typeset prose. System/tool stay quiet (no rail).
  - Per-message header (role name, optional time), refined spacing/line-height.
  - Tool rows: quiet monospace collapsible (keep `ToolBlock` behavior), restyle to match.
  - Code blocks: window-bar + mono styling in `.chat-md`.
  - Restyle AskUserQuestionCard + activity badge to match the new look.
  - Preserve all behavior: search highlight/dim (`highlighted`/`dimmed`), pending bubbles, minimap, jump-to-bottom, composer actions.

- [ ] **Step 2: Behavior tests stay green** — `bun run test apps/web` (chat.test.ts etc.) + `bun run typecheck`.

- [ ] **Step 3: Runtime verify** — `e2e/` screenshot at desktop (≥1100px) and mobile (390px); assert: user + answer rows have a rail element, intermediate assistant rows do not; search still highlights; composer actions present. Capture a screenshot to share with the user for sign-off.

- [ ] **Step 4: Commit** — `feat(chat): transcript/document restyle with rails on user+answer only`

---

## Phase 6 — Image input

### Task 16: Image upload endpoint (web → daemon temp file → path)

**Files:**
- Modify: `apps/server/src/router.ts` (+ `relay.ts`) — `sessions.uploadImage`
- Modify: `apps/daemon/src/daemon.ts` — handle the upload message; write file; return path
- Modify: `packages/protocol/src/messages.ts` — upload request/response message(s)
- Test: unit for the path/dir builder; runtime for the round-trip

**Interfaces:**
- tRPC `sessions.uploadImage` input `{ sessionId: string; filename: string; mimeType: string; dataBase64: string } → { path: string }`.
- Daemon writes to `uploadDir(sessionId) = join(homedir(), '.podium', 'uploads', sessionId)`; file `= <uuid>.<ext-from-mime>`; returns the absolute path.
- Produces: `uploadFilePath(home: string, sessionId: string, id: string, mime: string): string` (pure, testable).

- [ ] **Step 1: Failing test** (pure path builder) — assert extension mapping (`image/png`→`.png`, `image/jpeg`→`.jpg`, fallback `.bin`) and that the path is under `~/.podium/uploads/<sessionId>/`.

- [ ] **Step 2: Run to verify it fails**.
- [ ] **Step 3: Implement** the path builder + protocol message + relay routing to the owning daemon (mirror the `input` routing) + daemon-side `mkdir -p` and `writeFile` (decode base64), returning the path. Route the tRPC response back through the relay.
- [ ] **Step 4: Runtime verify** — exercise the mutation against a live local session; assert the file exists on the daemon host and the returned path is absolute. **Commit** — `feat(chat): image upload endpoint writing to ~/.podium/uploads`

---

### Task 17: Upload GC (cleanup)

**Files:**
- Create: `apps/daemon/src/uploads-gc.ts` + `uploads-gc.test.ts`
- Modify: `apps/daemon/src/daemon.ts` (schedule sweep; remove dir on session close)

**Interfaces:**
- Produces: `uploadsToGc(files: { path: string; mtimeMs: number }[], nowMs: number, ttlMs: number): string[]` (returns paths older than ttl).

- [ ] **Step 1: Failing test** —

```ts
import { describe, expect, it } from 'vitest'
import { uploadsToGc } from './uploads-gc'
it('collects files older than the ttl', () => {
  const now = 1_000_000
  const files = [{ path: 'a', mtimeMs: now - 1000 }, { path: 'b', mtimeMs: now - 90_000_000 }]
  expect(uploadsToGc(files, now, 24*3600_000)).toEqual(['b'])
})
```

- [ ] **Step 2: Run to verify it fails**.
- [ ] **Step 3: Implement** `uploadsToGc`; in `daemon.ts` schedule a periodic sweep (e.g. hourly) over `~/.podium/uploads/**` deleting returned paths, and delete a session's upload dir when the session is removed/closed. TTL 24h.
- [ ] **Step 4: Run to verify it passes**. **Commit** — `feat(chat): GC uploaded images by ttl + on session close`

---

### Task 18: Composer image UX (picker, paste, drag-drop, dropzone, thumbnails)

**Files:**
- Modify: `apps/web/src/ChatView.tsx` (composer)
- Modify: `apps/web/src/store.tsx` if a `uploadImage` wrapper is needed
- Test (runtime): `e2e/`

**Interfaces:**
- Consumes: `trpc.sessions.uploadImage` (Task 16).
- Local composer state: `attachments: { id: string; name: string; previewUrl: string; path?: string; state: 'uploading'|'ready'|'failed' }[]`.

- [ ] **Step 1: Implement** —
  - Enable the attach button (`ChatView.tsx:398-407`): hidden `<input type="file" accept="image/*" multiple>`; on select, add attachments, upload each (Task 16), store returned `path`, show a thumbnail chip with remove (×).
  - **Paste**: `onPaste` on the textarea — if clipboard has image items, upload them as attachments (don't insert into text).
  - **Drag-drop**: `onDragOver/Leave/Drop` on the composer; while dragging an image over it, show the **dropzone overlay** (matches mockup C: dashed primary border, "Drop image to attach").
  - **Send**: in `send()`, if there are ready attachments, prepend their absolute paths to the text (newline-separated) so path-reading agents (Claude Code) resolve them; tag the optimistic/echoed user item with `TranscriptTag { kind: 'image', label: name }`. Best-effort: where a native image-paste passthrough is known to work, prefer it; otherwise the path is authoritative. Clear attachments after send.
- [ ] **Step 2: Behavior** — disable send while any attachment is `uploading`; allow text-only send as before.
- [ ] **Step 3: Runtime verify** — `e2e/`: (a) simulate a file drop, assert the dropzone overlay appears during drag and a chip after drop; (b) assert the sent prompt text contains the upload path; (c) paste an image, assert a chip appears. Document assertions. Confirm a real image is read by a live Claude Code session.
- [ ] **Step 4: Run** `bun run test apps/web` + `bun run typecheck`. **Commit** — `feat(chat): image input via picker/paste/drag-drop with dropzone + path delivery`

---

## Final verification (after all phases)

- [ ] `bun run test` (full suite) — all green.
- [ ] `bun run typecheck` — clean.
- [ ] `bun run lint` — clean.
- [ ] Runtime smoke in `e2e/` covering: sidebar structure + reorder, chat restyle + minimap click + scroll-pin, image drag-drop, System theme, native-default new agent.
- [ ] Use `superpowers:requesting-code-review` before integrating.
- [ ] Integrate via `superpowers:finishing-a-development-branch` (do NOT auto-merge — the user manages merges; offer options).
