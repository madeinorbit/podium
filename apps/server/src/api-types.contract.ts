import type { AppRouter as ClientRouter } from '@podium/api-types'
import type {
  AnyTRPCProcedure,
  AnyTRPCRouter,
  inferProcedureInput,
  inferTRPCClientTypes,
  inferTransformedProcedureOutput,
} from '@trpc/server'
import type { AppRouter } from './router'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Data<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends object ? { [K in keyof T]: Data<T[K]> } : T
type SameData<A, B> = Equal<Data<A>, Data<B>>
type RecordOf<T> = T extends AnyTRPCRouter ? T['_def']['record'] : T
type Configuration<T extends AnyTRPCRouter> = {
  errorShape: inferTRPCClientTypes<T>['errorShape']
  transformer: inferTRPCClientTypes<T>['transformer']
}

// Compare instantiated procedure data. Comparing the routers themselves also
// compares their private request Context, which clients deliberately omit.
type Differences<A, B, Path extends string = ''> =
  Exclude<keyof RecordOf<A>, keyof RecordOf<B>> |
  Exclude<keyof RecordOf<B>, keyof RecordOf<A>> |
  { [K in Extract<keyof RecordOf<A>, string>]: K extends keyof RecordOf<B>
    ? RecordOf<A>[K] extends AnyTRPCProcedure
      ? RecordOf<B>[K] extends AnyTRPCProcedure
        ? Equal<RecordOf<A>[K]['_def']['type'], RecordOf<B>[K]['_def']['type']> extends true
          ? SameData<inferProcedureInput<RecordOf<A>[K]>, inferProcedureInput<RecordOf<B>[K]>> extends true
            ? SameData<
                inferTransformedProcedureOutput<Configuration<AppRouter>, RecordOf<A>[K]>,
                inferTransformedProcedureOutput<Configuration<ClientRouter>, RecordOf<B>[K]>
              > extends true ? never : `${Path}${K}.output`
            : `${Path}${K}.input`
          : `${Path}${K}.kind`
        : `${Path}${K}.kind`
      : Differences<RecordOf<A>[K], RecordOf<B>[K], `${Path}${K}.`>
    : `${Path}${K}.missing`
  }[Extract<keyof RecordOf<A>, string>]

type Expect<T extends true> = T
type ClientConfigurationMatches = Expect<Equal<Configuration<ClientRouter>, Configuration<AppRouter>>>
type ExpectNoDifferences<T extends never> = T
type ProceduresMatch = ExpectNoDifferences<Differences<AppRouter, ClientRouter>>
