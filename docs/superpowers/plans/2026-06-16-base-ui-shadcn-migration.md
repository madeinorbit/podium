# Base UI + shadcn/ui + Tailwind v4 Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Podium web's handcrafted `styles.css` UI (modals, menus, tooltip, tabs, form controls, buttons, badges, toast) with shadcn/ui on Base UI primitives, styled with Tailwind v4, and add a 4-theme system (shadcn-zinc + podium presets × light/dark).

**Architecture:** Tailwind v4 via `@tailwindcss/vite`; shadcn components generated with `--base base` (Base UI, package `@base-ui/react` — verified resolves to 1.5.0) into `src/components/ui/`. Theme = `data-theme` attribute (`podium` or absent=shadcn) + `.dark` class on `<html>`, two independent axes, driven by a small `ThemeProvider` (localStorage-persisted, anti-flash inline script, PWA theme-color sync). Legacy `styles.css` coexists and is retired view-by-view.

**Tech Stack:** React 19, Vite 8 (Rolldown), bun, Tailwind v4, `@base-ui/react` ^1.5, shadcn CLI, `clsx`/`tailwind-merge`/`class-variance-authority`/`tw-animate-css`, lucide-react, vitest+happy-dom (unit).

**Spec:** `docs/superpowers/specs/2026-06-16-base-ui-shadcn-migration-design.md`

**Working dir:** all paths relative to `apps/web/` unless noted. The session cannot `cd` into the worktree, so run each Bash call as `cd /home/user/src/other/podium/.claude/worktrees/base-ui-shadcn-migration/apps/web && <cmd>`, and pass absolute paths to Write/Edit.

### Standing verification (run after every task's final step)
```bash
bun run typecheck && bun run build
```
Both must exit 0. Commit only when green. (Unit tests use a separate command — see Task 7. Automated Playwright is NOT wired into apps/web; interactive verification is **manual on the dev host** — see Task 21.)

### Critical environment facts (verified, do not skip)
- The worktree lives under `.claude/worktrees/`, and the **root `vitest.config.ts` excludes `**/.claude/**`** — so the naive `bunx vitest` is a silent no-op (skips all tests, reports green). Unit tests MUST run via the web-local config created in Task 7.
- `@base-ui/react` resolves to **1.5.0**; the old `@base-ui-components/react` is stuck at `1.0.0-rc.0` (deprecated). Use the new name.
- `@vitejs/plugin-react` is absent today; JSX is transformed by Vite's default esbuild (tsconfig `jsx: react-jsx`). Adding the plugin moves JSX + Fast Refresh under it — verify HMR/build still work (Task 3).
- **Generated-component reality > this plan:** after each `shadcn add`, open the generated file in `src/components/ui/` and read its actual named exports/props before wiring it. The notes below reflect the shadcn `--base base` registry as of 2026-06 but the generated file is the source of truth.

---

## Phase 1 — Foundation (zero visual change)

### Task 1: Add dependencies

**Files:** Modify `apps/web/package.json`, `bun.lock` (via bun add)

- [ ] **Step 1: Pre-flight — confirm the Base UI package name resolves**
```bash
bun pm view @base-ui/react version
```
Expected: prints `1.5.0` (or newer 1.x). If it 404s, STOP and fall back to `@base-ui-components/react@latest`, and tell shadcn init (Task 4) to target that name.

- [ ] **Step 2: Add runtime + dev deps (pin Base UI to ^1.5)**
```bash
bun add @base-ui/react@^1.5 clsx tailwind-merge class-variance-authority
bun add -d @vitejs/plugin-react tailwindcss @tailwindcss/vite tw-animate-css
```
(`lucide-react` already present — do not re-add. NOT `tailwindcss-animate` — deprecated under v4.)

- [ ] **Step 3: Verify install**
```bash
bun pm ls | grep -E "base-ui|tailwindcss|@tailwindcss/vite|class-variance|tw-animate|plugin-react"
```
Expected: all listed; `@base-ui/react` at 1.5.x.

- [ ] **Step 4: Commit**
```bash
git add apps/web/package.json ../../bun.lock && git commit -m "build(web): add tailwind v4, base-ui, shadcn helper deps"
```

### Task 2: Wire the `@/` alias (required before shadcn init)

**Files:** Modify `apps/web/tsconfig.json`, `apps/web/vite.config.ts`

- [ ] **Step 1: tsconfig — add the alias** (replace the whole file). NOTE: do NOT add `baseUrl` — TypeScript 6.0 (this repo) deprecates it (`TS5101`); `paths` resolve relative to the tsconfig dir without it:
```json
{
  "extends": "../../tooling/tsconfig/react.json",
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 2: vite — add `@` as the first alias** (keep the two `@podium/*` aliases + `conditions` exactly):
```ts
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@podium/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
      '@podium/terminal-client': fileURLToPath(
        new URL('../../packages/terminal-client/src/index.ts', import.meta.url),
      ),
    },
```

- [ ] **Step 3: Verify + commit**
```bash
bun run typecheck && git add apps/web/tsconfig.json apps/web/vite.config.ts && git commit -m "build(web): add @/ path alias in tsconfig + vite"
```

### Task 3: Add the React + Tailwind Vite plugins

**Files:** Modify `apps/web/vite.config.ts` (imports after line 3; the `plugins: [` array, currently containing only `VitePWA({...})`)

- [ ] **Step 1: Add imports** (after the existing `import { VitePWA } ...`):
```ts
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
```

- [ ] **Step 2: Prepend the plugins** — change the array from `plugins: [ VitePWA({...}) ]` to:
```ts
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({ /* unchanged */ }),
  ],
```

- [ ] **Step 3: Verify build (Rolldown canary)**
```bash
bun run build
```
Expected: exit 0. RISK: `@vitejs/plugin-react` now owns JSX + Fast Refresh; if Rolldown double-transforms JSX or the plugin is incompatible with Vite 8/Rolldown, this is where it surfaces (spec §13). If it breaks, try `@vitejs/plugin-react-swc` or pin Vite; record the outcome in the commit.

- [ ] **Step 4: Commit**
```bash
git add apps/web/vite.config.ts && git commit -m "build(web): register @vitejs/plugin-react + @tailwindcss/vite"
```

### Task 4: Initialize shadcn (Base UI variant)

**Files:** Create `apps/web/components.json`, `apps/web/src/lib/utils.ts`, `apps/web/src/index.css`; Modify `apps/web/src/main.tsx`

- [ ] **Step 1: Create the Tailwind entry BEFORE init** — `apps/web/src/index.css`:
```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));
```

- [ ] **Step 2: Import it first in `main.tsx`** (above the legacy stylesheet — legacy must win during migration):
```ts
import './index.css'
import './styles.css'
```

- [ ] **Step 3: Discover the exact init flags first** (init is interactive; don't let a subagent hang):
```bash
bunx shadcn@latest init --help
```
Confirm the Base UI selector flag (expected `--base base`; if the help shows a different spelling, use that).

- [ ] **Step 4: Run init**
```bash
bunx shadcn@latest init --base base
```
Answer prompts: base color = **zinc**; CSS variables = **yes**; CSS file = **src/index.css**; components alias = **@/components**, utils = **@/lib/utils**; icon library = **lucide**. If it asks to **overwrite src/index.css**, answer **yes**, then re-open the file and confirm the `@import "tailwindcss"`, `@import "tw-animate-css"`, and `@custom-variant dark` lines from Step 1 are still present — **re-add them at the top if init stripped them**.

- [ ] **Step 5: Verify init output**
```bash
cat components.json && grep -nE ':root|\.dark|@theme' src/index.css && cat src/lib/utils.ts
```
Expected: `components.json` has `iconLibrary: lucide`, `cssVariables: true`, zinc base; `index.css` now has `:root{…}`, `.dark{…}`, `@theme inline{…}`; `utils.ts` exports `cn()`.

- [ ] **Step 6: Verify build (unchanged visuals — no components mounted, legacy CSS still drives all visuals)**
```bash
bun run build
```

- [ ] **Step 7: Commit**
```bash
git add apps/web/components.json apps/web/src/lib/utils.ts apps/web/src/index.css apps/web/src/main.tsx apps/web/package.json ../../bun.lock && git commit -m "feat(web): init shadcn/ui with Base UI primitives + tailwind v4 entry"
```

### Task 5: App-root style isolation for Base UI portals

**Files:** Modify `apps/web/src/styles.css` (the existing `#root` rule — currently `#root { height: 100%; margin: 0; }`)

- [ ] **Step 1: Amend the existing `#root` rule in place** (do NOT add a second `#root` block) — make it:
```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}
#root {
  isolation: isolate;
}
```
(The `html, body, #root` rule already exists; add the separate single-purpose `#root { isolation: isolate; }` right after it. Base UI portals popups to `document.body`; this root stacking context makes them layer correctly without per-component z-index.)

- [ ] **Step 2: Verify + commit**
```bash
bun run build && git add apps/web/src/styles.css && git commit -m "feat(web): isolate app root stacking context for base-ui portals"
```

---

## Phase 2 — Theme system (4 themes)

### Task 6: Semantic-extra tokens + podium preset blocks

**Files:** Modify `apps/web/src/index.css`

Podium-dark reuses today's EXACT hex (pixel-match). Podium-light is derived. shadcn-zinc light/dark were written by `init`. Add `--success`/`--warning` (Podium extras) to every preset.

- [ ] **Step 1: Add success/warning to the shadcn (default) presets** — append to the existing `:root { … }`:
```css
  --success: oklch(0.6 0.13 163);
  --warning: oklch(0.78 0.16 70);
```
and to the existing `.dark { … }`:
```css
  --success: oklch(0.7 0.15 162);
  --warning: oklch(0.83 0.16 82);
```

- [ ] **Step 2: Append podium-dark (today's palette, literal hex)** after the `.dark` block:
```css
/* Podium preset — dark = today's exact palette */
[data-theme="podium"].dark {
  --radius: 0.375rem;
  --background: #0e0e12;            /* --app */
  --foreground: #d7d7e0;            /* --fg */
  --card: #16161c;                 /* --panel */
  --card-foreground: #d7d7e0;
  --popover: #16161c;
  --popover-foreground: #d7d7e0;
  --primary: #f59e0b;              /* amber --accent */
  --primary-foreground: #0e0e12;
  --secondary: #25252f;            /* --surface */
  --secondary-foreground: #f3f3f8; /* --fg-bright */
  --muted: #1d1d25;               /* --panel-raised */
  --muted-foreground: #9a9aa8;    /* --dim */
  --accent: #25252f;              /* shadcn hover bg = --surface */
  --accent-foreground: #f3f3f8;
  --destructive: #f87171;         /* --danger */
  --destructive-foreground: #0e0e12;
  --border: #2a2a34;
  --input: #2a2a34;
  --ring: #f59e0b;
  --success: #34d399;
  --warning: #fbbf24;
}
```

- [ ] **Step 3: Append podium-light (derived)**:
```css
/* Podium preset — light (derived) */
[data-theme="podium"] {
  --radius: 0.375rem;
  --background: #f7f7f9;
  --foreground: #1a1a22;
  --card: #ffffff;
  --card-foreground: #1a1a22;
  --popover: #ffffff;
  --popover-foreground: #1a1a22;
  --primary: #d97706;
  --primary-foreground: #ffffff;
  --secondary: #ececf0;
  --secondary-foreground: #1a1a22;
  --muted: #ececf0;
  --muted-foreground: #5a5a66;
  --accent: #e4e4ea;
  --accent-foreground: #1a1a22;
  --destructive: #dc2626;
  --destructive-foreground: #ffffff;
  --border: #e2e2e8;
  --input: #e2e2e8;
  --ring: #d97706;
  --success: #059669;
  --warning: #d97706;
}
```

- [ ] **Step 4: Map the extras once in `@theme inline`** — inside the existing block:
```css
  --color-success: var(--success);
  --color-warning: var(--warning);
```

- [ ] **Step 5: Verify + commit**
```bash
bun run build && git add apps/web/src/index.css && git commit -m "feat(web): podium light/dark presets + success/warning tokens"
```

### Task 7: ThemeProvider + persistence + theme-color (unit-tested)

**Files:** Create `apps/web/src/theme.tsx`, `apps/web/src/theme.test.ts`, `apps/web/vitest.config.ts`; Modify `apps/web/package.json` (add script), `apps/web/src/main.tsx`

- [ ] **Step 1: Create the web-local vitest config** (the root config excludes `.claude/**`, so we need our own) — `apps/web/vitest.config.ts`:
```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
})
```

- [ ] **Step 2: Add a `test:unit` script** to `apps/web/package.json` `scripts`:
```json
    "test:unit": "vitest --config vitest.config.ts run",
```

- [ ] **Step 3: Write the failing test** — `apps/web/src/theme.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, readStoredTheme, THEME_MODE_KEY, THEME_PRESET_KEY } from './theme'

afterEach(() => localStorage.clear())

describe('readStoredTheme', () => {
  it('defaults to podium/dark when nothing stored', () => {
    expect(readStoredTheme()).toEqual({ preset: 'podium', mode: 'dark' })
  })
  it('reads stored valid values', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'shadcn')
    localStorage.setItem(THEME_MODE_KEY, 'light')
    expect(readStoredTheme()).toEqual({ preset: 'shadcn', mode: 'light' })
  })
  it('falls back on garbage', () => {
    localStorage.setItem(THEME_PRESET_KEY, 'bogus')
    expect(readStoredTheme().preset).toBe('podium')
  })
})

describe('applyTheme', () => {
  it('sets data-theme for podium, removes for shadcn, toggles dark', () => {
    const el = document.createElement('html')
    applyTheme({ preset: 'podium', mode: 'dark' }, el)
    expect(el.getAttribute('data-theme')).toBe('podium')
    expect(el.classList.contains('dark')).toBe(true)
    applyTheme({ preset: 'shadcn', mode: 'light' }, el)
    expect(el.getAttribute('data-theme')).toBe(null)
    expect(el.classList.contains('dark')).toBe(false)
  })
})
```

- [ ] **Step 4: Run it; expect FAIL (cannot resolve `./theme`)**
```bash
bun run test:unit
```
Expected: FAIL — the suite errors importing `./theme`. (If instead it says "No test files found / passWithNoTests", the config is wrong — fix before continuing; a green here is a false green.)

- [ ] **Step 5: Implement `apps/web/src/theme.tsx`**
```tsx
import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'

export type ThemePreset = 'shadcn' | 'podium'
export type ThemeMode = 'light' | 'dark'
export interface ThemeState {
  preset: ThemePreset
  mode: ThemeMode
}

export const THEME_PRESET_KEY = 'podium.theme.preset'
export const THEME_MODE_KEY = 'podium.theme.mode'

// PWA status-bar / address-bar tint per theme (must mirror the --background of each
// preset/mode block in index.css; the anti-flash script in index.html duplicates these).
export const THEME_BG: Record<string, string> = {
  'podium-dark': '#0e0e12',
  'podium-light': '#f7f7f9',
  'shadcn-dark': '#09090b',
  'shadcn-light': '#ffffff',
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // best-effort
  }
}

export function readStoredTheme(): ThemeState {
  const p = lsGet(THEME_PRESET_KEY)
  const m = lsGet(THEME_MODE_KEY)
  return {
    preset: p === 'shadcn' || p === 'podium' ? p : 'podium',
    mode: m === 'light' || m === 'dark' ? m : 'dark',
  }
}

export function applyTheme(state: ThemeState, root: HTMLElement): void {
  if (state.preset === 'podium') root.setAttribute('data-theme', 'podium')
  else root.removeAttribute('data-theme')
  root.classList.toggle('dark', state.mode === 'dark')
}

interface ThemeContextValue extends ThemeState {
  setPreset: (preset: ThemePreset) => void
  setMode: (mode: ThemeMode) => void
}
const Ctx = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<ThemeState>(readStoredTheme)
  useEffect(() => {
    applyTheme(state, document.documentElement)
    lsSet(THEME_PRESET_KEY, state.preset)
    lsSet(THEME_MODE_KEY, state.mode)
    const meta = document.querySelector('meta[name="theme-color"]')
    const bg = THEME_BG[`${state.preset}-${state.mode}`]
    if (meta && bg) meta.setAttribute('content', bg)
  }, [state])
  const value: ThemeContextValue = {
    ...state,
    setPreset: (preset) => setState((s) => ({ ...s, preset })),
    setMode: (mode) => setState((s) => ({ ...s, mode })),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}
```

- [ ] **Step 6: Run the test; expect PASS**
```bash
bun run test:unit
```
Expected: PASS — 4 tests across 2 suites.

- [ ] **Step 7: Mount the provider above AppShell** in `apps/web/src/main.tsx`:
```tsx
import { ThemeProvider } from './theme'
// …
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  </StrictMode>,
)
```
(Everything in AppShell — including its top-level fragment — is now inside ThemeProvider, so `useTheme()` resolves there. This matters for Toaster in Task 18.)

- [ ] **Step 8: Verify + commit**
```bash
bun run typecheck && bun run test:unit && bun run build && git add apps/web/src/theme.tsx apps/web/src/theme.test.ts apps/web/vitest.config.ts apps/web/package.json apps/web/src/main.tsx && git commit -m "feat(web): ThemeProvider (persisted, theme-color sync) + unit tests"
```

### Task 8: Anti-flash inline script (+ theme-color)

**Files:** Modify `apps/web/index.html` (the `<head>`, before any stylesheet/module)

- [ ] **Step 1: Insert as the first child of `<head>`**:
```html
<script>
  (function () {
    try {
      var BG = { 'podium-dark': '#0e0e12', 'podium-light': '#f7f7f9', 'shadcn-dark': '#09090b', 'shadcn-light': '#ffffff' }
      var p = localStorage.getItem('podium.theme.preset')
      var m = localStorage.getItem('podium.theme.mode')
      var preset = p === 'shadcn' || p === 'podium' ? p : 'podium'
      var mode = m === 'light' || m === 'dark' ? m : 'dark'
      var el = document.documentElement
      if (preset === 'podium') el.setAttribute('data-theme', 'podium')
      else el.removeAttribute('data-theme')
      el.classList.toggle('dark', mode === 'dark')
      var meta = document.querySelector('meta[name="theme-color"]')
      if (meta && BG[preset + '-' + mode]) meta.setAttribute('content', BG[preset + '-' + mode])
    } catch (e) {}
  })()
</script>
```
(Keys/values mirror `theme.tsx` exactly. Runs before React → stored theme paints on the first frame.)

- [ ] **Step 2: Verify + commit**
```bash
bun run build && git add apps/web/index.html && git commit -m "feat(web): anti-flash inline theme + theme-color script"
```

> **Task 9 (Appearance switcher) is defined in Phase 3** because it needs the shadcn Button (Task 10). It is listed there.

---

## Phase 3 — Primitives (adopt in place)

For each: generate → open the generated file and confirm its named exports/props → replace custom markup → delete the now-dead CSS → standing verify → commit.

### Task 10: Button

**Files:** Create `apps/web/src/components/ui/button.tsx`; Modify many call sites.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add button` ; then `grep -n "export" src/components/ui/button.tsx` to confirm it exports `Button` + `buttonVariants`.

- [ ] **Step 2: Variant mapping (apply consistently)**
  - primary action (`.repo-picker-add`) → `<Button>` (default)
  - `.repo-picker-secondary` → `<Button variant="secondary">`
  - icon-only (`.icon-button`, `.sidebar-tool`, `.tab-add`, `.pin-button`) → `<Button variant="ghost" size="icon">`
  - text+icon toolbar → `<Button variant="ghost" size="sm">`
  - destructive (kill session) → `<Button variant="destructive">`

- [ ] **Step 3: Exemplar — RepoPickerModal toolbar** — replace each `<button className="icon-button"…>` / `repo-picker-*` with `<Button …>`, keeping `onClick`/`disabled`/`aria-label`/`title` and the lucide icon child. E.g.:
```tsx
import { Button } from '@/components/ui/button'
<Button variant="ghost" size="icon" disabled={!listing || busy}
  onClick={() => listing && void load(listing.homePath)} aria-label="Home" title="Home">
  <Home size={16} />
</Button>
```

- [ ] **Step 4: Migrate remaining button sites** across `Sidebar.tsx`, `Workspace.tsx`, `HomeView.tsx`, `AgentPanel.tsx`, `SettingsView.tsx`, `NewPanelMenu.tsx`, `SearchView.tsx`, `HostMemoryView.tsx`, `HostIndicators.tsx`, `UsageView.tsx`, `OnboardingWizard.tsx`, `RepoScanResults.tsx`, `RepoScanFlow.tsx`. **Exclude** the mobile key-bar buttons in `MobileApp.tsx`/`AgentPanel.tsx` toolbar (`.key-act`, `.arrow-pad`, `.key-mic`) — those stay custom (Phase 7 note). Delete `.icon-button` / `.repo-picker-add` / `.repo-picker-secondary` / `.sidebar-tool` / `.tab-add` rules from `styles.css` once their references are gone (verify with grep first — see Task 20 caution about template-literal classes).

- [ ] **Step 5: Verify + commit**
```bash
bun run typecheck && bun run build && git add -A && git commit -m "feat(web): adopt shadcn Button across views"
```

### Task 9 (deferred here): Appearance switcher in Settings

**Files:** Modify `apps/web/src/SettingsView.tsx`

- [ ] **Step 1: Add an Appearance section** using `useTheme` + Button segmented controls (avoids the unverified Base UI ToggleGroup single-select API). Wrap in the file's existing section markup (match the surrounding `.settings-section` / `.settings-row` structure already in the file):
```tsx
import { Button } from '@/components/ui/button'
import { useTheme } from '@/theme'
// …inside the settings body, as a new section:
const { preset, mode, setPreset, setMode } = useTheme()
// …
<div className="settings-row">
  <span>Theme</span>
  <div style={{ display: 'inline-flex', gap: 4 }}>
    <Button size="sm" variant={preset === 'podium' ? 'default' : 'outline'} onClick={() => setPreset('podium')}>Podium</Button>
    <Button size="sm" variant={preset === 'shadcn' ? 'default' : 'outline'} onClick={() => setPreset('shadcn')}>shadcn</Button>
  </div>
</div>
<div className="settings-row">
  <span>Mode</span>
  <div style={{ display: 'inline-flex', gap: 4 }}>
    <Button size="sm" variant={mode === 'light' ? 'default' : 'outline'} onClick={() => setMode('light')}>Light</Button>
    <Button size="sm" variant={mode === 'dark' ? 'default' : 'outline'} onClick={() => setMode('dark')}>Dark</Button>
  </div>
</div>
```

- [ ] **Step 2: Verify** (manual): toggling each control flips `<html>` `data-theme`/`.dark` live; reload preserves the choice; `<meta name="theme-color">` updates.

- [ ] **Step 3: Commit**
```bash
bun run build && git add apps/web/src/SettingsView.tsx && git commit -m "feat(web): appearance theme switcher in settings"
```

### Task 11: Input + Textarea + Label

**Files:** Create `src/components/ui/{input,textarea,label}.tsx`; Modify `SettingsView.tsx`, `SearchView.tsx`, `NewPanelMenu.tsx`, `ChatView.tsx`, `SuperagentView.tsx`.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add input textarea label`

- [ ] **Step 2: Replace text inputs** with `<Input …>` (keep `value`/`onChange`/`placeholder`/`aria-*`):
  - `SettingsView.tsx` text/password/number rows
  - `SearchView.tsx` — the search box is **`.search-head input`** (NOT `.chat-search`)
  - `NewPanelMenu.tsx` — `.menu-search` resume-search input

- [ ] **Step 3: Replace textareas** with `<Textarea …>`, **preserving each file's own auto-grow logic and key handlers**:
  - `ChatView.tsx` — `.chat-composer textarea` (auto-grow sets `style.height='auto'` then `scrollHeight`px at ~ChatView.tsx:105-106) and the `.chat-search` highlight box live HERE
  - `SuperagentView.tsx` — `.chat-input` wrapper textarea, styled by **`.superagent-input-wrap textarea`**; it grows via `rows={Math.min(6, …)}` (NOT scrollHeight) — keep as-is
  - Keep Shift+Enter/newline `onKeyDown` handlers intact.

- [ ] **Step 4: Delete migrated input/textarea CSS; verify + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): adopt shadcn Input + Textarea + Label"
```

### Task 12: Checkbox

**Files:** Create `src/components/ui/checkbox.tsx`; Modify `RepoScanResults.tsx` (`.scan-row input`), `SettingsView.tsx` boolean rows.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add checkbox`
- [ ] **Step 2: Replace native checkboxes** with `<Checkbox checked={…} onCheckedChange={…} />` (Base UI uses **`onCheckedChange`**, not `onChange`; `checked` may be `boolean | 'indeterminate'`). Update handlers accordingly.
- [ ] **Step 3: Delete migrated CSS; verify + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): adopt shadcn Checkbox"
```

### Task 13: Select + Badge

**Files:** Create `src/components/ui/{select,badge}.tsx`; Modify `SearchView.tsx` (`.search-head select`), `SettingsView.tsx` (select rows), `WorkerLabel.tsx`, `HostIndicators.tsx`.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add select badge`
- [ ] **Step 2: Replace `<select>`** with the shadcn `Select` composition (`Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem` — confirm exact exports in the generated file). Base UI Select portals + positions itself.
- [ ] **Step 3: Badge** — migrate `.worker-label` kind tag (`WorkerLabel.tsx`) and `.host-chip` (`HostIndicators.tsx`). **`.agent-badge` is dead CSS (zero call sites)** — do NOT migrate it; leave it for Task 20 to delete. shadcn Badge ships `default|secondary|destructive|outline`, which don't cover the state tones, so **extend `badgeVariants` cva** with podium tones:
```tsx
// in badge.tsx cva variants.variant, add:
        ok: 'border-transparent bg-success/15 text-success',
        warn: 'border-transparent bg-warning/15 text-warning',
        critical: 'border-transparent bg-destructive/15 text-destructive',
```
Map host-chip severity ok/warn/critical → those variants; worker-label kind tag → `variant="secondary"`.
- [ ] **Step 4: Delete migrated CSS; verify + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): adopt shadcn Select + Badge (+ state-tone variants)"
```

---

## Phase 4 — Overlays (highest bug-value)

### Task 14: Dialog — shared mobile hook + all four modals

The four real `.modal-backdrop` modals are **RepoPickerModal, RepoScanResults, HostMemoryView, SearchView**. **SettingsView is NOT a modal** (it is a full view via `view==='settings'`) — do not Dialog-ify it.

**Files:** Create `src/components/ui/dialog.tsx`, `src/hooks/use-is-mobile.ts`; Modify `AppShell.tsx` (use the shared hook), the four modal files.

- [ ] **Step 1: Extract a shared `useIsMobile` hook** — create `src/hooks/use-is-mobile.ts` by moving the existing hook out of `AppShell.tsx` (lines 27-36) and exporting it:
```ts
import { useEffect, useState } from 'react'
export function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}
```
Update `AppShell.tsx` to `import { useIsMobile } from '@/hooks/use-is-mobile'` and delete its local copy.

- [ ] **Step 2: Generate Dialog + read its real shape** → `bunx shadcn@latest add dialog` ; then `grep -nE "export|Dialog\\.|position|showCloseButton" src/components/ui/dialog.tsx`. Confirm: named exports (`Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogClose`, …); that `DialogContent` renders `Portal → Overlay(Dialog.Backdrop) → Dialog.Popup` (NO `Viewport`); that the **root `Dialog` forwards `Dialog.Root` props** (so `modal` goes on `<Dialog>`); and that `DialogContent` has a built-in close (`showCloseButton` prop, default true).

- [ ] **Step 3: Exemplar — RepoPickerModal** (controlled; today it has an explicit Close button and NO Escape/backdrop dismiss — Base UI adds both):
```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/hooks/use-is-mobile'
// …
const isMobile = useIsMobile()
return (
  <Dialog open modal={isMobile ? 'trap-focus' : true} onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="repo-picker-body">{/* keep a single sizing class */}
      <DialogHeader>
        <DialogTitle>{onScan ? 'Find repositories' : 'Add repo'}</DialogTitle>
      </DialogHeader>
      {/* existing toolbar + list JSX; buttons are already shadcn Buttons from Task 10 */}
    </DialogContent>
  </Dialog>
)
```
Rules: keep the generated `DialogContent` built-in close (remove the old manual `.icon-button` X); keep ONE `.repo-picker-body` class for max-width/height (move the existing size rules there) — do NOT inline arbitrary Tailwind; remove the `.modal-backdrop` + `[role=dialog]` wrapper.

- [ ] **Step 4: Migrate the other three** — `RepoScanResults`, `HostMemoryView`, `SearchView` — same controlled pattern with `modal={isMobile ? 'trap-focus' : true}` on the root `<Dialog>`. (This blanket mobile `trap-focus` is what protects SearchView's and RepoPicker's text inputs from the scroll-lock-vs-keyboard regression — the shell's own `position:fixed` lock stays authoritative.) Preserve internal content; tabs inside HostMemoryView migrate in Task 17.

- [ ] **Step 5: Delete `.modal-backdrop` + per-modal shell CSS; verify**
```bash
bun run build
```
Then MANUAL (dev host): open RepoPicker → Escape closes, backdrop click closes, focus trapped; on a phone, open Search, focus the input, keyboard rises without the page scroll-jumping.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(web): migrate modals to base-ui Dialog (escape/focus-trap; mobile trap-focus)"
```

### Task 15: DropdownMenu — NewPanelMenu (desktop) ; mobile stays inline

NewPanelMenu has a resume-search **text input** and renders in TWO places: desktop via `Workspace.tsx` (`.workspace-menu-layer`) and inline in the mobile header (`MobileApp.tsx`), where it shares the `closePanelMenus` pointer-capture dismissal. Base UI Menu's `modal` is boolean only (no `trap-focus`).

**Files:** Create `src/components/ui/dropdown-menu.tsx`; Modify `NewPanelMenu.tsx`, `Workspace.tsx`.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add dropdown-menu` ; confirm exports + that the trigger uses Base UI `render` (NOT Radix `asChild`).

- [ ] **Step 2: Desktop path** — wrap the desktop NewPanelMenu in DropdownMenu; use the **element-form `render`** (never `asChild`):
```tsx
<DropdownMenu>
  <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="New panel"><Plus size={16} /></Button>} />
  <DropdownMenuContent align="end">
    {/* agent-type items → DropdownMenuItem; the resume-search input stays a custom non-menu child */}
  </DropdownMenuContent>
</DropdownMenu>
```
Base UI `Positioner` handles collision/clamping — delete the manual positioning + `.new-panel-menu` desktop CSS.

- [ ] **Step 3: Mobile path** — KEEP NewPanelMenu's mobile rendering as the existing inline custom menu (it's entangled with the shared `closePanelMenus` pointer-capture and the mobile header layout, and its search input must not fight scroll-lock). Only restyle it with Tailwind/theme tokens. If you instead choose DropdownMenu on mobile, you MUST pass `modal={false}` and re-verify the `closePanelMenus` dismissal still fires. Gate the desktop-vs-mobile rendering on `useIsMobile()`.

- [ ] **Step 4: Verify (desktop: open/keyboard-nav/escape/click-away; mobile: open from header, search input usable, tap-away dismisses) + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): NewPanelMenu desktop on base-ui DropdownMenu; mobile inline-restyled"
```

### Task 16: Tooltip — ConnectionIndicator (+ app-root provider)

**Files:** Create `src/components/ui/tooltip.tsx`; Modify `ConnectionIndicator.tsx`, `AppShell.tsx`.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add tooltip` ; confirm it exports `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent`.

- [ ] **Step 2: Mount ONE `TooltipProvider`** at the app root (shadcn's generated TooltipProvider sets delay=0 and is recommended once at root). Add it inside AppShell's top-level fragment (which is inside ThemeProvider):
```tsx
import { TooltipProvider } from '@/components/ui/tooltip'
// wrap AppShell's returned tree: <TooltipProvider> … </TooltipProvider>
```

- [ ] **Step 3: Replace the CSS-hover `.conn-tooltip`** in `ConnectionIndicator.tsx` — keep the existing `const { headline, detail } = describeHealth(...)` and `const Icon = health.status === 'down' ? WifiOff : Wifi` lines; replace only the returned JSX:
```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
return (
  <Tooltip>
    <TooltipTrigger render={
      <button type="button" className={`conn-indicator conn-${health.status}`}
        aria-label={`${headline}. ${detail}`} onClick={onOpen}>
        <Icon size={14} aria-hidden="true" />
      </button>
    } />
    <TooltipContent>
      <strong>{headline}</strong><span>{detail}</span>
    </TooltipContent>
  </Tooltip>
)
```
Delete the `.conn-tooltip` CSS; keep the `.conn-indicator`/`conn-${status}` color rules (note: `conn-${status}` is a template-literal class — do NOT let Task 20's grep delete it).

- [ ] **Step 4: Verify (hover + keyboard focus shows tooltip; tap still opens host panel) + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): ConnectionIndicator on base-ui Tooltip (+ root provider)"
```

---

## Phase 5 — Tabs & toggles

### Task 17: Tabs (non-draggable navs) + Button-segmented toggles

**Files:** Create `src/components/ui/tabs.tsx`; Modify `SettingsView.tsx`, `HostMemoryView.tsx`, `HomeView.tsx`, `AgentPanel.tsx`. **Do NOT touch** the `Workspace.tsx` tabbar or `SuperagentView.tsx` thread tablist (see below).

- [ ] **Step 1: Generate** → `bunx shadcn@latest add tabs`

- [ ] **Step 2: Decisive — Workspace `.tabbar` stays custom.** Base UI Tabs manages its own roving-tabindex/keyboard focus, which conflicts with dnd-kit's sortable sensors. KEEP the existing dnd-kit custom tab elements; only restyle with Tailwind/theme tokens. Do NOT wrap them in `Tabs`/`TabsTrigger`. (So `.tabbar`/`.tab` CSS is restyled-in-place, not deleted via Tabs.)

- [ ] **Step 3: Non-draggable navs → `Tabs`** — `SettingsView` section nav, `HostMemoryView` conn/memory tabs, `HomeView` list/board. Use `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`. Remove `.settings-nav`, `.host-info-tabs` CSS once migrated.

- [ ] **Step 4: Binary mode toggles → Button segmented** (same pattern as Task 9, not Base UI ToggleGroup): `.home-mode` (HomeView list/board can be Tabs OR segmented — pick Tabs since it switches content), `.panel-mode` (AgentPanel chat/native) → two `<Button variant={active?'default':'outline'} size="sm">`. Remove `.home-mode`/`.panel-mode` CSS.

- [ ] **Step 5: SuperagentView thread tablist** (`role="tablist"`, `.superagent-threads`/`.super-thread`) — **keep custom** (SuperagentView is a §8 domain-stays-custom view). Add `.superagent-threads`/`.super-thread` to the Task 20 survivor allowlist; just restyle with theme tokens.

- [ ] **Step 6: Verify + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): tab navs on shadcn Tabs; binary toggles segmented; tabbar restyled"
```

---

## Phase 6 — Toast

### Task 18: Sonner replaces `.update-toast`

**Files:** Create `src/components/ui/sonner.tsx`; Modify `AppShell.tsx`, `UpdatePrompt.tsx`.

- [ ] **Step 1: Generate** → `bunx shadcn@latest add sonner`

- [ ] **Step 2: De-`next-themes` the generated Toaster.** The generated `sonner.tsx` imports `useTheme` from `next-themes` (NOT a dependency — build will fail). Edit it to use podium's theme:
```tsx
// replace `import { useTheme } from 'next-themes'` with:
import { useTheme } from '@/theme'
// replace `const { theme = 'system' } = useTheme()` with:
const { mode } = useTheme()
// pass theme={mode} to <Sonner theme={mode} … />
```

- [ ] **Step 3: Mount `<Toaster />`** in `AppShell.tsx`'s top-level fragment (inside ThemeProvider — so `useTheme()` resolves — and rendered for BOTH the mobile and desktop branches, since the fragment wraps `AppBody`). Place it next to the existing `<UpdatePrompt />`.

- [ ] **Step 4: Convert UpdatePrompt** to fire a toast instead of rendering `.update-toast`:
```tsx
import { toast } from 'sonner'
// keep needRefresh + reload as-is; replace the returned JSX with:
useEffect(() => {
  if (!needRefresh) return
  toast('New version available', {
    duration: Infinity,
    action: { label: 'Reload', onClick: reload },
    cancel: { label: 'Later', onClick: () => setNeedRefresh(false) },
  })
}, [needRefresh])
return null
```
Delete the `.update-toast` CSS.

- [ ] **Step 5: Verify (force `needRefresh` true in dev, or trigger an update) + commit**
```bash
bun run build && git add -A && git commit -m "feat(web): replace update-toast with Sonner (themed via @/theme)"
```

---

## Phase 7 — Mobile sheet

### Task 19: `.picker-sheet` → bottom-sheet Dialog (`.session-menu` stays inline)

`.picker-sheet` is a real full-screen overlay (used for repo/worktree selection, launches RepoPickerModal). `.session-menu` is **inline flow content** (no input, dismissed by the shared `closePanelMenus` pointer-capture) — do NOT Dialog-ify it.

**Files:** Modify `src/components/ui/dialog.tsx` (add a sheet variant), the component(s) rendering `.picker-sheet`, `MobileApp.tsx`.

- [ ] **Step 1: Grep the sheet call sites first** → `grep -rn "picker-sheet\\|session-menu" src` and list the files/components.

- [ ] **Step 2: Add a sheet variant to DialogContent** — a `side?: 'bottom'` prop (or a `sheet` boolean) selecting a cva class. Concrete class:
```ts
// bottom-sheet: full width, anchored bottom, safe-area + keyboard-aware padding
'fixed inset-x-0 bottom-0 w-full max-w-none rounded-t-xl border-t ' +
'pb-[max(var(--safe-bottom),env(safe-area-inset-bottom))] ' +
'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom'
```
(Portalled popups don't inherit `.mobile-shell`'s `--safe-bottom`, so the padding is applied explicitly here. Mirror the legacy `.toolbar` keyboard handling if the sheet can host the keyboard.)

- [ ] **Step 3: Migrate `.picker-sheet`** to `<Dialog modal="trap-focus" open={isOpen} onOpenChange={…}><DialogContent side="bottom">…`. Map the existing open boolean to `open`/`onOpenChange`. Make **no changes** to MobileApp's `useVisualViewportHeight` pinning — the Dialog just renders inside the existing shell. `.session-menu` stays inline: only restyle it with Tailwind/theme tokens, leaving the `closePanelMenus` dismissal path untouched.

- [ ] **Step 4: MANUAL mobile verify (390px / real phone)** — sheet opens above the keyboard with safe-area padding; backdrop dismiss works; opening+closing it does NOT scroll-jump the shell (`window.scrollY` stays 0). Then commit:
```bash
bun run build && git add -A && git commit -m "feat(web): picker-sheet as base-ui bottom-sheet Dialog (keyboard/safe-area-safe)"
```

---

## Phase 8 — Retire legacy CSS + final QA

### Task 20: Shrink `styles.css` to domain-only (with allowlist)

**Files:** Modify `apps/web/src/styles.css`

- [ ] **Step 1: Audit candidate dead classes** (broadened matcher):
```bash
for c in $(grep -oE '\.[a-zA-Z0-9_-]+' src/styles.css | tr -d '.' | sort -u); do
  n=$(grep -rl "$c" src --include=*.tsx | wc -l)
  echo "$n  $c"
done | sort -n
```

- [ ] **Step 2: Before deleting, honor the PROTECTED allowlist (never auto-delete):**
  - keyboard/safe-area machinery: all `--safe-*`, `--kb-open`, `--viewport-h` consumers; `body:has(.mobile-shell)`; the `@media (max-width:768px)` safe-area block
  - mobile key bar: `.toolbar`, `.key-actions`, `.kb-hidden`, `.arrow-pad`, `.key-act`, `.key-mic`
  - domain survivors: `.term*`, `.chat-md*`, `.chat-block*`, `.kanban*`, `.home-card*`, `.dot*`, `.superagent-threads`, `.super-thread`, `.conn-indicator`/`conn-*`
  - **template-literal class families** (the grep CANNOT see these — they're built with backticks): `conn-${health.status}` (ConnectionIndicator), `key-actions kb-hidden` (AgentPanel:222,263), `home-${…}`, `panel-${…}`, `dot ${…}`. Manually scan for backtick class construction before deleting anything in the `conn-`, `home-`, `panel-`, `dot`, `kb-` families.

- [ ] **Step 3: Delete only confirmed-dead migrated classes** (modals, menus, tabs, buttons, badges, inputs, tooltip, toast — e.g. `.modal-backdrop`, `.repo-picker-*` shell, `.new-panel-menu`, `.conn-tooltip`, `.update-toast`, `.agent-badge`, `.settings-nav`, `.host-info-tabs`, `.home-mode`, `.panel-mode`, `.icon-button`, `.sidebar-tool`, `.tab-add`). Survivors must be the domain/keyboard set above.

- [ ] **Step 4: Verify + commit**
```bash
bun run build && git add apps/web/src/styles.css && git commit -m "refactor(web): retire migrated CSS; styles.css is now domain-only"
```

### Task 21: Full-app QA (manual dev-host) + unit re-run

Automated Playwright is not wired into `apps/web` (the only harness is the root `tests/e2e`, which targets the live relay). Wiring per-overlay e2e is out of scope; verification is the unit suite + manual dev-host checks. (Optional follow-up: add a `tests/e2e/theme-overlays.spec.ts` to the root harness later.)

- [ ] **Step 1: Re-run unit + build/typecheck**
```bash
bun run typecheck && bun run test:unit && bun run build
```
Expected: all green; theme suite passes.

- [ ] **Step 2: Manual dev-host PWA pass** on `https://podium-host.example.com:55555` (install/refresh the PWA on a phone). For EACH of the 4 themes {shadcn,podium}×{light,dark}: no white flash on load; status bar tint matches; Dialog focus-trap + Escape; DropdownMenu positioning; Tooltip on hover+focus; Sonner toast; mobile sheet above the keyboard with safe-area; soft keyboard does not scroll-jump; mobile key bar intact.

- [ ] **Step 3: Commit any fixes**
```bash
bun run build && git add -A && git commit -m "test(web): theme/overlay QA pass + fixes" --allow-empty
```

---

## Self-review notes (author, post-adversarial-review)

- **Spec coverage:** Foundation §5→T1-5; Theme §6→T6-9; Mapping §7→T10-19; Stays-custom §8 respected (terminal/chat/kanban/keybar/superagent-tablist/Workspace-tabbar kept custom, restyled only); Mobile §9→T14 (blanket mobile `trap-focus`)/T15/T19/T8 (theme-color); Coexistence/retirement §10→T4+T20; Verification §11→standing gate + T7 unit + T21 manual.
- **Adversarial-review fixes folded in:** vitest `.claude` exclude → web-local config (T7); `@base-ui/react` pinned + preflight (T1); generated Dialog anatomy `Portal→Overlay→Popup` no Viewport, `modal` on root, `showCloseButton`, inspect-exports step (T14); SettingsView is NOT a modal (T14, spec §7); sonner `next-themes` edit (T18); Tooltip needs root `TooltipProvider` (T16); DropdownMenu `render` not `asChild`, mobile inline (T15); ToggleGroup API uncertainty → Button-segmented (T9/T17); textarea/input real files+selectors ChatView/SuperagentView/`.search-head input`/`.superagent-input-wrap textarea` (T11); `.agent-badge` dead (T13/T20); mobile scroll-lock regression → blanket `isMobile?'trap-focus':true` for ALL dialogs (T14); `.session-menu` stays inline (T19); theme-color meta sync (T7/T8); Task 20 grep allowlist + template-literal warning; `#root` amend-in-place (T5); Task 3 line refs + HMR risk; interactive init handling (T4).
- **Cross-task consistency:** `useTheme()`/`THEME_BG` (T7) used in T9/T18/T8; `useIsMobile` shared hook (T14) used in T14/T15; token names (T6) match generated set + the two mapped extras; `@/components/ui/*` + `@/lib/utils` aliases (T2/T4) throughout; Base UI `render` (not `asChild`) in T15/T16.
