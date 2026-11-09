import type { PodiumClientApi } from '../api'
import type { FileScope } from '../values'
import type { CommandDeps } from './context'
import type { FilesCommands } from './files-types'

export function createFilesCommands<TApi extends PodiumClientApi>(
  rt: CommandDeps<TApi>,
): FilesCommands<TApi> {
  const api = rt.api

  return {
    read: ((scope: FileScope, path: string) =>
      scope.kind === 'session'
        ? api.files.read.query({ sessionId: scope.sessionId, path })
        : scope.kind === 'artifact'
          ? api.files.read.query({ issueId: scope.issueId, artifactId: scope.artifactId, path })
          : api.files.read.query({
              machineId: scope.machineId,
              root: scope.root,
              path,
            })) as FilesCommands<TApi>['read'],
    list: ((args) => api.files.list.query(args)) as FilesCommands<TApi>['list'],
    status: ((args) => api.git.status.query(args)) as FilesCommands<TApi>['status'],
    log: ((args) => api.git.log.query(args)) as FilesCommands<TApi>['log'],
    diff: ((args) => api.git.diffFile.query(args)) as FilesCommands<TApi>['diff'],
    write: ((args: { scope: FileScope; path: string; content: string; baseHash?: string }) => {
      if (args.scope.kind === 'artifact')
        return Promise.reject(new Error('artifact snapshots are read-only'))
      return args.scope.kind === 'session'
        ? api.files.write.mutate({
            sessionId: args.scope.sessionId,
            path: args.path,
            content: args.content,
            baseHash: args.baseHash,
          })
        : api.files.write.mutate({
            machineId: args.scope.machineId,
            root: args.scope.root,
            path: args.path,
            content: args.content,
            baseHash: args.baseHash,
          })
    }) as FilesCommands<TApi>['write'],
    commitFiles: ((args) => api.git.commitFiles.query(args)) as FilesCommands<TApi>['commitFiles'],
    commitDiffFile: ((args) =>
      api.git.commitDiffFile.query(args)) as FilesCommands<TApi>['commitDiffFile'],
  }
}
