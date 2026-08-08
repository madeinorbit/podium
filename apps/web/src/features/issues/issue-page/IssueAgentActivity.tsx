/**
 * THE AGENT-ACTIVITY PANEL (issues.panel) — what an agent published for the
 * human: todos with a progress bar (checkable from here — the same 1-based index
 * API the dock uses), artifacts with inline image/video previews plus a
 * lightbox, and deferred items. Split out of IssuePage.tsx (POD-646); sections
 * render only when non-empty, so an issue with no panel adds no chrome.
 *
 * -------------------------------------------------------------------------
 * ATTRIBUTION: THE PAIR IS READ, NEVER INFERRED — AND WHAT IS ACTUALLY THERE.
 * -------------------------------------------------------------------------
 *
 * docs/multi-user-readiness.md §3.1.3 A3 requires this panel to show ACTOR
 * (which agent) and ON-BEHALF-OF (which human), both server-stamped from the
 * authenticated transport, and never to infer or synthesise either. A4 adds that
 * work an agent did is OWNED by its delegating human, which is why the pair is
 * the panel's header rather than a hover.
 *
 * What is stamped, measured rather than assumed: `IssueAggregate` carries
 * `createdBy: Attribution` and `Ownership` (`owner`, `visibility`), and
 * `IssueProjection` derives its wire shape from that aggregate, so all three
 * reach `IssueViewModel`. The panel ITEMS do not: `IssuePanelTodo`,
 * `IssuePanelArtifact` and `IssuePanelDeferred` carry text/path/addedAt and no
 * `Attribution` at all. So the pair is rendered ONCE, for the issue whose panel
 * this is, and NOT per item — a per-item pair would have to be invented, which
 * is the one thing A3 forbids. The upstream that would supply it is recorded in
 * the ledger; it is a model + wire change, not this surface's.
 *
 * NO PAYLOAD ISSUED FROM HERE CARRIES IDENTITY. `commands.toggleTodo` sends the
 * issue id and a 1-based index; `openArtifact`/`openFileInWorktree` send paths.
 * `issue-page-commands.ts` mentions no actor, owner or origin anywhere, and
 * `issue-page.payload-identity.test.ts` is the check that keeps it that way.
 */

import { shallowEqual } from '@podium/client-core'
import { relativeTime } from '@podium/client-core/focus'
import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact } from '@podium/model'
import { ChevronRight, FileText, Play } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { type IssueViewModel, useStoreSelector } from '@/app/store'
import { MediaLightbox } from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { IssuePageCommands } from '../issue-page-commands'
import { AttributionPair } from './AttributionPair'
import { SectionHeading } from './chrome'

export function IssueAgentActivity({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element | null {
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

  const todos = issue.panel?.todos ?? []
  const artifacts = issue.panel?.artifacts ?? []
  const deferred = issue.panel?.deferred ?? []
  if (todos.length === 0 && artifacts.length === 0 && deferred.length === 0) return null

  const doneCount = todos.filter((t) => t.done).length
  // The 1-based index IS the API `toggleTodo` takes, so it is carried alongside
  // each todo rather than recovered from a filtered array's position — a
  // partitioned list whose keys are its own indices toggles the wrong row.
  const indexed = todos.map((todo, index) => ({ todo, index }))
  const openTodos = indexed.filter((t) => !t.todo.done)
  const doneTodos = indexed.filter((t) => t.todo.done)
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
      <AgentActivityAttribution issue={issue} />

      {todos.length > 0 && (
        <section className="mb-7 flex flex-col gap-2">
          <SectionHeading count={`${doneCount}/${todos.length}`}>Todo</SectionHeading>
          <div className="flex items-center gap-2.5">
            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-[var(--issue)] transition-[width] duration-300"
                style={{ width: `${(doneCount / todos.length) * 100}%` }}
              />
            </div>
            <span className="font-mono text-[9px] text-text-faint tabular-nums">
              {Math.round((doneCount / todos.length) * 100)}%
            </span>
          </div>
          {/* OPEN WORK FIRST, DONE WORK FOLDED (POD-591). A live task carries
              twenty todos and two thirds of them are struck through — a wall of
              crossed-out text between the description and everything below it.
              What is left to do is the question this section answers; what was
              already done is an audit trail, one click away. */}
          <div className="flex flex-col gap-0.5">
            {openTodos.map(({ todo, index }) => (
              <TodoRow
                key={`open-${index}`}
                todo={todo}
                index={index}
                busy={busy}
                commands={commands}
              />
            ))}
          </div>
          {doneTodos.length > 0 && (
            <details className="group/done">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-[11px] text-text-dim hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  size={11}
                  aria-hidden="true"
                  className="transition-transform group-open/done:rotate-90"
                />
                {doneTodos.length} done
              </summary>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {doneTodos.map(({ todo, index }) => (
                  <TodoRow
                    key={`done-${index}`}
                    todo={todo}
                    index={index}
                    busy={busy}
                    commands={commands}
                  />
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {artifacts.length > 0 && (
        <section className="mb-7 flex flex-col gap-2" data-testid="issue-artifacts">
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
        <section className="mb-7 flex flex-col gap-1" data-testid="issue-deferred">
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

/** One todo. The 1-based `index` is the toggle API's argument, threaded from the
 *  unpartitioned list so an open/done split cannot toggle the wrong row. */
function TodoRow({
  todo,
  index,
  busy,
  commands,
}: {
  todo: { text: string; done: boolean }
  index: number
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside renders a Base UI role=checkbox button, which biome can't see as a control
    <label className="-mx-1.5 flex cursor-pointer items-start gap-2 rounded-[4.8px] px-1.5 py-1 text-[12.5px] transition-colors hover:bg-accent">
      <Checkbox
        checked={todo.done}
        disabled={busy}
        onCheckedChange={(checked) => commands.toggleTodo(index + 1, checked === true)}
        className="mt-[3px]"
      />
      <span className={cn('leading-[1.45]', todo.done ? 'text-text-faint' : 'text-foreground')}>
        {todo.text}
      </span>
    </label>
  )
}

/** Who produced this work, from the issue's own server-stamped `createdBy`
 *  pair. Renders nothing when the projection carries no pair — an older row
 *  genuinely does not know, and "unknown · for you" would be a fabrication. */
function AgentActivityAttribution({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  if (!issue.createdBy) return null
  return (
    <p
      className="mb-2 flex flex-wrap items-baseline gap-1 text-[11px] text-muted-foreground"
      data-testid="agent-activity-attribution"
    >
      <span>Published by</span>
      {/* `compact` (POD-591): this is a one-line dense row, which is the case
          the flag was built for. Without it an agent actor's full uuid ran the
          width of the column — the page's only visible uuid, and the reason the
          human half beside it was the part that got clipped. */}
      <AttributionPair compact attribution={issue.createdBy} />
    </p>
  )
}
