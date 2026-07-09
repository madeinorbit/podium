# Markdown preview/edit panel — design

**Date:** 2026-06-19
**Branch:** `feat/markdown-preview` (worktree off `main` @ `fde7268`)
**Status:** Design approved; spec under review

## Problem

Markdown files are first-class in Podium and need different handling from ordinary
source files. When a `.md`/`.markdown` file is opened, the **default view should be a
rendered preview**, not the raw CodeMirror source. Editing the underlying source must
still be possible. The preview is also the foundation for a **future feature**:
annotating specific source lines from the rendered view and feeding that annotation
back to the agent the file was opened from.

Today, file tabs open in `FileEditorPanel` (CodeMirror 6) as plain syntax-highlighted
source. Markdown rendering already exists (`apps/web/src/markdown.ts`: `marked` +
DOMPurify, with diff colorization and file-link linkification) but only for chat
transcripts — nothing renders a `.md` file as a preview.

## Goals

- Opening a `.md`/`.markdown` file defaults to a **rendered preview**.
- Three view modes per markdown tab: **Preview** (default) · **Source** · **Split**.
- **Split** shows preview + source editor side by side with **synchronized scrolling**.
- Editing the source still works, with today's dirty/save/conflict behavior intact.
- Preview is "full": headings, lists, tables, task lists, inline formatting, links,
  syntax-highlighted code blocks, **and relative images/local assets resolved**.
- Build the **source-line ↔ rendered-block mapping** once; it powers sync-scroll now
  and is the seam for the future line-annotation feature.
- Non-markdown files are **completely unchanged** (byte-for-byte today's behavior).

## Non-goals (YAGNI / future)

- The annotation UI and the "feed annotation back to the originating agent" round-trip.
  We build only the *seam* (the line↔block mapping + the tab's `sessionId`), not the
  feature.
- WYSIWYG / in-place live-preview editing (Obsidian/Typora style). Source editing stays
  in CodeMirror.
- Rendering remote (http) images beyond what the existing sanitizer already permits;
  scope here is **local/relative** assets in the session sandbox.
- Markdown authoring affordances (bold/italic toolbar buttons, etc.).

## Chosen approach: container layer that owns the document (Approach A)

A new container component owns the loaded document and composes two focused children —
the existing editor (reused) and a new preview. This is the "layer on top" option:
not bolting preview into the editor, not a disconnected separate panel.

The deciding constraint is **split + synchronized scroll**: preview and source must
share one copy of the document (same content, same dirty state, same save). A separate,
independently-loading preview panel would double-load and drift; cramming everything
into the editor component would make it a do-everything file. A container that owns the
document and renders both children as siblings resolves both.

### Components and boundaries

```
MarkdownFilePanel (container; rendered by Workspace for every file tab)
├── useFileDocument(sessionId, path)   ← single source of truth (extracted hook)
├── header: filename · dirty dot · mode toggle (md only) · save/reload/overwrite · close
├── SourceEditor        ← CodeMirror view, extracted from today's FileEditorPanel
└── MarkdownPreview      ← new; renders sanitized HTML with data-source-line anchors
```

- **`useFileDocument(sessionId, path)`** — a hook extracted from the current
  `FileEditorPanel`. The single source of truth for an open file:
  - loads content via `files.read` (tRPC), holds `content`, `baseHash`,
    `dirty`, and `editable`/`binary`/`tooLarge`/`error` states;
  - exposes `save()` (`files.write`, with `baseHash` conflict detection) and the
    overwrite/reload actions exactly as today;
  - exposes an `onChange(nextContent)` to update the in-memory doc (sets dirty).
  - This is what makes split/sync-scroll/save work across modes: one document, many
    views.

- **`SourceEditor`** — the CodeMirror 6 view, extracted verbatim from today's
  `FileEditorPanel` rendering path. Props: `content`, `editable`, `language`
  (via existing `editor-lang.ts`), `onChange`, and the Ctrl/Cmd+S save keybinding
  wired to the document's `save()`. Pure view over the doc; no file IO of its own.
  Behavior for non-markdown files is identical to today.

- **`MarkdownPreview`** — new. Given `content`, `sessionId`, and the file's directory:
  - renders markdown → **sanitized HTML** with **per-block `data-source-line`** anchors
    (see mapping below);
  - **syntax-highlights** fenced code blocks;
  - **rewrites relative image `src`** (and local-relative `href`s) to the asset
    endpoint (see backend), resolved against the file's directory;
  - emits its current top-visible source line on scroll and accepts a target line to
    scroll to (for sync).
  - Reuses/extends `apps/web/src/markdown.ts` rather than introducing a new markdown
    library (the repo already standardizes on `marked` + DOMPurify).

- **`MarkdownFilePanel`** — new container = the file-tab panel. Uses `useFileDocument`.
  - For `.md`/`.markdown`: shows the **Preview · Source · Split** toggle in the header
    (default **Preview**) and renders the children for the active mode.
  - For any other extension: renders only `SourceEditor` (today's behavior).
  - Owns the header (filename, dirty `●`, save/reload/overwrite toast affordances,
    close `×`).
  - `Workspace.tsx` renders `MarkdownFilePanel` for file-tab panels in place of
    `FileEditorPanel`. (Effectively `FileEditorPanel` is refactored into
    `MarkdownFilePanel` + `SourceEditor` + `useFileDocument`.)

## Source ↔ render mapping (shared infrastructure)

This is the one piece of genuinely new logic, and it serves two features.

- **Build:** lex the markdown with `marked` into top-level block tokens. Walk the tokens
  accumulating each block's source character offset from token `raw` lengths, and
  convert offset → 1-based source line by counting newlines in the original text. Render
  each top-level block to HTML (e.g. `marked.parser([token])`) and wrap the fragment in
  an element carrying `data-source-line="<startLine>"` (and optionally `data-end-line`).
  Sanitize the assembled HTML with DOMPurify, allowing the `data-source-line`
  attribute and the wrapper element.
- **Sync-scroll (now):** maintain a "scroll owner" guard to avoid feedback loops.
  - Source scrolls → read CodeMirror's topmost visible line → scroll preview so the
    block with the nearest `data-source-line ≤ line` is at the top.
  - Preview scrolls → read the topmost visible block's `data-source-line` → scroll
    CodeMirror to that line.
  - Debounced; only the active mode `Split` runs sync.
- **Annotation seam (future, not built):** a selected rendered block resolves to a
  source line range via `data-source-line`; combined with the tab's `sessionId`
  (already on `FileTab`), that yields `{ file, lineStart, lineEnd, note }` to hand to
  the originating agent. Block-level granularity is the v1 seam; finer
  within-block line resolution is future refinement.

## Backend: local asset serving

Relative images in a rendered preview need their bytes served. **Correction to the
initial assumption:** the server has *no direct filesystem access* — `files.read` is
forwarded to the **daemon** over the relay RPC protocol (`apps/daemon/src/file-access.ts`
`readFileSandboxed`), and that path is **text-only** (it returns `binary: true` with no
bytes for images, 2 MB cap). So image serving is a daemon→server binary-read pipeline,
not a one-line server route. It mirrors the existing `fileRead` path:

- **Daemon** (`apps/daemon/src/file-access.ts`): add `readAssetSandboxed({ cwd, path,
  knownPath })` beside `readFileSandboxed` — same `isInside` + `realpath` sandbox check,
  but returns raw bytes (base64) and a content-type from the extension, allows binary
  (images), with a sensible size cap. Reject out-of-sandbox / traversal exactly as today.
- **Protocol** (`@podium/protocol`): add `fileAssetRequest` / `fileAssetResult` message
  types, registered in the same daemon↔server message union/registry as
  `fileReadRequest` / `fileReadResult`.
- **Server relay** (`apps/server/src/relay.ts`): add `readAsset({ sessionId, path })`
  mirroring `readFile` — a `pendingFileAssets` map + `daemonRequest` round-trip.
- **Server HTTP** (`apps/server/src/server.ts`, Hono): add `GET /files/asset?sessionId=&
  path=` that looks up the session (`registry.sessions.get` — the only auth that exists;
  CORS-only, no token layer), calls `registry.readAsset`, decodes the bytes, and returns
  them with the content-type. 404 on missing session/file.
- **Web:** `MarkdownPreview` rewrites relative image URLs (resolved against the file's
  directory via `file-path.ts` `resolveAgainstCwd`) to point at `GET /files/asset`;
  DOMPurify config permits the resulting same-origin URLs.

This pipeline is sequenced *after* the frontend preview/modes/sync-scroll core so the
first increment is committable and runtime-verifiable on its own (relative images render
as a placeholder until the pipeline lands).

## Data flow

1. `openFile(sessionId, path)` → `FileTab` added, pane switches (unchanged in
   `store.tsx`).
2. `Workspace` renders `MarkdownFilePanel`, which calls `useFileDocument` → loads
   content + `baseHash`.
3. `.md`/`.markdown` → default **Preview**. `MarkdownPreview` renders the HTML with
   `data-source-line` anchors; relative images point at the asset route.
4. Toggle **Source** → `SourceEditor` (CodeMirror). Edits update the document (dirty).
   Ctrl/Cmd+S → `files.write` with `baseHash`; conflict → overwrite/reload toast exactly
   as today. Preview re-renders live from the document content.
5. Toggle **Split** → both children mounted; synchronized scroll via the mapping.
6. Close `×` or session kill → tab removed (unchanged).

## Edge cases & details

- **Binary / too-large:** preview is text-only; fall back to the existing error/empty
  states. The mode toggle is hidden when the document isn't renderable text.
- **Mode persistence:** remember the last mode per tab; default **Preview** on first
  open of a markdown file. Persist alongside the existing `paneA` localStorage pattern.
- **Mobile:** on narrow viewports (`hooks/use-is-mobile.ts`) hide **Split** — offer only
  Preview · Source (toggle). Split is a desktop affordance.
- **Live re-render perf:** debounce preview re-render while typing in Split.
- **Code highlighting dependency:** prefer reusing existing infrastructure (the
  CodeMirror language packages already loaded via `editor-lang.ts`, via static
  highlighting) over adding a heavy new dependency; fall back to a lightweight
  highlighter only if static highlighting proves impractical. Unknown languages render
  as plain `<pre><code>`. Final mechanism pinned in the plan.
- **Sanitization:** all rendered HTML passes through DOMPurify; the only new allowances
  are the `data-source-line` wrapper attribute and the rewritten asset URLs.

## Testing

- **Test-markdown fixtures:** commit sample `.md` files that exercise every feature
  (headings, lists, nested lists, task lists, tables, inline formatting, links, fenced
  code in several languages, a diff block, blockquotes, and a relative image). These are
  the inputs for both runtime verification and the mapping unit tests, and let a human
  open them in-app to eyeball every feature.
- **Unit (vitest + happy-dom, mirroring `markdown.test.ts`):** source-line ↔ block
  mapping over representative markdown (headings, lists, tables, code fences, blank
  lines); asset-URL rewriting; `useFileDocument` dirty / save / conflict state
  transitions.
- **Runtime (Playwright harness — per project lesson that interactive UI needs
  in-browser verification, not just unit+build+review):**
  - open a `.md` → preview renders (not raw source);
  - toggle Source → edit → save → preview reflects the change;
  - Split → scrolling one pane scrolls the other (sync);
  - a relative `![](./img.png)` loads via the asset route;
  - non-markdown file still opens exactly as before.

## Affected files (reference)

- `apps/web/src/FileEditorPanel.tsx` — refactored into `MarkdownFilePanel` +
  `SourceEditor` + `useFileDocument`.
- `apps/web/src/Workspace.tsx` — render `MarkdownFilePanel` for file tabs.
- `apps/web/src/markdown.ts` — extend with block-level `data-source-line` rendering +
  asset-URL rewriting (or a sibling module if it keeps `markdown.ts` focused).
- `apps/web/src/store.tsx` — per-tab view-mode state (if not kept component-local).
- `apps/web/src/editor-lang.ts`, `editor-save.ts`, `file-path.ts` — reused.
- Image pipeline (sequenced last):
  - `apps/daemon/src/file-access.ts` — add `readAssetSandboxed`.
  - `@podium/protocol` — add `fileAssetRequest` / `fileAssetResult`.
  - `apps/server/src/relay.ts` — add `readAsset` + `pendingFileAssets`.
  - `apps/server/src/server.ts` — add `GET /files/asset` (Hono).
```
