export interface ManifestChunk {
  readonly file: string
  readonly imports?: readonly string[]
}

export type BuildManifest = Readonly<Record<string, ManifestChunk>>

/** Follow emitted static imports, including shared chunks that HTML does not
 * preload. Dynamic imports never belong to the startup closure. */
export function eagerJsFiles(roots: readonly string[], manifest: BuildManifest): string[] {
  const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]))
  const eager = new Set<string>()
  const pending = [...roots]
  for (const file of pending) {
    if (eager.has(file)) continue
    eager.add(file)
    for (const key of byFile.get(file)?.imports ?? []) {
      const imported = manifest[key]
      if (!imported) throw new Error(`missing static import ${key} in Vite manifest`)
      if (imported.file.endsWith('.js')) pending.push(imported.file)
    }
  }
  return [...eager]
}

/** The always-pool app needs its store, host, screen declarations and first
 * screen readers at startup. Optional screen implementations stay deferred.
 * Keep an explicit list: a new graph module needs a deliberate startup decision.
 * settings-{source,views} and preference-source are shared pool members today,
 * rather than the lazy SettingsView UI. command-launch-views also owns the
 * palette-open scalar read used by its lazy component boundary. */
const STARTUP_GRAPH_SOURCES = new Set([
  'src/loading.ts',
  'src/cached.ts', 'src/clock.ts', 'src/create.ts', 'src/debug-name.ts', 'src/enumerate.ts',
  'src/models.ts', 'src/pool.ts', 'src/query-result.ts', 'src/reader-queries.ts',
  'src/relations.ts', 'src/residency.ts', 'src/source-registry.ts', 'src/tables.ts', 'src/views.ts',
  'src/runtime-pool.ts', 'src/sidebar-perf.ts',
  'src/host/pool-host.ts', 'src/host/screens.ts',
  'src/header-entities.ts', 'src/header-schema.ts', 'src/header-session.ts', 'src/header-sessions.ts',
  'src/header-source.ts', 'src/header-views.ts',
  'src/chat-context-schema.ts', 'src/command-launch-schema.ts', 'src/issue-board-schema.ts',
  'src/issue-page-schema.ts', 'src/mission-schema.ts', 'src/mission-view-schema.ts',
  'src/navigation-schema.ts', 'src/notice-schema.ts', 'src/preference-schema.ts',
  'src/session-pane-schema.ts', 'src/settings-schema.ts', 'src/shell-schema.ts', 'src/workflow-schema.ts',
  'src/command-launch-views.ts', 'src/issue-reference.ts', 'src/mission-view.ts', 'src/mission.ts',
  'src/notice-card.ts', 'src/notice-views.ts', 'src/preference-source.ts',
  'src/session-pane.ts', 'src/session-seats.ts', 'src/settings-source.ts', 'src/settings-views.ts',
  'src/shell-views.ts', 'src/superagent.ts',
  'src/shared/cold-index.ts', 'src/shared/field-inputs.ts', 'src/shared/issue-identities.ts',
  'src/shared/issue-questions.ts', 'src/shared/links.ts', 'src/shared/overlay-row.ts',
  'src/shared/reader-questions.ts', 'src/shared/relation-index.ts', 'src/shared/repo-from-lane.ts',
  'src/shared/row-view.ts', 'src/shared/schema.ts', 'src/shared/session-questions.ts',
  'src/shared/write-contract.ts',
  'src/worklist/groups.ts', 'src/worklist/mobile-row.ts', 'src/worklist/mobile.ts',
  'src/worklist/rollup.ts', 'src/worklist/seat-verdicts.ts', 'src/worklist/sidebar-roster.ts',
  'src/worklist/sidebar-row.ts', 'src/worklist/sidebar.ts', 'src/worklist/sorted-lanes.ts',
  'src/worklist/visible.ts',
  // Startup readers own these: reader-questions builds the mention index,
  // reader-queries the addressed worktree answers, and the sidebar close
  // guard and issue menus read issuePages.closeFacts (POD-5530/5569/5570/5577).
  'src/issue-page.ts', 'src/shared/issue-mention-question.ts', 'src/shared/worktree-questions.ts',
  // The first mission view still delegates these pure value rules here.
  'diagnostics/reference/issue-views.ts',
])

export function eagerClientGraphSources(sources: readonly string[]): string[] {
  return [
    ...new Set(
      sources.filter((source) => {
        const module = source
          .replaceAll('\\', '/')
          .match(
            /(?:^|\/)(?:packages\/client-graph|node_modules\/@podium\/client-graph)\/(.*)$/,
          )?.[1]
        return module !== undefined && !STARTUP_GRAPH_SOURCES.has(module)
      }),
    ),
  ].sort()
}
