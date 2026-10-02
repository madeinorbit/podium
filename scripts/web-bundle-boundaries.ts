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

/** The pool must stay behind a startup switch. Only its dependency-free
 * pending marker may be shared with the eager shell. */
export function eagerClientGraphSources(sources: readonly string[]): string[] {
  return [
    ...new Set(
      sources.filter((source) => {
        const module = source
          .replaceAll('\\', '/')
          .match(
            /(?:^|\/)(?:packages\/client-graph|node_modules\/@podium\/client-graph)\/(.*)$/,
          )?.[1]
        return module !== undefined && module !== 'src/loading.ts'
      }),
    ),
  ].sort()
}
