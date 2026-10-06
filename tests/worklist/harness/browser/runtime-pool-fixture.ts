/** The browser driver shares only this contract, never the app's type program. */
export interface RuntimePoolFixture {
  show(name: string | null, rebuild?: boolean): void
  ready(): boolean
  state(): { replicas: number; attachments: number; pool: boolean; failures: string[] }
  survivors(): string[]
  mountReference(): void
  referenceState(): { online: boolean; cold: boolean; resident: boolean; issueId: string | undefined; serverCalls: number }
}

declare global {
  interface Window { __poolFixture: RuntimePoolFixture }
}
