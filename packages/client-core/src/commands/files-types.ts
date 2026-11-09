import type { MachineId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { FileScope } from '../values'

export interface FilesCommands<TApi extends PodiumClientApi = PodiumClientApi> {
  read: (
    scope: FileScope,
    path: string,
  ) => Promise<Awaited<ReturnType<TApi['files']['read']['query']>>>
  list: (args: {
    machineId?: MachineId
    root: string
    path?: string
  }) => Promise<Awaited<ReturnType<TApi['files']['list']['query']>>>
  /** Git dock panel [POD-114] — read-only checkout inspection (raw git output;
   *  parsing lives in the web viewmodels). */
  status: (args: {
    machineId?: MachineId
    root: string
  }) => Promise<Awaited<ReturnType<TApi['git']['status']['query']>>>
  log: (args: {
    machineId?: MachineId
    root: string
  }) => Promise<Awaited<ReturnType<TApi['git']['log']['query']>>>
  diff: (args: {
    machineId?: MachineId
    root: string
    path: string
  }) => Promise<Awaited<ReturnType<TApi['git']['diffFile']['query']>>>
  write: (args: {
    scope: FileScope
    path: string
    content: string
    baseHash?: string
  }) => Promise<Awaited<ReturnType<TApi['files']['write']['mutate']>>>
  /** Unfolding a commit [POD-1289] — the files it touched, and one file's diff
   *  INSIDE it. Not `gitDiffFile`: that asks about the working tree, which
   *  answers "nothing" for anything already committed. */
  commitFiles: (args: {
    machineId?: MachineId
    root: string
    sha: string
  }) => Promise<Awaited<ReturnType<TApi['git']['commitFiles']['query']>>>
  commitDiffFile: (args: {
    machineId?: MachineId
    root: string
    sha: string
    path: string
  }) => Promise<Awaited<ReturnType<TApi['git']['commitDiffFile']['query']>>>
}
