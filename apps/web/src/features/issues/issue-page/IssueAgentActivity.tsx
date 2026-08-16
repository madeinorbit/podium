/**
 * THE AGENT-ACTIVITY PANEL (issues.panel) — what an agent PRODUCED for the
 * human: artifacts with inline image/video previews plus a lightbox, and
 * deferred items. Split out of IssuePage.tsx (POD-646); sections render only
 * when non-empty, so an issue with no panel adds no chrome.
 *
 * -------------------------------------------------------------------------
 * WHAT LEFT THIS PANEL, AND WHY (POD-1163).
 * -------------------------------------------------------------------------
 *
 * TODOS. The panel led with an agent's own todo list — a progress meter, a
 * percentage, a checkbox per line, and a fold for the done ones — directly
 * under the description, above the sub-tasks. That put an agent's private
 * working checklist in the loudest position on a human's page, and put it
 * immediately above SUB-TASKS, which is the same idea rendered a second way
 * with real issues behind it. The dock's inspector already refuses to show
 * todos for exactly this reason (`IssuePanelView.inspector.test.tsx`: "never
 * todos"); this surface now agrees with it. The panel's todo data, the
 * `panelApply` todo-done op and the CLI that writes them are untouched — the
 * agent still keeps its list, the human's page just isn't where it is kept.
 *
 * THE ATTRIBUTION PAIR. It used to head this panel as `Published by user:sole ·
 * for user:sole` — raw field vocabulary, mid-document, saying one id twice on
 * the ordinary row. §3.1.3 A3's requirement is that the pair be READ and never
 * synthesised, which says nothing about where it lives; A4's "work an agent did
 * is owned by its delegating human" is a provenance fact, and provenance is the
 * rail's tail. It now renders there, in words, as the Origin block's `Created
 * by` line (./IssueAbout.tsx over ./issue-provenance.ts). Both halves are still
 * read from `issue.createdBy` alone and a row without a pair still shows none.
 *
 * The reason it was ever a per-ISSUE line rather than a per-ITEM one still
 * holds and is worth keeping: `IssuePanelArtifact` and `IssuePanelDeferred`
 * carry text/path/addedAt and no `Attribution` at all, so a per-item pair would
 * have to be invented — the one thing A3 forbids.
 *
 * NO PAYLOAD ISSUED FROM HERE CARRIES IDENTITY: `openArtifact` /
 * `openFileInWorktree` send paths. `issue-page-commands.ts` mentions no actor,
 * owner or origin anywhere, and `payload-identity.test.ts` keeps it that way.
 */

import { shallowEqual } from '@podium/client-core'
import { relativeTime } from '@podium/client-core/focus'
import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact } from '@podium/model/browser'
import { FileText, Play } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { type IssueViewModel, useStoreSelector } from '@/app/store'
import { MediaLightbox } from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { SectionHeading } from './chrome'

export function IssueAgentActivity({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  const { httpOrigin, openFileInWorktree, openArtifact } = useStoreSelector(
    (s) => ({
      httpOrigin: s.httpOrigin,
      openFileInWorktree: s.openFileInWorktree,
      openArtifact: s.openArtifact,
    }),
    shallowEqual,
  )
  const [lightbox, setLightbox] = useState<{
    kind: 'image' | 'video'
    src: string
    label: string
  } | null>(null)

  const artifacts = issue.panel?.artifacts ?? []
  const deferred = issue.panel?.deferred ?? []
  if (artifacts.length === 0 && deferred.length === 0) return null

  // An issue with no dedicated worktree is worked in the repo's primary
  // checkout — serve its artifacts from there.
  const root = issue.worktreePath ?? issue.repoPath

  const openArtifactFile = (a: IssuePanelArtifact): void => {
    if (a.artifactId) {
      openArtifact({
        issueId: issue.id,
        artifactId: a.artifactId,
        path: a.entry ?? basename(a.path),
        ...(root ? { worktreePath: root } : {}),
      })
      return
    }
    if (!root) return
    // Legacy path-only artifacts open from the live worktree, owned by this
    // issue (POD-149) so the tab lands in — and stays in — its strip.
    openFileInWorktree({
      machineId: issue.machineId,
      root,
      path: a.path.startsWith('/') ? a.path : `${root}/${a.path}`,
      issueId: issue.id,
    })
  }

  return (
    <div data-testid="issue-panel-sections">
      {artifacts.length > 0 && (
        <section className="mb-9 flex flex-col gap-2.5" data-testid="issue-artifacts">
          <SectionHeading count={String(artifacts.length)}>Artifacts</SectionHeading>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {artifacts.map((a) => {
              const kind = artifactKind(a.entry ?? a.path)
              const label = a.title ?? basename(a.path)
              const added = relativeTime(a.addedAt, Date.now())
              const src =
                kind === 'image' || kind === 'video'
                  ? artifactUrl({
                      httpOrigin,
                      issueId: issue.id,
                      artifact: a,
                      root,
                      machineId: issue.machineId,
                    })
                  : null
              if (src && (kind === 'image' || kind === 'video')) {
                return (
                  <figure key={a.path}>
                    <button
                      data-pressable
                      type="button"
                      className="group relative block w-full cursor-zoom-in"
                      title={kind === 'image' ? `View ${label} full size` : `Play ${label}`}
                      onClick={() => setLightbox({ kind, src, label })}
                    >
                      {kind === 'image' ? (
                        <img
                          src={src}
                          alt={label}
                          className="max-h-56 w-full rounded-md border border-border object-cover shadow-sm"
                        />
                      ) : (
                        <>
                          <video
                            src={src}
                            preload="metadata"
                            muted
                            className="pointer-events-none max-h-56 w-full rounded-md border border-border object-cover shadow-sm"
                          />
                          <span className="absolute inset-0 flex items-center justify-center">
                            <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover:bg-black/75">
                              <Play size={16} aria-hidden="true" className="translate-x-px" />
                            </span>
                          </span>
                        </>
                      )}
                    </button>
                    <figcaption className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="min-w-0 truncate">{label}</span>
                      {added && (
                        <span className="flex-none text-muted-foreground/60" title={a.addedAt}>
                          {added}
                        </span>
                      )}
                    </figcaption>
                  </figure>
                )
              }
              return (
                <Button
                  key={a.path}
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-left font-normal hover:bg-accent/60 sm:col-span-2"
                  disabled={!root && !a.artifactId}
                  onClick={() => openArtifactFile(a)}
                >
                  <FileText size={14} aria-hidden="true" className="flex-none text-primary/70" />
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                    {label}
                  </span>
                  <span className="flex-none font-mono text-[10px] text-muted-foreground/60">
                    {basename(a.path)}
                  </span>
                </Button>
              )
            })}
          </div>
        </section>
      )}

      {deferred.length > 0 && (
        <section className="mb-9 flex flex-col gap-1.5" data-testid="issue-deferred">
          <SectionHeading count={String(deferred.length)}>Deferred</SectionHeading>
          {deferred.map((d) => (
            <div
              key={`${d.addedAt}:${d.text}`}
              className="flex items-baseline gap-2 rounded px-1 py-0.5 text-[13px] text-foreground/80"
            >
              <span className="size-1 flex-none translate-y-[-2px] rounded-full bg-amber-400/70" />
              <span className="min-w-0 flex-1">{d.text}</span>
              <span className="flex-none font-mono text-[10px] text-muted-foreground/60">
                {new Date(d.addedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </section>
      )}

      {lightbox && <MediaLightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
