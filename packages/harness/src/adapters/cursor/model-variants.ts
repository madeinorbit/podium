/** Cursor exposes reasoning settings as native model ids, rather than a
 * separate CLI flag. Only siblings actually returned by `models` are offered. */
const VARIANT = /^(.*)-(minimal|low|medium|high|xhigh|max|ultra|none)(-fast)?$/

export function cursorModelEffort(model: string): string | undefined {
  return model.match(VARIANT)?.[2]
}

function family(model: string): string | undefined {
  const match = model.match(VARIANT)
  return match ? `${match[1]}${match[3] ?? ''}` : undefined
}

export function cursorVariantEfforts(
  models: readonly { value: string }[],
  model: string,
): string[] {
  const key = family(model)
  if (!key) return []
  const levels = [
    ...new Set(
      models
        .filter((entry) => family(entry.value) === key)
        .map((entry) => cursorModelEffort(entry.value)!),
    ),
  ]
  // A model named "Max" alone is not evidence of an effort control.
  return levels.length > 1 ? levels : []
}

export function cursorEffortVariant(
  models: readonly { value: string }[],
  model: string,
  effort: string,
): string | undefined {
  if (effort === 'auto') return model
  if (!cursorVariantEfforts(models, model).includes(effort)) return undefined
  return models.find(
    (entry) => family(entry.value) === family(model) && cursorModelEffort(entry.value) === effort,
  )?.value
}

/** Encode an explicit effort in the native model id. Headless selections are
 * first validated against the account catalog; launch/exec pickers can also
 * supply their model and effort as separate fields. */
export function cursorSelectedModel(model?: string, effort?: string): string {
  const selected = model || 'auto'
  if (effort && effort !== 'auto' && cursorModelEffort(selected) !== effort) {
    const match = selected.match(VARIANT)
    if (!match) throw new Error('Cursor effort requires a native model variant')
    return `${match[1]}-${effort}${match[3] ?? ''}`
  }
  return selected
}
