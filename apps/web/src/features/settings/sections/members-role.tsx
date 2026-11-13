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
    <fieldset
      aria-label="Role"
      className="m-0 flex min-w-0 rounded-lg border border-hairline-soft bg-muted/40 p-0.5"
      disabled={disabled}
    >
      {MEMBER_ROLE_OPTIONS.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={value === option.value}
          className={
            value === option.value ? 'bg-secondary text-foreground' : 'text-muted-foreground'
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  )
}
