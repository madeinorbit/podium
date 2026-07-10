export function canSave(s: { editable: boolean; dirty: boolean; saving: boolean }): boolean {
  return s.editable && s.dirty && !s.saving
}
