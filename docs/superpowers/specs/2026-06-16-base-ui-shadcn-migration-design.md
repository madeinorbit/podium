# Design: Migrate Podium web → shadcn/ui (Base UI) + Tailwind v4

**Date:** 2026-06-16
**Branch:** `feat/base-ui-shadcn-migration`
**Status:** Approved design, pending implementation plan

## 1. Motivation

The Podium web frontend is hand-built: a single 3,466-line `styles.css` with bespoke
CSS-variable tokens, and overlays (modals, dropdown menu, tooltip, tabs) implemented
with manually positioned `div`s and CSS-hover tricks. We keep fixing small bugs —
focus traps, escape handling, popup positioning/clamping, z-index stacking, scroll
lock — that a real primitive library handles for free. The goal is to move onto a
**solid foundation**: shadcn/ui built on **Base UI** primitives (shadcn now supports
Base UI as an alternative to Radix), styled with **Tailwind v4**.

## 2. Goals / Non-goals

**Goals**
- Replace handcrafted interactive UI (dialogs, dropdown/context menus, tooltips, tabs,
  form controls, buttons, badges, toasts) with shadcn components on Base UI.
- Introduce Tailwind v4 as the styling system.
- Ship a **4-theme system**: 2 presets (`shadcn` default + `podium` current design) ×
  light/dark, switchable in Settings, persisted.
- Preserve today's look for existing users (first-load default = `podium` / dark).
- Keep the app continuously buildable: full migration on one branch, but built up in
  ordered, individually green commits, landed as one PR.

**Non-goals**
- No redesign of information architecture or app flows. This is a substrate swap, not a
  product redesign.
- No replacement of domain components (terminal, chat transcript, kanban, host-memory
  viz, superagent `@`-autocomplete, mobile key bar) — they get restyled with Tailwind
  classes but keep their logic.
- No new features beyond the theme switcher.
- No server/protocol changes.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Full migration, one branch (incremental commits) | User directive; shadcn guidance warns against a reckless big-bang, so execute component-by-component, green at each commit |
| Primitive layer | **Base UI** via shadcn `init --base base` | User directive; first-class shadcn CLI option since 2026 |
| Base UI package | **`@base-ui/react`** `^1.5` | The old `@base-ui-components/react` is **deprecated/renamed**; do NOT use it |
| CSS framework | **Tailwind v4** (`@tailwindcss/vite`) | Fresh setup, CSS-first config, no PostCSS file, best fit for Vite 8 + Rolldown |
| Themes | 4 = {`shadcn`, `podium`} × {light, dark} | User directive |
| shadcn base color | **zinc** | User choice |
| First-load default | **`podium` / dark** | Preserve current experience |
| Icons | `lucide-react` (already a dep) | shadcn default |

## 4. Current-state baseline (verified)

- React 19 + Vite 8.0.16 (Rolldown bundler) + bun 1.3.13, PWA via `vite-plugin-pwa`.
- **No** Tailwind, **no** `@vitejs/plugin-react` (JSX handled implicitly today), **no** `@/` alias.
- Single `src/styles.css` (dark-only, CSS-var tokens at `:root`, iOS safe-area handling).
- `lucide-react`, `@dnd-kit/*`, `marked`, `dompurify` already present.
- View switching via React context (`store.tsx` `view` state), no router. localStorage
  persistence via `lsGet`/`lsSet` helpers.
- Baseline at branch point: `tsc --noEmit` ✓, `vite build` ✓ (CSS 53KB, JS 907KB).

## 5. Foundation

Add deps (in `apps/web`):
`@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@base-ui/react@^1.5`,
`clsx`, `tailwind-merge`, `class-variance-authority`, `tw-animate-css`.
(NOT `tailwindcss-animate` — deprecated under v4. `lucide-react` already present.)

**`vite.config.ts`** — add plugins + alias, keep existing `@podium/*` aliases + `conditions`:
```ts
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// plugins: [react(), tailwindcss(), VitePWA({...})]
// resolve.alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), ...existing }
```

**tsconfig** (`apps/web/tsconfig.json`) — add the alias shadcn requires in BOTH places:
```json
{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }
```

**shadcn init**: `bunx shadcn@latest init --base base` → generates `components.json`
(`baseColor: zinc`, `cssVariables: true`), `src/lib/utils.ts` (`cn()`), and the Tailwind v4
token blocks in the CSS entry. Components land in `src/components/ui/`.

**App-root**: add `isolation: isolate` to the root element (Base UI's portal-stacking
requirement — replaces manual z-index juggling). No Base UI providers are required
(unlike Radix's `TooltipProvider`).

## 6. Theme architecture

Tailwind v4 CSS entry (replaces the `:root` token block of `styles.css`; legacy rules
move below under `@layer`):

```css
@import "tailwindcss";
@import "tw-animate-css";
@custom-variant dark (&:is(.dark *));   /* class-based dark mode in v4 */

/* shadcn preset (zinc) — light */
:root { --radius:.625rem; --background:…; --foreground:…; --primary:…; /* OKLCH */ }
/* shadcn preset — dark */
.dark { --background:…; --foreground:…; /* dark overrides */ }

/* podium preset — dark = TODAY'S EXACT PALETTE */
[data-theme="podium"].dark {
  --background: oklch(from #0e0e12);   /* --app */
  --card:       oklch(from #16161c);   /* --panel */
  --primary:    oklch(from #f59e0b);   /* amber --accent */
  --destructive:oklch(from #f87171);   /* --danger */
  /* …map every legacy --app/--panel/--surface/--fg/--accent/… to a shadcn token */
}
/* podium preset — light (derived) */
[data-theme="podium"] { --background:…; --primary: amber…; /* light variant */ }

/* map raw vars → Tailwind tokens (ONCE; presets only restyle the raw --* vars) */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  /* …radius + full token map… */
  --color-success: var(--success);   /* keep Podium's semantic extras */
  --color-warning: var(--warning);
}

/* preserve safe-area vars (Base UI won't add them) */
:root { --safe-top: env(safe-area-inset-top,0px); /* …right/bottom/left… */ }
```

**Selection model**: `document.documentElement` carries `data-theme` (`"shadcn"` ⇒ absent,
or `"podium"`) and a `.dark` class. The two axes are independent (4 combinations).

**`ThemeProvider`** (`src/theme.tsx`): a tiny React context mirroring the existing
`lsGet`/`lsSet` localStorage pattern. State `{ preset: 'shadcn'|'podium', mode: 'light'|'dark' }`,
default `{ podium, dark }`. An effect writes `dataset.theme` + toggles `.dark` on `<html>`,
and persists to `localStorage` (`podium.theme.preset`, `podium.theme.mode`). To avoid a
flash before React mounts, an inline `<script>` in `index.html` applies the stored values
to `<html>` immediately on load. Mounted above `AppShell` in `main.tsx`.

**Settings UI**: a "Appearance" section in `SettingsView` with a preset toggle
(shadcn / podium) and a mode toggle (light / dark), built from the new shadcn
`ToggleGroup` / `Tabs`.

## 7. Component mapping

| Custom today (file) | shadcn/Base UI replacement |
|---|---|
| `.modal-backdrop` modals — `RepoPickerModal`, `RepoScanResults`, `SettingsView` (modal mode), `HostMemoryView`, `SearchView` | **Dialog** (`Root`→`Portal`→`Backdrop`→`Viewport`→`Popup`) |
| `.new-panel-menu` clamped dropdown (`NewPanelMenu`) | **DropdownMenu** (`Positioner` handles collision) |
| `.conn-tooltip` CSS-hover (`ConnectionIndicator`) | **Tooltip** |
| `.tabbar` (`Workspace`), settings nav, host-info tabs, `HomeView` list/board | **Tabs** (drag-reorder tabs keep dnd-kit) |
| `.home-mode` / `.panel-mode` toggles | **ToggleGroup** |
| text inputs / selects / checkboxes / textareas | **Input / Select / Checkbox / Textarea** |
| `.agent-badge`, `.worker-label` kind tag, `.host-chip` | **Badge** |
| `.update-toast` (`UpdatePrompt`) | **Sonner** (toast) |
| icon / secondary / primary buttons across the app | **Button** variants (cva) |
| mobile sheets `.picker-sheet`, `.session-menu` | **Dialog** styled as bottom/full sheet (see §8) |

## 8. Stays custom (restyled with Tailwind, logic untouched)

xterm terminal mount (`AgentPanel`), chat transcript + `chat-md` markdown (`ChatView`),
kanban / session-grid (dnd-kit) (`HomeView`), host-memory bar viz (`HostMemoryView`),
superagent `@`-autocomplete (`SuperagentView`), and the **mobile key bar +
visualViewport keyboard pinning** (`MobileApp`, `toolbar`).

## 9. Mobile risk mitigations (this is a heavy-mobile PWA)

- **Scroll-lock vs keyboard pinning**: Base UI `Dialog modal` locks page scroll, which
  can fight the visualViewport pinning logic. Use **`modal="trap-focus"`** (focus trap,
  no scroll/pointer lock) for mobile sheets; the existing keyboard handling stays
  authoritative. Desktop dialogs keep full `modal`.
- **Mobile sheets**: no Base UI drawer exists; rebuild `.picker-sheet` / `.session-menu`
  as Base UI **Dialog styled as a bottom/full sheet**. Base UI backdrops are
  `position: absolute` and cover the visual viewport, which suits iOS.
- **Safe-area**: Base UI does not add `env(safe-area-inset-*)`; keep that padding on
  Popups manually (reuse the existing `--safe-*` vars).
- **Overscroll**: pair sheets with `overscroll-behavior: contain`.
- **Tailwind v4 dev quirk**: a known `@custom-variant dark` dev-mode CSS-ordering bug
  exists (build output is unaffected) — verify via production build, not just dev server.

## 10. Coexistence & retirement of `styles.css`

- Tailwind and the legacy stylesheet coexist during the migration. Tailwind's reset is
  scoped; legacy rules are wrapped so specificity is predictable. New components use
  Tailwind utilities; old views keep their classes until migrated.
- As each view migrates, its CSS rules are deleted. By the end, `styles.css` is reduced
  to domain-only styles: terminal, `chat-md`, kanban, mobile key bar, safe-area, and any
  global resets Tailwind doesn't cover.
- Net target: the bespoke overlay/tab/button/badge/form CSS is gone; the survivors are
  the things §8 keeps custom.

## 11. Verification

- **Every commit**: `bun run typecheck` + `bun run build` green in `apps/web`.
- **Per migrated overlay/flow**: Playwright e2e against the live UI (the committed
  harness drives the real app here — unlike `/browse` headless Chromium): open dialog,
  open dropdown, hover tooltip, keyboard-over-sheet on mobile viewport, theme switch
  applies + persists across reload.
- **Before PR**: manual check on the dev host PWA (mobile): soft-keyboard sheets, safe
  areas, all 4 themes.
- Do NOT run the full agent-bridge integration suite (known PTY-leak hazard); scope e2e
  to web UI flows.

## 12. Sequencing (phases — detailed steps come from the implementation plan)

1. **Foundation**: deps, vite/tsconfig alias, `@vitejs/plugin-react`, `shadcn init --base base`, `cn()`, `isolation: isolate`. Build green with zero visual change.
2. **Theme system**: CSS token blocks (4 themes), `ThemeProvider`, anti-flash inline script, Settings Appearance section.
3. **Primitives**: Button, Input, Textarea, Checkbox, Badge, Select — adopt in-place.
4. **Overlays**: Dialog (all modals), DropdownMenu (`NewPanelMenu`), Tooltip (`ConnectionIndicator`).
5. **Tabs / toggles**: Workspace tabbar (dnd-kit-wrapped), settings nav, home list/board, panel-mode.
6. **Toast**: Sonner replaces `.update-toast`.
7. **Mobile sheets**: `.picker-sheet`, `.session-menu` → Dialog-as-sheet with keyboard/safe-area care.
8. **Retire** remaining migrated CSS from `styles.css`; final mobile pass across all 4 themes.

## 13. Open risks

- **Rolldown / Vite 8 + shadcn/Base UI**: no known incompatibility, but unverified in the
  wild. The foundation phase is the canary; if a plugin breaks, fall back to esbuild
  JSX or pin a Vite version.
- **`@theme inline` + multi-preset interaction**: must verify utilities resolve correctly
  across all 4 theme combos (documented v4 friction around `@theme inline` + dark mode).
- **OKLCH conversion of the legacy palette**: the `podium`-dark values must visually match
  today's hex palette; verify side-by-side, don't trust mechanical conversion.
- **PWA precache size**: shadcn/Tailwind adds CSS/JS; confirm the precache manifest stays
  reasonable.
