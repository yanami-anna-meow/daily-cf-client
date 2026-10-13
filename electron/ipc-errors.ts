/** Only an error tied to the still-active GitHub session may invalidate it. */
export function shouldExpireGitHubSession(channel: string, error: unknown, requestToken?: string, currentToken?: string): boolean {
  // Update requests are public and never use the contribution account's token.
  if (channel === 'token' || channel === 'login' || channel.startsWith('app-update-')) return false;
  return (error as { status?: unknown } | null)?.status === 401 && !!requestToken && requestToken === currentToken;
}
