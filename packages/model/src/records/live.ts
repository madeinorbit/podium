/** Record-owned live parts, generated from the shared declarations (POD-7090). */
import type { z } from 'zod'
import { RECORDS } from './declarations'
import type { RecordDeclaration } from './define-record'

type PartsOf<D extends RecordDeclaration> = D extends RecordDeclaration
  ? {
      [K in Extract<keyof D['liveReadings'], string>]: {
        readonly of: D['kind']
        readonly topic: K
        readonly schema: D['liveReadings'][K]
      }
    }[Extract<keyof D['liveReadings'], string>]
  : never

export type LivePartOf<R extends readonly RecordDeclaration[]> = PartsOf<R[number]>
export type LiveTopicOf<R extends readonly RecordDeclaration[]> = LivePartOf<R>['topic']
export type LiveValueOf<R extends readonly RecordDeclaration[], K extends LiveTopicOf<R>> = z.infer<
  Extract<LivePartOf<R>, { topic: K }>['schema']
>

/** Each topic belongs to one record and has one payload schema. */
export function livePartsOf<const R extends readonly RecordDeclaration[]>(
  records: R,
): LivePartOf<R>[] {
  const parts = records.flatMap((record) =>
    Object.entries(record.liveReadings).map(([topic, schema]) => ({
      of: record.kind,
      topic,
      schema,
    })),
  )
  const topics = new Set<string>()
  for (const part of parts) {
    if (topics.has(part.topic)) throw new Error(`live topic ${part.topic} is declared twice`)
    topics.add(part.topic)
  }
  return parts as LivePartOf<R>[]
}

export const RECORD_LIVE_PARTS = livePartsOf(RECORDS)
export type RecordLiveTopicKind = LiveTopicOf<typeof RECORDS>
export type RecordLiveValue<K extends RecordLiveTopicKind> = LiveValueOf<typeof RECORDS, K>
export type RecordLiveTopicOf<K extends (typeof RECORDS)[number]['kind']> = Extract<
  LivePartOf<typeof RECORDS>,
  { of: K }
>['topic']
