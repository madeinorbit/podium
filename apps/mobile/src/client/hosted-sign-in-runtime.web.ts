/** Browser-mobile uses the account cookie, never a native bearer or keychain. */
export const hostedSignIn = {
  async begin(_server?: string, _page?: string): Promise<void> {
    throw new Error('Native sign-in only.')
  },
  async cancel(): Promise<void> {},
  async redeem(_link: {
    code: string
    challenge: string
  }): Promise<{ server: string; token: string }> {
    throw new Error('Native sign-in only.')
  },
}
