# Unified issue presentation

## Decision

Use one semantic issue-reference language everywhere an issue is mentioned outside the primary work sidebar and full task view:

`[StageGlyph] [POD-123] [Title]`

The Linear-style `StageGlyph` is the leading icon and carries workflow status. The reference and title are density-dependent, but their order and meaning never change. Issue colour may tint a surrounding surface, but it must not replace workflow status. `needsHuman`, blocked, unread, agent activity, and git state remain secondary signals; they must not overload the stage icon.

The primary work/sidebar rows and the full task view remain unchanged. They already have enough space and richer state models, and both already subscribe to live issue data.

## Current surface inventory

| Surface | Current issue presentation | Live today? | Proposed treatment |
| --- | --- | --- | --- |
| Web Tasks board/list | Board cards, grouped list rows, stage headers | Yes | Primary task view: leave unchanged |
| Web work sidebar/right rail | `IdSquare`, title, activity/status line, badges | Yes | Sidebar: leave unchanged |
| Web full task page | Status property, sub-task and relation rows | Yes | Full task view: leave page chrome unchanged; use the shared reference row only for related tasks |
| Docked task panel / issue peek drawer | Stage pill in header; stage glyphs, plain dots, and text in child/relation rows | Yes | Keep the full panel header; normalize every referenced child/relation to the shared row |
| Web chat, including Superagent transcript | Static generic issue chip produced from sanitized markdown | No inline status; opened miniview is live | Hydrate each issue token from the replica and render the live stage glyph in the chip |
| Native terminal | Static highlighted/underlined terminal token | No inline status; opened miniview is live | Extend the existing terminal overlay with resolved stage data and a stage glyph treatment without changing the terminal buffer |
| Floating reference miniview | Ref text plus a separate stage pill | Yes while open | Use the shared reference header: stage glyph, ref, title |
| Superagent fresh-thread `@` picker | Repos, worktrees, conversations only; inserted value is plain textarea text | Options are live, but issues are absent | Add live issue results using the shared reference row; insert the canonical `POD-N` token |
| Regular agent chat composer | No `@` picker | N/A | Reuse the same mention controller and issue option renderer when mentions land |
| Superagent Tray / offer cards | Issue-colour marker, ref, title; no workflow stage | Yes | Put the stage glyph before ref/title; keep issue colour as card identity tint |
| Command palette issue navigation | Title plus textual stage hint | Yes | Stage glyph, ref, title; remove the duplicate stage hint |
| Issue target pickers | Mostly `ref + title` strings | Yes | Render the shared compact row where the picker supports rich options |
| Approval dialog / destructive menu headers | Plain issue long form or ref | Payload/context scoped | Leave plain: these identify an already-selected target and often do not carry a live issue projection |
| Mobile Tasks and Work screens | `IdSquare`-based primary task/work rows | Yes | Primary task/sidebar equivalents: leave unchanged |
| Mobile chat transcript | Static styled `POD-N` text; lookup is hard-coded to the `POD-` prefix | No inline status; peek sheet is live | Resolve through the shared ref grammar and live issue collection; prepend the native stage glyph treatment |
| Mobile task peek / Tray / proposal screening | `IdSquare`, stage text, or ref/title combinations | Yes | Keep the full peek/screening chrome; normalize referenced task headers in Tray and compact contexts |

Session references (`POD-123-A`, `POD-DRAFT-2`) remain terminal/session references. They use the existing terminal icon and are not forced into the issue stage language.

## Shared model and adapters

Create a pure `issueReferenceModel(ref, issues)` projection in client-core. It resolves the canonical ref and returns identity, title, stage, availability, and an accessible label. It must represent unresolved, hidden, archived, and deleted references without inventing status.

Render that model through small surface adapters rather than duplicating lookup and status rules:

- `IssueReference` for ordinary React rows, chips, cards, menus, and miniview headers.
- A DOM hydrator for sanitized web chat markdown. Existing `data-ref` anchors remain safe static HTML; the hydrator subscribes to issue replica changes and updates their stage/accessibility attributes. This avoids replacing the whole Markdown renderer.
- A terminal overlay adapter. The terminal buffer remains untouched so selection and copy still return the original `POD-N`; the existing viewport overlay receives `resolveReference(ref)` instead of only `isKnownPrefix(prefix)` and repaints on issue changes.
- `IssueReferenceNative` / a native text adapter for React Native markdown and compact rows, driven by the same model and shared stage-to-meaning mapping.

The adapters may differ mechanically, but the visible grammar, status mapping, fallback states, and accessibility text come from one model.

## Live-update contract

A rendered issue reference stores only its stable canonical ref. It never stores a title or stage snapshot. Resolution always reads the current replica projection, so an `issues.update`, close/reopen, archive, or deletion broadcast updates every mounted reference without rewriting transcript history.

Expected transitions:

- `planning -> in_progress -> review -> done` morphs only the leading stage glyph.
- Title edits update expanded reference rows/cards; compact transcript tokens remain `POD-N` and only update their glyph.
- Deleted, archived, invisible, and temporarily missing issues do not retain stale status. They fall back to an unresolved/quiet icon and an honest accessible label.
- Re-opening an old transcript resolves against current issue state, not the state when the message was written.

The existing floating miniview already proves the data path: it resolves a stable ref against live issues and re-renders while open. The missing part is applying the same live resolution to the inline token adapters.

## Mention behavior

Issue mentions are not yet implemented in the ordinary chat composer. The only current `@` picker is the fresh Superagent composer, and it currently searches repos, worktrees, and conversations.

The practical first version is:

1. Include live issue options in the shared `@` picker, rendered as stage glyph + ref + title.
2. Insert the canonical plain-text ref (`POD-N`) into the textarea, so it survives transport and becomes a live issue reference in the sent transcript.
3. Reuse that controller in Superagent and native-agent chat composers.

Showing a rich live glyph *inside* the textarea itself requires replacing the textarea with a structured editor or maintaining a precisely aligned visual overlay. That is a separate editor-level change and is not required for consistent mention selection or live sent references.

## Terminal constraint

Xterm output is a fixed cell buffer, so an HTML icon cannot simply be inserted before a token without shifting or covering adjacent terminal text. The safe implementation is to extend the existing pointer-events-none ref overlay: keep the underlying token intact, render stage-aware decoration over its allocated cells, and expose stage/title in the hover tooltip. A full icon-plus-ref redraw can be evaluated visually, but it must preserve selection, copy, cursor highlighting, wrapped rows, WebGL/DOM parity, and dense adjacent text. If it fails those checks, use stage-specific shape/colour in the overlay and keep the full glyph in the live miniview.

## Recommended delivery slices

1. Shared reference model and web `IssueReference`; replace duplicate relation/sub-task, miniview, Tray, palette, and rich picker presentations.
2. Live web transcript hydration for ordinary chat, envelopes, and Superagent.
3. Shared `@` issue search/controller for Superagent and regular chat; plain canonical insertion.
4. Terminal live-stage overlay and tooltip, verified in both WebGL and DOM renderers.
5. Native mobile ref resolution, stage treatment, and prefix-generalized navigation.

Each slice is independently reviewable, but the shared model must land first so later surfaces do not create another status mapping.
