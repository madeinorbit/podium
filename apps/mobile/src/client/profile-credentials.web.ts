/** Web-mobile authenticates with the server's HttpOnly cookie and persists no bearer. */
export async function getProfileCredential(_profileId: string): Promise<string | null> {
  return null
}

export async function setProfileCredential(_profileId: string, _bearer: string): Promise<void> {}

export async function deleteProfileCredential(_profileId: string): Promise<void> {}

export async function purgeOrphanedProfileCredentials(_validProfileIds: string[]): Promise<void> {}
