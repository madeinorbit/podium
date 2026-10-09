import { SCHEMA, type EntityName } from '@podium/client-graph/shared/schema'

/** Differential tests compare declared answers, not a model's pool machinery.
 * Read the actual getters so a wrong model field still fails wire parity. */
export function modelFields(entity: EntityName, model: object, fields = Object.keys(SCHEMA[entity].fields)) {
  return Object.fromEntries(fields.flatMap(field => {
    const value = Reflect.get(model, field)
    return value === undefined ? [] : [[field, value]]
  }))
}
