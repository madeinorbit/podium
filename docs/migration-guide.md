# Podium web → Tailwind v4 + shadcn (Base UI) migration guide

You are migrating ONE component file from Podium's hand-written CSS (`src/styles.css`,
BEM-ish class names + `var(--legacy)` tokens) to **Tailwind v4 utility classes +
generated shadcn components** (built on Base UI, package `@base-ui/react`).

This is a CLEAN migration: no legacy class names, no `var(--app)`/`var(--accent)` etc. in
your file when done. Reproduce the original look using theme tokens + Tailwind utilities.

## HARD RULES

1. **Only edit your assigned file(s).** Do NOT touch `src/styles.css`, `src/index.css`,
   other components, generated `src/components/ui/*`, or any `.ts` logic file.
2. **Preserve ALL behavior**: every prop, state hook, event handler, `aria-*`, `title`,
   `key`, ref, effect, and the component's exported signature/props stay identical. You are
   changing *styling + which element/primitive renders*, never logic or public interface.
3. **No legacy classes or tokens** in your output: replace every `className="sidebar-x"`
   etc. with Tailwind utilities, and every `var(--app|panel|fg|accent|...)` with the token
   utility below. The only `var(...)` you may keep are the safe-area / keyboard vars
   (`--safe-*`, `--kb-open`, `--viewport-h`) — see "Keep custom".
4. **Match the original visually** as closely as you can (spacing, sizes, colors, hover
   states, layout). Read the original rules for your classes in `src/styles.css` first.
5. Use `cn()` from `@/lib/utils` when composing conditional classes.
6. Import shadcn components from `@/components/ui/<name>` and `useIsMobile` from
   `@/hooks/use-is-mobile`.

## Theme tokens (4 themes already wired: shadcn-Nova + Podium, each light/dark)

Use Tailwind color utilities backed by CSS-var tokens — they auto-adapt to all 4 themes.
NEVER hard-code hex. Mapping from the legacy tokens you'll see in styles.css:

| legacy `var(--…)` | meaning | use instead |
|---|---|---|
| `--app` | app background | `bg-background` |
| `--panel` | panel/card surface | `bg-card` (or `bg-popover` for overlays) |
| `--panel-raised` | raised surface | `bg-muted` |
| `--surface` | secondary surface / hover | `bg-secondary` or `bg-accent` (hover) |
| `--border` | border | `border-border` |
| `--border-strong` | stronger border | `border-border` (or `border-input`) |
| `--fg` | body text | `text-foreground` |
| `--fg-bright` | bright/emphasis text | `text-foreground` + `font-medium` |
| `--dim` | muted text | `text-muted-foreground` |
| `--faint` | faintest text | `text-muted-foreground/70` |
| `--accent` (amber brand) | brand/active accent | `text-primary` / `bg-primary` / `ring-primary` |
| `--success` | green | `text-success` / `bg-success/15 text-success` (chips) |
| `--warning` | amber-yellow | `text-warning` / `bg-warning/15 text-warning` |
| `--danger` | red | `text-destructive` / `bg-destructive/15 text-destructive` |
| `--r` (6px) | radius | `rounded-md` |

Foreground-on-color: on `bg-primary` use `text-primary-foreground`; on `bg-secondary`,
`text-secondary-foreground`; on `bg-card`, `text-card-foreground`; on `bg-muted`,
`text-muted-foreground`.

## Component swaps — EXACT APIs (read the generated file if unsure)

### Button — `@/components/ui/button`
`<Button variant="…" size="…">`. variants: `default | secondary | outline | ghost | destructive | link`. sizes: `default | sm | lg | icon | icon-sm`. Keep `onClick`/`disabled`/`aria-label`/`title`/`type`.
- icon-only legacy buttons (`.icon-button`, `.sidebar-tool`, `.tab-add`, `.pin-button`) → `<Button variant="ghost" size="icon">` (or `icon-sm`).
- primary action → `<Button>`; secondary → `variant="secondary"`; subtle → `variant="ghost"`; dangerous → `variant="destructive"`.
- To render the button as another element (e.g. wrap a link), use Base UI's `render` prop, NOT `asChild`.

### Dialog — `@/components/ui/dialog`  (replaces `.modal-backdrop` + `[role=dialog]`)
Controlled pattern (modals rendered conditionally by a parent with `onClose`):
```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/hooks/use-is-mobile'
const isMobile = useIsMobile()
return (
  <Dialog open modal={isMobile ? 'trap-focus' : true} onOpenChange={(o) => { if (!o) onClose() }}>
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>Title</DialogTitle></DialogHeader>
      {/* body */}
    </DialogContent>
  </Dialog>
)
```
- `modal` goes on the root `<Dialog>` (NOT `DialogContent`). `modal={isMobile ? 'trap-focus' : true}` is MANDATORY for any dialog that can open on mobile and/or contains a text input — it gives focus-trap WITHOUT scroll-lock so it never fights the mobile keyboard pinning.
- `DialogContent` already includes a portal, backdrop, and a built-in close ✕ (`showCloseButton`, default true). REMOVE the old manual `.icon-button` close. Pass `showCloseButton={false}` only if a custom close is required.
- Anatomy is `Portal → Overlay → Popup` (NO `Viewport`). Size via `className="max-w-…"` on `DialogContent`.
- Escape + backdrop-click dismiss are automatic (a feature — some old modals lacked these).

### DropdownMenu — `@/components/ui/dropdown-menu` (replaces `.new-panel-menu` etc.)
```tsx
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
<DropdownMenu>
  <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="…"><Plus/></Button>} />
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={…}>Item</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```
- Trigger composition uses the `render` prop (element form), NEVER `asChild`.
- `Positioner` auto-handles collision/clamping — delete manual positioning.
- Base UI Menu `modal` is boolean only (no `trap-focus`); on mobile pass `modal={false}` on `<DropdownMenu>` if it hosts an input.

### Tooltip — `@/components/ui/tooltip` (replaces `.conn-tooltip` CSS hover)
The root `TooltipProvider` is already mounted in AppShell — do not add another.
```tsx
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
<Tooltip>
  <TooltipTrigger render={<button …>…</button>} />
  <TooltipContent>…</TooltipContent>
</Tooltip>
```

### Tabs — `@/components/ui/tabs` (non-draggable tab navs / segmented sections)
```tsx
<Tabs value={tab} onValueChange={(v) => setTab(v as MyTab)}>
  <TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList>
  <TabsContent value="a">…</TabsContent>
</Tabs>
```
- For binary mode toggles (chat/native, list/board), prefer two `<Button variant={active?'default':'outline'} size="sm">` (a segmented group) — simpler and consistent.
- **Workspace draggable tab strip stays CUSTOM** (dnd-kit roving focus conflicts with Tabs). Restyle with utilities only; do NOT wrap in `Tabs`.

### Select — `@/components/ui/select` (replaces native `<select>`)
```tsx
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
<Select value={v} onValueChange={setV}>
  <SelectTrigger><SelectValue/></SelectTrigger>
  <SelectContent><SelectItem value="x">X</SelectItem></SelectContent>
</Select>
```

### Checkbox / Switch — `@/components/ui/{checkbox,switch}`
Native `<input type=checkbox>` → `<Checkbox checked={b} onCheckedChange={setB}/>` (note
`onCheckedChange`, not `onChange`; value may be `boolean | 'indeterminate'`). For settings
on/off prefer `<Switch checked={b} onCheckedChange={setB}/>`.

### Input / Textarea / Label — `@/components/ui/{input,textarea,label}`
`<input>` → `<Input …/>`, `<textarea>` → `<Textarea …/>`, keeping value/onChange/placeholder
/aria and any auto-grow `onInput`/`ref` logic UNCHANGED. Pair with `<Label htmlFor>` where a label exists.

### Badge — `@/components/ui/badge`
`<Badge variant="…">`: `default | secondary | destructive | outline | success | warning | ghost`.
Map state tones: idle/ok→`success`, attention/warn→`warning`, error/critical→`destructive`,
working/active→`default`, neutral kind-tags→`secondary`.

### Toast — `sonner` (replaces `.update-toast`)
`import { toast } from 'sonner'` then `toast('msg', { action: { label, onClick }, … })`. The
`<Toaster/>` is already mounted in AppShell.

## Mobile (this is a heavy-mobile PWA — do not regress)
- Dialogs: `modal={isMobile ? 'trap-focus' : true}` (see Dialog).
- The shell already locks scroll via `body:has(.mobile-shell){position:fixed}` and pins the
  visual viewport in `MobileApp` (`--kb-open`, `--viewport-h`). Do NOT change that hook or
  the mobile key bar (`.toolbar`, `.key-actions`, `.arrow-pad`, `.key-mic`) — leave those
  classes/markup as-is if present in your file (they are irreducible app CSS handled
  separately).
- Safe-area: keep `env(safe-area-inset-*)` / `var(--safe-*)` usages. In Tailwind use
  arbitrary values, e.g. `pb-[max(var(--safe-bottom),env(safe-area-inset-bottom))]`.

## Keep CUSTOM (do not Tailwind-ify these — leave their classes/markup as-is)
- xterm terminal mount (`.term`, terminal theming) — leave the container class.
- chat markdown prose (`.chat-md` and its descendant rules) — leave `.chat-md` class.
- kanban / session-grid drag layout (dnd-kit) — keep dnd-kit structure; you may restyle
  card chrome with utilities but keep the drag wiring.
- mobile key bar + visualViewport machinery (above).
- the `.dot` status indicator may stay a small element; recolor via `bg-primary` (working),
  `bg-success` (idle/live), `bg-warning` (attention), `bg-destructive` (error),
  `bg-muted-foreground` (ended) using `cn()`.

## Output
Edit your assigned file in place. After migrating, return a short JSON-able summary:
`{ file, summary, legacyClassesRetired: [...], keptCustom: [...], shadcnUsed: [...], risks: [...] }`.
Do NOT run the full build/typecheck (other files are being migrated in parallel — it will
show unrelated errors). Just make your file correct and self-consistent against the APIs above.
