// Structured answers from Podium's own model calls. The calls themselves run
// through `modules/inference/complete.ts`, which chooses the credential.
import type { z } from 'zod'

/**
 * Adapt a zod schema into a lenient `parse` function: pull the first fenced or
 * braced JSON object out of the model's text and validate it. New structured
 * features (the issue assistant, shipwright) pass `jsonSchema(MySchema)` as `parse`.
 */
export function jsonSchema<T>(schema: z.ZodType<T>): (text: string) => T | null {
  return (text: string) => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const raw = (fenced?.[1] ?? text).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end < start) return null
    try {
      const result = schema.safeParse(JSON.parse(raw.slice(start, end + 1)))
      return result.success ? result.data : null
    } catch {
      return null
    }
  }
}
