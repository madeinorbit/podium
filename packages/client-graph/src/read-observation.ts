import { action, observable } from 'mobx'

/** Local evidence of content seen, separate from the durable user cursor.
 * Each shared issue/session model owns its own observation. */
export class ReadObservation {
  @observable accessor seenAt: string | null = null
  @observable accessor blocked = false
  @observable accessor viewing = false

  @action observe(at: string): boolean {
    this.viewing = true
    if (this.blocked) return false
    if (this.seenAt === null || at > this.seenAt) this.seenAt = at
    return true
  }

  @action intent(read: boolean): void {
    this.blocked = !read && this.viewing
    this.seenAt = null
  }

  @action leave(): void {
    this.blocked = false
    this.viewing = false
  }
}
