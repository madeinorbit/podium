# Markdown Preview/Edit Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open `.md`/`.markdown` files in a rendered preview by default, with Preview · Source · Split (synced-scroll) modes and live source editing, including relative-image rendering.

**Architecture:** A new `MarkdownFilePanel` container owns the loaded document (via an extracted `useFileDocument` hook) and composes two focused children — the reused CodeMirror editor (`SourceEditor`) and a new `MarkdownPreview`. A source-line↔rendered-block map (`data-source-line` anchors) powers split-view scroll sync now and seeds the future line-annotation feature. Relative images are served by a daemon→server binary-read pipeline (`readAssetSandboxed` → `fileAsset` protocol messages → relay `readAsset` → Hono `GET /files/asset`).

**Tech Stack:** React 19, CodeMirror 6, `marked` + DOMPurify, Tailwind v4, tRPC, Hono (server), Zod (protocol), vitest (+ happy-dom for web).

## Global Constraints

- Package manager: **bun**. Monorepo workspaces: `apps/*`, `packages/*`.
- Tests: **vitest** per package (`cd <pkg> && bunx vitest run <file>`). Web uses happy-dom (configured in `apps/web/vitest.config.ts`). Mirror the existing sibling test files named in each task.
- **No new runtime dependencies.** Reuse `marked`, `dompurify`, `@codemirror/*`, `hono`, `zod` — all already present.
- Work only in the worktree `feat/markdown-preview` (`/home/user/src/other/podium/.claude/worktrees/markdown-preview`). NEVER edit the main checkout (it is the live source).
- Follow existing patterns; keep files focused (one responsibility).
- TDD where logic is pure; React components / CodeMirror / sync-scroll are verified by build + typecheck + the runtime checklist (Task 9 / Task 14). In-browser runtime verification is REQUIRED for the interactive pieces — not just unit+build.
- Frequent commits, one per task. End every commit message with the two trailers:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016FZXShpQYrJWtKpD7pXCSj`
  (omitted from the example commit blocks below for brevity — add them).
- Two distinct "splits" exist: the Workspace **pane A|B split** (two tabs side by side, unchanged) and the markdown **Split mode** (preview+source inside one file panel). Keep them separate.

---

## Phase 1 — Frontend core (committable & runtime-verifiable without the backend)

### Task 1: Source→block markdown render with line map

**Files:**
- Create: `apps/web/src/markdown-blocks.ts`
- Create: `apps/web/src/markdown-blocks.test.ts`
- Reference (unchanged): `apps/web/src/markdown.ts` (exports `linkifyCodePaths`; importing it applies the shared `marked` config — gfm, breaks, diff-colorizing `code` renderer)

**Interfaces:**
- Produces: `renderMarkdownBlocks(text: string, opts?: { resolveAsset?: (src: string) => string | null }): string` — sanitized HTML where each top-level block is `<div class="md-block" data-source-line="N">…</div>` (N = 1-based source line). `resolveAsset` rewrites relative `<img src>`; returning `null` leaves a src untouched.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/markdown-blocks.test.ts
import { describe, expect, it } from 'vitest'
import { renderMarkdownBlocks } from './markdown-blocks'

describe('renderMarkdownBlocks', () => {
  it('wraps each top-level block with its 1-based source line', () => {
    const md = '# Title\n\nPara one.\n\n- a\n- b\n'
    const html = renderMarkdownBlocks(md)
    expect(html).toContain('data-source-line="1"') // heading on line 1
    expect(html).toContain('data-source-line="3"') // paragraph on line 3
    expect(html).toContain('data-source-line="5"') // list starts line 5
    expect(html).toContain('<h1')
    expect(html).toContain('<ul')
  })

  it('rewrites relative image src via resolveAsset and leaves absolute/data alone', () => {
    const md = '![x](./img/a.png)\n\n![y](https://h/b.png)\n'
    const html = renderMarkdownBlocks(md, { resolveAsset: (s) => `ASSET:${s}` })
    expect(html).toContain('src="ASSET:./img/a.png"')
    expect(html).toContain('src="https://h/b.png"')
  })

  it('still colourizes diff code blocks (shared marked config)', () => {
    const html = renderMarkdownBlocks('```diff\n@@ -1 +1 @@\n+a\n-b\n```')
    expect(html).toContain('class="diff-add"')
    expect(html).toContain('class="diff-del"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/markdown-blocks.test.ts`
Expected: FAIL — cannot find module `./markdown-blocks`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/markdown-blocks.ts
import DOMPurify from 'dompurify'
import { marked } from 'marked'
// Importing markdown.ts applies the shared marked config (gfm/breaks + diff-aware
// code renderer) as a module side effect, and gives us the file-path linkifier.
import { linkifyCodePaths } from './markdown'

export interface RenderBlocksOptions {
  /** Map a relative image src to a servable URL; return null to leave it as-is. */
  resolveAsset?: (src: string) => string | null
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1
  return n
}

// Rewrite relative <img src>. Absolute (http/https/data/blob), protocol-relative,
// and root-absolute srcs are left untouched.
function rewriteImageSrc(html: string, resolveAsset?: (src: string) => string | null): string {
  if (!resolveAsset) return html
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/g, (full, pre: string, src: string, post: string) => {
    if (/^(https?:|data:|blob:|\/\/|\/)/i.test(src)) return full
    const url = resolveAsset(src)
    return url ? `${pre}${url}${post}` : full
  })
}

/**
 * Markdown → sanitized HTML, each top-level block wrapped in
 * `<div class="md-block" data-source-line="N">`. The line map drives split-view
 * scroll sync and the future line-annotation feature.
 */
export function renderMarkdownBlocks(text: string, opts: RenderBlocksOptions = {}): string {
  const tokens = marked.lexer(text)
  let offset = 0
  let out = ''
  for (const token of tokens) {
    const line = countNewlines(text.slice(0, offset)) + 1
    const single = [token] as typeof tokens
    // Carry reference-link definitions collected during lexing so reflinks resolve.
    ;(single as unknown as { links?: unknown }).links = (tokens as unknown as { links?: unknown }).links
    const inner = marked.parser(single)
    offset += token.raw.length
    if (!inner.trim()) continue // skip whitespace-only 'space' tokens
    out += `<div class="md-block" data-source-line="${line}">${inner}</div>`
  }
  const withImages = rewriteImageSrc(linkifyCodePaths(out), opts.resolveAsset)
  // DOMPurify keeps data-* attributes and class by default (matches markdown.ts).
  return DOMPurify.sanitize(withImages)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/markdown-blocks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the showcase fixture (for runtime verification)**

Create `docs/markdown-preview-samples/showcase.md`:

```markdown
# Markdown Preview Showcase

A paragraph with **bold**, _italic_, `inline code`, and a [link](https://example.com).

## Lists

- first
- second
  - nested
- third

1. one
2. two

## Task list

- [x] done
- [ ] todo

## Table

| Feature | Status |
| ------- | ------ |
| preview | yes    |
| split   | yes    |

## Code

```ts
export const hello = (name: string): string => `hi ${name}`
```

## Diff

```diff
@@ -1 +1 @@
+added line
-removed line
```

> A blockquote for good measure.

## Image

![local diagram](./diagram.png)
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/markdown-blocks.ts apps/web/src/markdown-blocks.test.ts docs/markdown-preview-samples/showcase.md
git commit -m "feat(web): markdown block renderer with source-line map + showcase fixture"
```

---

### Task 2: Relative-asset URL builder

**Files:**
- Create: `apps/web/src/asset-url.ts`
- Create: `apps/web/src/asset-url.test.ts`
- Reference (unchanged): `apps/web/src/file-path.ts` (`resolveAgainstCwd`)

**Interfaces:**
- Produces: `assetUrl(args: { httpOrigin: string; sessionId: string; fileDir: string; src: string }): string | null` — builds a `GET /files/asset?sessionId=&path=` URL for a markdown-relative image, resolving `src` against `fileDir`. Returns `null` for remote/data sources (caller leaves them as-is).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/asset-url.test.ts
import { describe, expect, it } from 'vitest'
import { assetUrl } from './asset-url'

describe('assetUrl', () => {
  const base = { httpOrigin: 'http://h:1', sessionId: 's1', fileDir: '/w/docs' }
  it('resolves a relative src against the file dir', () => {
    expect(assetUrl({ ...base, src: './img/a.png' })).toBe(
      'http://h:1/files/asset?sessionId=s1&path=%2Fw%2Fdocs%2Fimg%2Fa.png',
    )
  })
  it('resolves ../ segments', () => {
    expect(assetUrl({ ...base, src: '../x.png' })).toBe(
      'http://h:1/files/asset?sessionId=s1&path=%2Fw%2Fx.png',
    )
  })
  it('passes through remote/data srcs as null', () => {
    expect(assetUrl({ ...base, src: 'https://h/b.png' })).toBeNull()
    expect(assetUrl({ ...base, src: 'data:image/png;base64,AAAA' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/asset-url.test.ts`
Expected: FAIL — cannot find module `./asset-url`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/asset-url.ts
import { resolveAgainstCwd } from './file-path'

/**
 * Build a URL that serves a markdown-relative asset (image) through the server's
 * /files/asset route, scoped to a session. `fileDir` is the directory of the .md
 * file. Returns null for sources that should be left untouched (remote / data).
 */
export function assetUrl(args: {
  httpOrigin: string
  sessionId: string
  fileDir: string
  src: string
}): string | null {
  const { httpOrigin, sessionId, fileDir, src } = args
  if (/^(https?:|data:|blob:|\/\/)/i.test(src)) return null
  const abs = src.startsWith('/') ? src : resolveAgainstCwd(fileDir, src)
  const qs = new URLSearchParams({ sessionId, path: abs })
  return `${httpOrigin.replace(/\/+$/, '')}/files/asset?${qs.toString()}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/asset-url.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/asset-url.ts apps/web/src/asset-url.test.ts
git commit -m "feat(web): asset URL builder for markdown-relative images"
```

---

### Task 3: Extract `useFileDocument` hook

Extract the load/save/dirty/baseHash/conflict logic out of `FileEditorPanel.tsx` into a reusable hook that owns the document content (so preview + editor share one copy). This is a refactor: behavior is preserved; verification is typecheck + the Task 9 runtime check.

**Files:**
- Create: `apps/web/src/useFileDocument.ts`
- Reference (unchanged): `apps/web/src/editor-save.ts` (`canSave`), `apps/web/src/store.tsx` (`readFile`, `writeFile`)

**Interfaces:**
- Consumes: `useStore().readFile(sessionId, path)`, `useStore().writeFile({ sessionId, path, content, baseHash })`.
- Produces: `useFileDocument(sessionId: string, path: string): FileDocument` where
  ```ts
  interface FileDocument {
    status: 'loading' | 'ready' | 'error'
    message: string
    content: string            // authoritative document text
    contentRef: React.MutableRefObject<string>  // synchronous latest (for save)
    editable: boolean
    dirty: boolean
    saving: boolean
    baseHash: string | undefined
    reloadNonce: number
    setContent: (next: string) => void  // user edit → marks dirty (sync ref + state)
    save: () => Promise<void>
    reload: () => void
  }
  ```

- [ ] **Step 1: Write the implementation**

```ts
// apps/web/src/useFileDocument.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { canSave } from './editor-save'
import { useStore } from './store'

export interface FileDocument {
  status: 'loading' | 'ready' | 'error'
  message: string
  content: string
  contentRef: React.MutableRefObject<string>
  editable: boolean
  dirty: boolean
  saving: boolean
  baseHash: string | undefined
  reloadNonce: number
  setContent: (next: string) => void
  save: () => Promise<void>
  reload: () => void
}

/** Owns one open file's content + save lifecycle, decoupled from any editor view
 *  so a preview and a source editor can share the same document. Extracted from
 *  the original FileEditorPanel. All files open editable; the daemon rejects
 *  out-of-repo writes, surfaced via toast. */
export function useFileDocument(sessionId: string, path: string): FileDocument {
  const { readFile, writeFile } = useStore()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [content, setContentState] = useState('')
  const contentRef = useRef('')
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const editable = true

  const setContent = useCallback((next: string) => {
    contentRef.current = next
    setContentState(next)
    setDirty(true)
  }, [])

  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])

  const save = useCallback(async () => {
    if (!canSave({ editable, dirty, saving })) return
    setSaving(true)
    const body = contentRef.current
    const r = await writeFile({ sessionId, path, content: body, baseHash })
    setSaving(false)
    if (r.ok) {
      setBaseHash(r.baseHash)
      setDirty(false)
      toast.success('Saved')
    } else if (r.conflict) {
      toast.error('File changed on disk — reload or overwrite', {
        action: {
          label: 'Overwrite',
          onClick: async () => {
            setSaving(true)
            const r2 = await writeFile({ sessionId, path, content: contentRef.current })
            setSaving(false)
            if (r2.ok) {
              setBaseHash(r2.baseHash)
              setDirty(false)
              toast.success('Saved (overwritten)')
            } else {
              toast.error(r2.error ?? 'Save failed')
            }
          },
        },
        cancel: { label: 'Reload', onClick: reload },
      })
    } else {
      toast.error(r.error ?? 'Save failed')
    }
  }, [sessionId, path, writeFile, baseHash, dirty, saving, editable, reload])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setDirty(false)
    setBaseHash(undefined)
    void (async () => {
      const r = await readFile(sessionId, path)
      if (cancelled) return
      if (!r.ok) {
        setStatus('error')
        setMessage(r.tooLarge ? 'File too large' : r.binary ? 'Binary file' : (r.error ?? 'Failed to open'))
        return
      }
      contentRef.current = r.content ?? ''
      setContentState(r.content ?? '')
      setBaseHash(r.baseHash)
      setStatus('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, path, readFile, reloadNonce])

  return {
    status, message, content, contentRef, editable, dirty, saving, baseHash,
    reloadNonce, setContent, save, reload,
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: all packages exit 0 (the hook is unused so far; this confirms it compiles).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/useFileDocument.ts
git commit -m "feat(web): extract useFileDocument hook (document state + save lifecycle)"
```

---

### Task 4: Extract `SourceEditor` component

The CodeMirror view as a focused, document-driven child. It seeds from content **once per mount** (keyed remount on reload) and reports edits via `onChange`; it never has content pushed back into it (one-way CM→document), so typing in split mode doesn't tear down the editor.

**Files:**
- Create: `apps/web/src/SourceEditor.tsx`
- Reference (unchanged): `apps/web/src/editor-lang.ts` (`langIdForPath`, `loadLanguage`)

**Interfaces:**
- Produces: `SourceEditor` component:
  ```ts
  function SourceEditor(props: {
    path: string
    initialContent: string
    editable: boolean
    onChange: (next: string) => void
    onSave: () => void
    viewRef?: React.MutableRefObject<import('@codemirror/view').EditorView | null>
  }): JSX.Element
  ```
  `viewRef` exposes the live `EditorView` (used by Task 8 scroll sync). Callers MUST give it a stable React `key` (e.g. `${sessionId}:${path}:${reloadNonce}`) so reload remounts it with fresh content.

- [ ] **Step 1: Write the implementation**

```tsx
// apps/web/src/SourceEditor.tsx
import type { EditorView as EditorViewType } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { type JSX, useEffect, useRef } from 'react'
import { langIdForPath, loadLanguage } from './editor-lang'

/** CodeMirror source view over a document. Seeds from `initialContent` at mount;
 *  give it a stable `key` so a reload remounts with fresh content. Edits flow out
 *  via onChange — content is never pushed back in (avoids teardown while typing in
 *  split mode). */
export function SourceEditor({
  path,
  initialContent,
  editable,
  onChange,
  onSave,
  viewRef,
}: {
  path: string
  initialContent: string
  editable: boolean
  onChange: (next: string) => void
  onSave: () => void
  viewRef?: React.MutableRefObject<EditorViewType | null>
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const seedRef = useRef(initialContent)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    let cancelled = false
    let view: EditorView | null = null
    void (async () => {
      const ext = await loadLanguage(langIdForPath(path))
      if (cancelled || !hostRef.current) return
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: seedRef.current,
          extensions: [
            basicSetup,
            ...ext,
            EditorView.editable.of(editable),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) onChangeRef.current(u.state.doc.toString())
            }),
            EditorView.domEventHandlers({
              keydown(e) {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  onSaveRef.current()
                }
              },
            }),
          ],
        }),
      })
      if (viewRef) viewRef.current = view
    })()
    return () => {
      cancelled = true
      view?.destroy()
      if (viewRef) viewRef.current = null
    }
    // initialContent intentionally excluded: seed once per mount (keyed remount on reload).
  }, [path, editable, viewRef])

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-auto text-[13px]" />
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/SourceEditor.tsx
git commit -m "feat(web): extract SourceEditor (document-driven CodeMirror view)"
```

---

### Task 5: `MarkdownPreview` component + styles

Renders the block HTML, wires relative-image URLs through `assetUrl`, and keeps the existing file-link click behavior (`a.file-link[data-path]` → `openFile`). Exposes its scroll element for Task 8.

**Files:**
- Create: `apps/web/src/MarkdownPreview.tsx`
- Modify: `apps/web/src/store.tsx` (add `httpOrigin` to the store)
- Modify: `apps/web/src/styles.css` (add a `.markdown-preview` block)
- Reference (unchanged): `apps/web/src/markdown-blocks.ts`, `apps/web/src/asset-url.ts`, `apps/web/src/file-path.ts`

**Interfaces:**
- Consumes: `renderMarkdownBlocks` (Task 1), `assetUrl` (Task 2), `useStore().httpOrigin`, `useStore().openFile`.
- Produces: `MarkdownPreview` component:
  ```ts
  function MarkdownPreview(props: {
    sessionId: string
    path: string
    content: string
    scrollRef?: React.MutableRefObject<HTMLDivElement | null>
  }): JSX.Element
  ```

- [ ] **Step 1: Add `httpOrigin` to the store**

In `apps/web/src/store.tsx`, add to the `Store` interface (near the other config-derived fields, after `setSidebarSettings` in the interface around line 104):

```ts
  /** Server HTTP origin — used to build asset URLs (e.g. markdown images). */
  httpOrigin: string
```

Then in the `StoreProvider`'s context value object (the `const value: Store = { … }` / provider `value={…}` near the end of the provider), add:

```ts
    httpOrigin: config.httpOrigin,
```

- [ ] **Step 2: Write the component**

```tsx
// apps/web/src/MarkdownPreview.tsx
import { type JSX, useMemo, useRef } from 'react'
import { assetUrl } from './asset-url'
import { resolveAgainstCwd } from './file-path'
import { renderMarkdownBlocks } from './markdown-blocks'
import { useStore } from './store'

/** Rendered markdown preview. Relative images resolve through /files/asset; clicking
 *  a linkified file path opens it as a tab (same behavior as chat). The scroll
 *  container is exposed via scrollRef for split-view sync. */
export function MarkdownPreview({
  sessionId,
  path,
  content,
  scrollRef,
}: {
  sessionId: string
  path: string
  content: string
  scrollRef?: React.MutableRefObject<HTMLDivElement | null>
}): JSX.Element {
  const { httpOrigin, openFile } = useStore()
  const fileDir = path.replace(/\/[^/]*$/, '') || '/'
  const localRef = useRef<HTMLDivElement | null>(null)
  const html = useMemo(
    () =>
      renderMarkdownBlocks(content, {
        resolveAsset: (src) => assetUrl({ httpOrigin, sessionId, fileDir, src }),
      }),
    [content, httpOrigin, sessionId, fileDir],
  )

  const onClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a.file-link') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const p = a.getAttribute('data-path')
    if (p) openFile(sessionId, resolveAgainstCwd(fileDir, p))
  }

  return (
    <div
      ref={(el) => {
        localRef.current = el
        if (scrollRef) scrollRef.current = el
      }}
      className="markdown-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px]"
      onClick={onClick}
      // eslint-disable-next-line react/no-danger -- sanitized by renderMarkdownBlocks (DOMPurify)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
```

- [ ] **Step 3: Add preview styles**

Append to `apps/web/src/styles.css`:

```css
/* Rendered markdown preview (.md panels). Scoped so it never touches chat/markdown
   surfaces. Uses theme tokens from the shadcn/Tailwind v4 setup. */
.markdown-preview { line-height: 1.6; }
.markdown-preview h1 { font-size: 1.6em; font-weight: 650; margin: 0.6em 0 0.4em; }
.markdown-preview h2 { font-size: 1.35em; font-weight: 650; margin: 0.6em 0 0.4em; }
.markdown-preview h3 { font-size: 1.15em; font-weight: 600; margin: 0.6em 0 0.3em; }
.markdown-preview p { margin: 0.5em 0; }
.markdown-preview ul, .markdown-preview ol { margin: 0.5em 0; padding-left: 1.5em; }
.markdown-preview li { margin: 0.15em 0; }
.markdown-preview a { color: var(--primary); text-decoration: underline; }
.markdown-preview code { font-family: var(--font-mono, monospace); font-size: 0.92em; }
.markdown-preview :not(pre) > code {
  background: var(--muted); padding: 0.1em 0.3em; border-radius: 4px;
}
.markdown-preview pre {
  background: var(--muted); padding: 0.75em 1em; border-radius: 6px; overflow: auto;
}
.markdown-preview blockquote {
  border-left: 3px solid var(--border); padding-left: 1em; color: var(--muted-foreground);
  margin: 0.5em 0;
}
.markdown-preview table { border-collapse: collapse; margin: 0.5em 0; }
.markdown-preview th, .markdown-preview td {
  border: 1px solid var(--border); padding: 0.3em 0.6em;
}
.markdown-preview img { max-width: 100%; height: auto; }
.markdown-preview .md-block { scroll-margin-top: 0; }
.markdown-preview input[type='checkbox'] { margin-right: 0.4em; }
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/MarkdownPreview.tsx apps/web/src/store.tsx apps/web/src/styles.css
git commit -m "feat(web): MarkdownPreview component + preview styles + store.httpOrigin"
```

---

### Task 6: Scroll-sync math (pure helpers)

**Files:**
- Create: `apps/web/src/scroll-sync.ts`
- Create: `apps/web/src/scroll-sync.test.ts`

**Interfaces:**
- Produces:
  - `interface BlockPos { line: number; top: number }`
  - `topForLine(blocks: BlockPos[], line: number): number` — preview scrollTop that brings the block for `line` to the top.
  - `lineForTop(blocks: BlockPos[], scrollTop: number): number` — source line for the topmost visible preview block.
  - Both assume `blocks` sorted ascending by `top` (== ascending `line`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/scroll-sync.test.ts
import { describe, expect, it } from 'vitest'
import { lineForTop, topForLine, type BlockPos } from './scroll-sync'

const blocks: BlockPos[] = [
  { line: 1, top: 0 },
  { line: 5, top: 100 },
  { line: 9, top: 250 },
]

describe('topForLine', () => {
  it('returns the top of the greatest block at-or-before the line', () => {
    expect(topForLine(blocks, 1)).toBe(0)
    expect(topForLine(blocks, 4)).toBe(0)
    expect(topForLine(blocks, 5)).toBe(100)
    expect(topForLine(blocks, 7)).toBe(100)
    expect(topForLine(blocks, 100)).toBe(250)
  })
  it('returns 0 for a line before the first block', () => {
    expect(topForLine(blocks, 0)).toBe(0)
  })
})

describe('lineForTop', () => {
  it('returns the line of the topmost block at-or-above scrollTop', () => {
    expect(lineForTop(blocks, 0)).toBe(1)
    expect(lineForTop(blocks, 99)).toBe(1)
    expect(lineForTop(blocks, 100)).toBe(5)
    expect(lineForTop(blocks, 260)).toBe(9)
  })
  it('handles empty input', () => {
    expect(lineForTop([], 50)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/scroll-sync.test.ts`
Expected: FAIL — cannot find module `./scroll-sync`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/scroll-sync.ts
export interface BlockPos {
  line: number
  top: number
}

/** The preview scrollTop that brings the block for `line` to the top. */
export function topForLine(blocks: BlockPos[], line: number): number {
  let best = 0
  for (const b of blocks) {
    if (b.line <= line) best = b.top
    else break
  }
  return best
}

/** The source line for the topmost visible preview block at `scrollTop`. */
export function lineForTop(blocks: BlockPos[], scrollTop: number): number {
  let best = blocks[0]?.line ?? 1
  for (const b of blocks) {
    if (b.top <= scrollTop + 1) best = b.line
    else break
  }
  return best
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/scroll-sync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/scroll-sync.ts apps/web/src/scroll-sync.test.ts
git commit -m "feat(web): scroll-sync math for split-view preview/source"
```

---

### Task 7: `MarkdownFilePanel` container + Workspace wiring

The file-tab panel. Owns the document (Task 3), renders the header + (for markdown) a Preview · Source · Split toggle, and composes the children. Non-markdown files render Source only (today's behavior). Split mounts both panes (scroll sync added in Task 8). On mobile, Split is hidden.

**Files:**
- Create: `apps/web/src/MarkdownFilePanel.tsx`
- Modify: `apps/web/src/Workspace.tsx:25-27, 226-232` (lazy-import + render `MarkdownFilePanel` instead of `FileEditorPanel`)
- Delete: `apps/web/src/FileEditorPanel.tsx` (logic now lives in the new files)
- Reference (unchanged): `apps/web/src/hooks/use-is-mobile.ts`, `apps/web/src/editor-save.ts`

**Interfaces:**
- Consumes: `useFileDocument` (Task 3), `SourceEditor` (Task 4), `MarkdownPreview` (Task 5), `useIsMobile()`.
- Produces: `MarkdownFilePanel` component:
  ```ts
  function MarkdownFilePanel(props: { sessionId: string; path: string; onClose: () => void }): JSX.Element
  ```
  Same props as the old `FileEditorPanel`, so Workspace wiring is a one-line swap.

- [ ] **Step 1: Confirm the mobile hook's export name**

Run: `sed -n '1,40p' apps/web/src/hooks/use-is-mobile.ts`
Expected: note the exported hook name (e.g. `useIsMobile`). Use that exact name below; if it differs, adjust the import.

- [ ] **Step 2: Write the container**

```tsx
// apps/web/src/MarkdownFilePanel.tsx
import type { EditorView } from '@codemirror/view'
import { Columns2, Eye, Pencil, Save, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { canSave } from './editor-save'
import { useIsMobile } from './hooks/use-is-mobile'
import { MarkdownPreview } from './MarkdownPreview'
import { SourceEditor } from './SourceEditor'
import { useFileDocument } from './useFileDocument'

type Mode = 'preview' | 'source' | 'split'

function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

const MODE_KEY = (id: string): string => `podium.mdmode:${id}`
function loadMode(id: string, fallback: Mode): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY(id))
    return v === 'preview' || v === 'source' || v === 'split' ? v : fallback
  } catch {
    return fallback
  }
}

/** One open file rendered as a workspace panel. Markdown files default to a rendered
 *  preview with Preview/Source/Split modes; other files render the source editor as
 *  before. */
export function MarkdownFilePanel({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string
  path: string
  onClose: () => void
}): JSX.Element {
  const doc = useFileDocument(sessionId, path)
  const md = isMarkdown(path)
  const mobile = useIsMobile()
  const tabId = `file:${sessionId}:${path}`
  const [mode, setMode] = useState<Mode>(() => loadMode(tabId, md ? 'preview' : 'source'))
  const viewRef = useRef<EditorView | null>(null)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)

  // Persist mode per tab; collapse split → source on mobile (no room for two panes).
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY(tabId), mode)
    } catch {
      /* best-effort */
    }
  }, [tabId, mode])
  useEffect(() => {
    if (mobile && mode === 'split') setMode('source')
  }, [mobile, mode])

  const handleClose = (): void => {
    if (doc.dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    onClose()
  }

  const showSource = !md || mode === 'source' || mode === 'split'
  const showPreview = md && (mode === 'preview' || mode === 'split')
  const fileKey = `${sessionId}:${path}:${doc.reloadNonce}`

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {path}
          {doc.dirty && (
            <span className="ml-1 text-amber-500" aria-label="unsaved changes">
              ●
            </span>
          )}
        </span>
        {md && (
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <ModeButton active={mode === 'preview'} onClick={() => setMode('preview')} title="Preview">
              <Eye size={13} />
            </ModeButton>
            <ModeButton active={mode === 'source'} onClick={() => setMode('source')} title="Source">
              <Pencil size={13} />
            </ModeButton>
            {!mobile && (
              <ModeButton active={mode === 'split'} onClick={() => setMode('split')} title="Split">
                <Columns2 size={13} />
              </ModeButton>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => void doc.save()}
          disabled={!canSave({ editable: doc.editable, dirty: doc.dirty, saving: doc.saving })}
          aria-label="Save"
          title="Save (⌘S)"
          className="text-muted-foreground disabled:opacity-30"
        >
          <Save size={14} />
        </button>
        <button type="button" onClick={handleClose} aria-label="Close" className="text-muted-foreground">
          <X size={16} />
        </button>
      </div>

      {doc.status === 'error' ? (
        <div className="p-4 text-sm text-muted-foreground">{doc.message}</div>
      ) : doc.status === 'loading' ? (
        <div className="p-4 text-sm text-muted-foreground/60">Loading…</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {showSource && (
            <div className={`flex min-w-0 flex-1 ${showPreview ? 'border-r border-border' : ''}`}>
              <SourceEditor
                key={fileKey}
                path={path}
                initialContent={doc.content}
                editable={doc.editable}
                onChange={doc.setContent}
                onSave={() => void doc.save()}
                viewRef={viewRef}
              />
            </div>
          )}
          {showPreview && (
            <div className="flex min-w-0 flex-1">
              <MarkdownPreview
                sessionId={sessionId}
                path={path}
                content={doc.content}
                scrollRef={previewScrollRef}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-6 w-6 items-center justify-center rounded ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 3: Wire Workspace to the new panel**

In `apps/web/src/Workspace.tsx`, replace the lazy import (lines 25-27):

```tsx
const MarkdownFilePanel = lazy(() =>
  import('./MarkdownFilePanel').then((m) => ({ default: m.MarkdownFilePanel })),
)
```

And replace the render usage (lines 226-232) inside the `myFileTabs.map` body:

```tsx
              <Suspense fallback={null}>
                <MarkdownFilePanel
                  sessionId={f.sessionId}
                  path={f.path}
                  onClose={() => closeFileTab(f.id)}
                />
              </Suspense>
```

- [ ] **Step 4: Delete the obsolete panel**

```bash
git rm apps/web/src/FileEditorPanel.tsx
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: exit 0. (If anything else imported `FileEditorPanel`, repoint it to `MarkdownFilePanel` — `grep -rn FileEditorPanel apps/web/src` should return nothing.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/MarkdownFilePanel.tsx apps/web/src/Workspace.tsx
git commit -m "feat(web): MarkdownFilePanel with Preview/Source/Split modes; replace FileEditorPanel"
```

---

### Task 8: Split-view synchronized scrolling

Wire the CodeMirror view and the preview scroll container together in Split mode using the Task 6 helpers, with a feedback-loop guard.

**Files:**
- Modify: `apps/web/src/MarkdownFilePanel.tsx` (add a sync effect)
- Reference (unchanged): `apps/web/src/scroll-sync.ts`

**Interfaces:**
- Consumes: `viewRef` (CodeMirror `EditorView`), `previewScrollRef` (preview `HTMLDivElement`), `topForLine`, `lineForTop`.

- [ ] **Step 1: Add the sync effect to `MarkdownFilePanel`**

Add this import at the top of `MarkdownFilePanel.tsx`:

```tsx
import { EditorView as CMView } from '@codemirror/view'
import { lineForTop, topForLine, type BlockPos } from './scroll-sync'
```

Add this effect inside the component, after the existing effects (it only runs in split mode; it re-arms whenever the rendered content changes):

```tsx
  // Split-mode scroll sync: map the editor's top visible line <-> the preview's
  // top visible block via data-source-line anchors. A guard flag prevents the two
  // scroll handlers from ping-ponging.
  useEffect(() => {
    if (mode !== 'split') return
    const view = viewRef.current
    const preview = previewScrollRef.current
    if (!view || !preview) return

    const blocks = (): BlockPos[] => {
      const top = preview.getBoundingClientRect().top - preview.scrollTop
      return Array.from(preview.querySelectorAll<HTMLElement>('[data-source-line]')).map((el) => ({
        line: Number(el.getAttribute('data-source-line')) || 1,
        top: el.getBoundingClientRect().top - top,
      }))
    }

    let lock = false
    const release = (): void => {
      lock = false
    }

    const onEditorScroll = (): void => {
      if (lock) return
      lock = true
      const line = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number
      preview.scrollTop = topForLine(blocks(), line)
      requestAnimationFrame(release)
    }
    const onPreviewScroll = (): void => {
      if (lock) return
      lock = true
      const line = lineForTop(blocks(), preview.scrollTop)
      const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
      view.dispatch({ effects: CMView.scrollIntoView(pos, { y: 'start' }) })
      requestAnimationFrame(release)
    }

    view.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })
    return () => {
      view.scrollDOM.removeEventListener('scroll', onEditorScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
    }
  }, [mode, doc.content])
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Build (verifies the web bundle compiles end-to-end)**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/MarkdownFilePanel.tsx
git commit -m "feat(web): synchronized scrolling for markdown split view"
```

---

### Task 9: Runtime verification of the frontend core

The interactive pieces (CodeMirror, preview render, mode toggle, sync scroll) require in-browser verification — unit tests + build are not sufficient (project lesson). Verify against the dev host or a local `vite preview`.

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite + typecheck + build green**

Run: `bun run typecheck && bun run test && (cd apps/web && bun run build)`
Expected: typecheck exit 0; vitest all green; web build succeeds.

- [ ] **Step 2: Open the app and verify the checklist**

Open the running app (dev host per project notes, or `cd apps/web && bun run preview`). In a session whose cwd is this repo, open `docs/markdown-preview-samples/showcase.md` (click a file link or use the file-open path). Verify each:

- [ ] The file opens in **Preview** by default — rendered headings/lists/table/blockquote/task list, NOT raw source.
- [ ] The header shows a **Preview · Source · Split** toggle.
- [ ] **Source** shows the CodeMirror editor with the raw markdown; editing marks the dirty `●`; ⌘/Ctrl+S saves (toast "Saved").
- [ ] After an edit in Source, switching to **Preview** reflects the change.
- [ ] **Split** shows source (left) + preview (right); scrolling either pane scrolls the other in step.
- [ ] On a narrow viewport, Split is hidden (Preview · Source only).
- [ ] A non-markdown file (e.g. a `.ts`) still opens directly in the source editor with no mode toggle (unchanged behavior).
- [ ] The relative image shows a broken/placeholder image (expected until Phase 2).

- [ ] **Step 3: Record the result**

Note pass/fail per item in the task tracker. Fix regressions before proceeding. Do not claim completion without having performed these in-browser checks.

---

## Phase 2 — Image/asset pipeline (daemon → server → preview)

### Task 10: `fileAsset` protocol messages

**Files:**
- Modify: `packages/protocol/src/messages.ts` (add two schemas; register in both unions)
- Create: `packages/protocol/src/file-asset-messages.test.ts`
- Reference (unchanged): `packages/protocol/src/file-messages.test.ts` (mirror its style)

**Interfaces:**
- Produces: `FileAssetRequestMessage` (added to `ControlMessage` union), `FileAssetResultMessage` (added to `DaemonMessage` union), and their inferred types.
  ```ts
  FileAssetRequestMessage = { type: 'fileAssetRequest'; requestId: string; cwd: string; path: string; knownPath: boolean }
  FileAssetResultMessage  = { type: 'fileAssetResult'; requestId: string; ok: boolean; path: string;
                              dataBase64?: string; contentType?: string; tooLarge?: boolean; error?: string }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/src/file-asset-messages.test.ts
import { describe, expect, it } from 'vitest'
import { ControlMessage, DaemonMessage } from './messages'

describe('file asset messages', () => {
  it('accepts a fileAssetRequest in ControlMessage', () => {
    const m = ControlMessage.parse({
      type: 'fileAssetRequest', requestId: 'fa1', cwd: '/w', path: '/w/a.png', knownPath: false,
    })
    expect(m.type).toBe('fileAssetRequest')
  })
  it('accepts a fileAssetResult in DaemonMessage', () => {
    const m = DaemonMessage.parse({
      type: 'fileAssetResult', requestId: 'fa1', ok: true, path: '/w/a.png',
      dataBase64: 'AAAA', contentType: 'image/png',
    })
    expect(m.ok).toBe(true)
    if (m.type === 'fileAssetResult') expect(m.contentType).toBe('image/png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bunx vitest run src/file-asset-messages.test.ts`
Expected: FAIL — union does not accept `fileAssetRequest`/`fileAssetResult`.

- [ ] **Step 3: Add the schemas**

In `packages/protocol/src/messages.ts`, immediately after the `FileReadRequestMessage` block (around line 518), add:

```ts
export const FileAssetRequestMessage = z.object({
  type: z.literal('fileAssetRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  /** Server-asserted transcript-known path; allows reading outside cwd. Read-only. */
  knownPath: z.boolean(),
})
export type FileAssetRequestMessage = z.infer<typeof FileAssetRequestMessage>
```

And immediately after the `FileReadResultMessage` block (around line 752), add:

```ts
export const FileAssetResultMessage = z.object({
  type: z.literal('fileAssetResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string(),
  /** Base64-encoded file bytes (images etc.). */
  dataBase64: z.string().optional(),
  contentType: z.string().optional(),
  tooLarge: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileAssetResultMessage = z.infer<typeof FileAssetResultMessage>
```

- [ ] **Step 4: Register in the unions**

In the `ControlMessage` discriminated union (around line 627, after `FileReadRequestMessage,`) add a line:

```ts
  FileAssetRequestMessage,
```

In the `DaemonMessage` discriminated union (around line 798, after `FileReadResultMessage,`) add a line:

```ts
  FileAssetResultMessage,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/protocol && bunx vitest run src/file-asset-messages.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Build protocol + commit**

```bash
cd packages/protocol && bun run build && cd ../..
git add packages/protocol/src/messages.ts packages/protocol/src/file-asset-messages.test.ts
git commit -m "feat(protocol): fileAssetRequest/fileAssetResult messages"
```

(`bun run build` refreshes the protocol's `dist` that the server/daemon import.)

---

### Task 11: Daemon `readAssetSandboxed` + request handler

**Files:**
- Modify: `apps/daemon/src/file-access.ts` (add `readAssetSandboxed`)
- Modify: `apps/daemon/src/daemon.ts:1111-1115` (add a `fileAssetRequest` case beside `fileReadRequest`)
- Modify/Create: `apps/daemon/src/file-access.test.ts` (add asset cases; mirror existing read tests)

**Interfaces:**
- Consumes: `isInside` (existing), `FileAssetResultMessage` (Task 10).
- Produces: `readAssetSandboxed(opts: { cwd: string; path: string; knownPath: boolean }): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>>` — same sandbox check as `readFileSandboxed`, but returns base64 bytes + content-type and allows binary; 10 MB cap.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/file-access.test.ts` (mirror the file's existing temp-dir setup; the self-contained version below works regardless):

```ts
import { mkdtemp, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAssetSandboxed } from './file-access'

describe('readAssetSandboxed', () => {
  it('returns base64 bytes + content-type for an in-sandbox image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    const png = Buffer.from('89504e470d0a1a0a', 'hex') // PNG magic bytes
    await writeFileFs(join(dir, 'a.png'), png)
    const r = await readAssetSandboxed({ cwd: dir, path: join(dir, 'a.png'), knownPath: false })
    expect(r.ok).toBe(true)
    expect(r.contentType).toBe('image/png')
    expect(Buffer.from(r.dataBase64 ?? '', 'base64').equals(png)).toBe(true)
  })
  it('rejects a path outside the sandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    const r = await readAssetSandboxed({ cwd: dir, path: '/etc/hosts', knownPath: false })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('outside workspace')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && bunx vitest run src/file-access.test.ts`
Expected: FAIL — `readAssetSandboxed` is not exported.

- [ ] **Step 3: Implement `readAssetSandboxed`**

In `apps/daemon/src/file-access.ts`: extend the type import on line 3 and add the function after `readFileSandboxed`:

```ts
// line 3 — add FileAssetResultMessage:
import type { FileAssetResultMessage, FileReadResultMessage, FileWriteResultMessage } from '@podium/protocol'
```

```ts
const MAX_ASSET_BYTES = 10 * 1024 * 1024

const ASSET_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon',
}

type AssetResult = Omit<FileAssetResultMessage, 'type' | 'requestId'>

/** Read a (possibly binary) asset's bytes for the markdown preview, sandboxed to the
 *  session cwd exactly like readFileSandboxed. Returns base64 + a content-type. */
export async function readAssetSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
}): Promise<AssetResult> {
  const { cwd, path, knownPath } = opts
  let realCwd: string
  let real: string
  try {
    realCwd = await realpath(cwd)
    real = await realpath(path)
  } catch {
    return { ok: false, path, error: 'not found' }
  }
  if (!isInside(real, realCwd) && !knownPath) return { ok: false, path, error: 'outside workspace' }
  try {
    const st = await stat(real)
    if (!st.isFile()) return { ok: false, path, error: 'not a file' }
    if (st.size > MAX_ASSET_BYTES) return { ok: false, path, tooLarge: true }
    const buf = await readFile(real)
    const ext = real.split('.').pop()?.toLowerCase() ?? ''
    return {
      ok: true,
      path,
      dataBase64: buf.toString('base64'),
      contentType: ASSET_CONTENT_TYPES[ext] ?? 'application/octet-stream',
    }
  } catch {
    return { ok: false, path, error: 'read error' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/daemon && bunx vitest run src/file-access.test.ts`
Expected: PASS (including the existing read/write tests).

- [ ] **Step 5: Add the daemon request handler**

In `apps/daemon/src/daemon.ts`: import `readAssetSandboxed` alongside `readFileSandboxed` (find the existing `import { readFileSandboxed` from `./file-access`), then add a case beside `fileReadRequest` (around line 1115):

```ts
      case 'fileAssetRequest':
        void readAssetSandboxed({ cwd: msg.cwd, path: msg.path, knownPath: msg.knownPath }).then((r) =>
          send({ type: 'fileAssetResult', requestId: msg.requestId, ...r }),
        )
        break
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add apps/daemon/src/file-access.ts apps/daemon/src/file-access.test.ts apps/daemon/src/daemon.ts
git commit -m "feat(daemon): readAssetSandboxed + fileAssetRequest handler"
```

---

### Task 12: Server relay `readAsset`

**Files:**
- Modify: `apps/server/src/relay.ts` (add `pendingFileAssets`, `readAsset`, `fileAssetResult` case; extend the type import)
- Reference (unchanged): `apps/server/src/file-relay.test.ts` (mirror its harness for Step 1 if it already drives `readFile`; otherwise relay correctness is covered by Task 13 + Task 14)

**Interfaces:**
- Consumes: `daemonRequest` (existing), `FileAssetResultMessage` (Task 10), `knownPathsFor` (existing, already used by `readFile`).
- Produces: `relay.readAsset({ sessionId, path }): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>>`.

- [ ] **Step 1: Extend the protocol type import**

In `apps/server/src/relay.ts`, add `FileAssetResultMessage` to the existing `@podium/protocol` type import that already includes `FileReadResultMessage`.

- [ ] **Step 2: Add the pending map**

Beside `pendingFileReads` (lines 77-80) add:

```ts
  private readonly pendingFileAssets = new Map<
    string,
    (r: Omit<FileAssetResultMessage, 'type' | 'requestId'>) => void
  >()
```

- [ ] **Step 3: Add the result handler**

In the daemon-message switch, beside the `case 'fileReadResult':` block (lines 1056-1063), add:

```ts
      case 'fileAssetResult': {
        const resolve = this.pendingFileAssets.get(msg.requestId)
        if (resolve) {
          this.pendingFileAssets.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
```

- [ ] **Step 4: Add the `readAsset` method**

Beside `readFile` (lines 1129-1146) add:

```ts
  readAsset({
    sessionId,
    path,
  }: {
    sessionId: string
    path: string
  }): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, path, error: 'no session' })
    const knownPath = knownPathsFor(session.transcriptItems()).has(path)
    return this.daemonRequest(
      this.pendingFileAssets,
      'fa',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, error: 'timeout' }),
      (requestId) => ({ type: 'fileAssetRequest', requestId, cwd: session.cwd, path, knownPath }),
    )
  }
```

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add apps/server/src/relay.ts
git commit -m "feat(server): relay.readAsset (fileAsset round-trip mirror of readFile)"
```

---

### Task 13: Hono `GET /files/asset` route

**Files:**
- Create: `apps/server/src/file-asset-route.ts`
- Create: `apps/server/src/file-asset-route.test.ts`
- Modify: `apps/server/src/server.ts:24-30` (register the route)

**Interfaces:**
- Consumes: a reader with `readAsset({ sessionId, path }): Promise<{ ok: boolean; dataBase64?: string; contentType?: string; tooLarge?: boolean; error?: string }>` (the relay from Task 12).
- Produces: `registerAssetRoute(app: Hono, registry: AssetReader): void` — wires `GET /files/asset?sessionId=&path=`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/file-asset-route.test.ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerAssetRoute, type AssetReader } from './file-asset-route'

const stub = (r: Awaited<ReturnType<AssetReader['readAsset']>>): AssetReader => ({
  readAsset: async () => r,
})

describe('GET /files/asset', () => {
  it('returns bytes with content-type for a valid asset', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true, dataBase64: Buffer.from('PNGDATA').toString('base64'), contentType: 'image/png' }))
    const res = await app.request('/files/asset?sessionId=s&path=/w/a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA')
  })
  it('404s when the read is not ok (e.g. outside sandbox)', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: false, error: 'outside workspace' }))
    const res = await app.request('/files/asset?sessionId=s&path=/etc/passwd')
    expect(res.status).toBe(404)
  })
  it('400s on missing params', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true }))
    const res = await app.request('/files/asset')
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bunx vitest run src/file-asset-route.test.ts`
Expected: FAIL — cannot find module `./file-asset-route`.

- [ ] **Step 3: Write the route**

```ts
// apps/server/src/file-asset-route.ts
import type { Hono } from 'hono'

export interface AssetReader {
  readAsset(a: { sessionId: string; path: string }): Promise<{
    ok: boolean
    dataBase64?: string
    contentType?: string
    tooLarge?: boolean
    error?: string
  }>
}

/** Serve a markdown-relative asset (image) as raw bytes. Auth model matches the rest
 *  of the HTTP surface: the session must exist (readAsset returns ok:false otherwise);
 *  the daemon enforces the path sandbox. */
export function registerAssetRoute(app: Hono, registry: AssetReader): void {
  app.get('/files/asset', async (c) => {
    const sessionId = c.req.query('sessionId')
    const path = c.req.query('path')
    if (!sessionId || !path) return c.text('bad request', 400)
    const r = await registry.readAsset({ sessionId, path })
    if (!r.ok || !r.dataBase64) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
    const bytes = Buffer.from(r.dataBase64, 'base64')
    return c.body(bytes, 200, {
      'content-type': r.contentType ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bunx vitest run src/file-asset-route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the route in the server**

In `apps/server/src/server.ts`, import and call `registerAssetRoute` where `registry` is in scope (right after `const app = new Hono()` and the `/health` line, around line 25):

```ts
import { registerAssetRoute } from './file-asset-route'
// …
const app = new Hono()
app.get('/health', (c) => c.text('ok'))
registerAssetRoute(app, registry)
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add apps/server/src/file-asset-route.ts apps/server/src/file-asset-route.test.ts apps/server/src/server.ts
git commit -m "feat(server): GET /files/asset route serving sandboxed image bytes"
```

---

### Task 14: End-to-end image verification

**Files:**
- Modify: `docs/markdown-preview-samples/showcase.md` already references `./diagram.png`
- Create: `docs/markdown-preview-samples/diagram.png` (a real small PNG)

- [ ] **Step 1: Create a real PNG next to the showcase**

```bash
# 1x1 red PNG, base64-decoded to a real file
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > docs/markdown-preview-samples/diagram.png
```

- [ ] **Step 2: Verify the route directly (server running)**

With the app/server running, request the asset for a session whose cwd is this repo (substitute a real `sessionId` and the absolute repo path):

```bash
curl -sS -o /tmp/asset.png -w '%{http_code} %{content_type}\n' \
  "http://<host>:<port>/files/asset?sessionId=<sid>&path=<REPO>/docs/markdown-preview-samples/diagram.png"
# Expect: 200 image/png ; file /tmp/asset.png reports "PNG image data"
```

Also confirm the sandbox rejects traversal:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://<host>:<port>/files/asset?sessionId=<sid>&path=/etc/passwd"
# Expect: 404
```

- [ ] **Step 3: In-browser verification**

Open `docs/markdown-preview-samples/showcase.md` in the app (Preview mode). Verify:

- [ ] The "Image" section shows the rendered PNG (not a broken-image icon).
- [ ] In Split mode the image still renders and scroll-sync still works.
- [ ] DevTools Network shows the `<img>` request hitting `/files/asset?...` returning `200 image/png`.

- [ ] **Step 4: Commit**

```bash
git add docs/markdown-preview-samples/diagram.png
git commit -m "test(web): showcase image fixture for end-to-end asset verification"
```

---

## Phase 3 — Optional polish

### Task 15 (optional): Syntax-highlighted code blocks in preview

v1 renders fenced code monospaced (diff blocks already colorized). Full syntax highlighting is deferred to keep the core lean. If desired, highlight statically using the CodeMirror language packages already loaded via `editor-lang.ts` (`@codemirror/language` `highlightTree` + the lazy language extensions), falling back to plain `<pre><code>` for unknown languages — no new dependency. Implement as a post-process over the rendered `<pre><code class="language-*">` nodes inside `renderMarkdownBlocks` (or a follow-up pass in `MarkdownPreview`), with its own unit test asserting highlight spans appear for a known language. Skip if not needed.

---

## Self-Review (completed by plan author)

- **Spec coverage:** preview-by-default (Task 7) ✓; Preview/Source/Split modes (Task 7) ✓; synced scroll (Tasks 6+8) ✓; source editing + dirty/save/conflict preserved (Tasks 3+4+7) ✓; full preview incl. relative images (Tasks 1,2,5 + 10–14) ✓; source-line↔block map / annotation seam (Task 1 `data-source-line`) ✓; non-markdown unchanged (Task 7) ✓; mobile hides split (Task 7) ✓; test-markdown fixtures (Tasks 1+14) ✓; daemon binary-read pipeline (Tasks 10–13) ✓. Syntax highlighting is explicitly deferred to optional Task 15 (flagged, not silently dropped).
- **Placeholder scan:** none — every code step contains complete code; `<host>/<port>/<sid>/<REPO>` in Task 14 are runtime substitutions, not code placeholders.
- **Type consistency:** `useFileDocument` → `{ content, contentRef, setContent, save, reload, reloadNonce, … }` consumed unchanged by `SourceEditor`/`MarkdownFilePanel`; `renderMarkdownBlocks(text, { resolveAsset })` consumed by `MarkdownPreview`; `assetUrl({ httpOrigin, sessionId, fileDir, src })` returns `string | null`; `BlockPos { line, top }` shared by `topForLine`/`lineForTop` and the Task 8 effect; `readAssetSandboxed`/`readAsset`/`AssetReader.readAsset` all share the `{ ok, dataBase64?, contentType?, tooLarge?, error? }` shape. Consistent.
