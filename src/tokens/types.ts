export interface TokenManager {
  getToken(): string
  maybeRefreshToken(): Promise<void>
}
