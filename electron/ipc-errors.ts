/** Only an error tied to the still-active GitHub session may invalidate it. */
export function shouldExpireGitHubSession(channel: string, error: unknown, requestToken?: string, currentToken?: string): boolean {
  if (channel === 'token' || channel === 'login') return false;
  return (error as { status?: unknown } | null)?.status === 401 && !!requestToken && requestToken === currentToken;
}
