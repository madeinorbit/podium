import { Button } from '@/components/ui/button'
import { MEMBER_ROLE_OPTIONS } from './members-data'

/** Selecting a role opens confirmation; it must not announce a save yet. */
export function MemberRoleControl({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (role: 'member' | 'admin') => void
  disabled?: boolean
}) {
  return (
    <fieldset aria-label="Role" className="settings-segmented" disabled={disabled}>
      {MEMBER_ROLE_OPTIONS.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  )
}
