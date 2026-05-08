/**
 * GitHub Copilot OAuth-backed provider.
 *
 * Port of nanobot/providers/github_copilot_provider.py.
 *
 * Uses GitHub device flow OAuth to obtain a token, then exchanges it
 * for a Copilot access token on each API call.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { OpenAICompatProvider } from './openai-compat'

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const COPILOT_BASE_URL = 'https://api.githubcopilot.com'

const GITHUB_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const GITHUB_COPILOT_SCOPE = 'read:user'
const USER_AGENT = 'jarvis/0.1'
const EDITOR_VERSION = 'vscode/1.99.0'
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.0'
const EXPIRY_SKEW_MS = 60_000
const LONG_LIVED_TOKEN_MS = 315_360_000_000

interface OAuthToken {
  access: string
  refresh: string
  expires: number
  accountId?: string | null
}

function tokenFilePath(): string {
  const dir = join(homedir(), '.jarvis', 'tokens')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'github-copilot.json')
}

function loadToken(): OAuthToken | null {
  const fp = tokenFilePath()
  if (!existsSync(fp)) return null
  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8'))
    if (data?.access) return data as OAuthToken
  } catch { /* ignore */ }
  return null
}

function saveToken(token: OAuthToken): void {
  writeFileSync(tokenFilePath(), JSON.stringify(token, null, 2), 'utf-8')
}

function copilotHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    'Editor-Version': EDITOR_VERSION,
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
  }
}

/**
 * Run the GitHub device OAuth flow and persist the token.
 * Returns the token on success.
 */
export async function loginGitHubCopilot(): Promise<OAuthToken> {
  // Step 1: Request device code
  const codeResp = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({
      client_id: GITHUB_COPILOT_CLIENT_ID,
      scope: GITHUB_COPILOT_SCOPE,
    }),
  })

  if (!codeResp.ok) throw new Error(`Device code request failed: ${codeResp.status}`)
  const codePayload = (await codeResp.json()) as Record<string, unknown>

  const deviceCode = codePayload.device_code as string
  const userCode = codePayload.user_code as string
  const verifyUrl = (codePayload.verification_uri as string) ?? (codePayload.verification_uri_complete as string) ?? ''
  const interval = Math.max(1, (codePayload.interval as number) ?? 5)
  const expiresIn = (codePayload.expires_in as number) ?? 900

  console.log(`Open: ${verifyUrl}`)
  console.log(`Code: ${userCode}`)

  // Step 2: Poll for token
  const deadline = Date.now() + expiresIn * 1000
  let currentInterval = interval

  while (Date.now() < deadline) {
    await sleep(currentInterval * 1000)

    const pollResp = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    if (!pollResp.ok) throw new Error(`Token poll failed: ${pollResp.status}`)
    const pollPayload = (await pollResp.json()) as Record<string, unknown>
    const accessToken = pollPayload.access_token as string | undefined

    if (accessToken) {
      const tokenExpiresIn = (pollPayload.expires_in as number) ?? LONG_LIVED_TOKEN_MS

      // Get user info
      const userResp = await fetch(GITHUB_USER_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
      })

      let accountId: string | null = null
      if (userResp.ok) {
        const userPayload = (await userResp.json()) as Record<string, unknown>
        accountId = (userPayload.login as string) ?? null
      }

      const expiresMs = Date.now() + tokenExpiresIn * 1000
      const token: OAuthToken = {
        access: accessToken,
        refresh: '',
        expires: expiresMs,
        accountId,
      }
      saveToken(token)
      console.log('GitHub Copilot login successful')
      return token
    }

    const error = pollPayload.error as string | undefined
    if (error === 'authorization_pending') {
      continue
    }
    if (error === 'slow_down') {
      currentInterval += 5
      continue
    }
    if (error === 'expired_token') {
      throw new Error('GitHub device code expired. Please run login again.')
    }
    if (error === 'access_denied') {
      throw new Error('GitHub device flow was denied.')
    }
    if (error) {
      throw new Error((pollPayload.error_description as string) ?? error)
    }
  }

  throw new Error('GitHub device flow timed out.')
}

/**
 * GitHub Copilot provider — exchanges a stored GitHub OAuth token for Copilot access tokens.
 */
export class GitHubCopilotProvider extends OpenAICompatProvider {
  private _copilotAccessToken: string | null = null
  private _copilotExpiresAt: number = 0

  constructor(opts?: { model?: string }) {
    super({
      apiKey: 'no-key',
      baseUrl: COPILOT_BASE_URL,
      model: opts?.model ?? 'github-copilot/gpt-4.1',
      extraHeaders: {
        'Editor-Version': EDITOR_VERSION,
        'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
        'User-Agent': USER_AGENT,
      },
    })
  }

  private async _getCopilotAccessToken(): Promise<string> {
    const now = Date.now()
    if (this._copilotAccessToken && now < this._copilotExpiresAt - EXPIRY_SKEW_MS) {
      return this._copilotAccessToken
    }

    const githubToken = loadToken()
    if (!githubToken || !githubToken.access) {
      throw new Error(
        'GitHub Copilot is not logged in. Run: jarvis provider login github-copilot',
      )
    }

    const resp = await fetch(COPILOT_TOKEN_URL, {
      headers: copilotHeaders(githubToken.access),
    })

    if (!resp.ok) throw new Error(`Copilot token exchange failed: ${resp.status}`)
    const payload = (await resp.json()) as Record<string, unknown>

    const token = payload.token as string | undefined
    if (!token) throw new Error('Copilot token exchange returned no token.')

    const expiresAt = payload.expires_at
    if (typeof expiresAt === 'number') {
      this._copilotExpiresAt = expiresAt * 1000
    } else {
      const refreshIn = (payload.refresh_in as number) ?? 1500
      this._copilotExpiresAt = Date.now() + refreshIn * 1000
    }
    this._copilotAccessToken = token
    return token
  }

  private async _refreshApiKey(): Promise<void> {
    const token = await this._getCopilotAccessToken()
    ;(this as any).apiKey = token
    ;(this as any)._client.apiKey = token
  }

  override async generate(
    messages: any[],
    options?: any,
  ): Promise<any> {
    await this._refreshApiKey()
    return super.generate(messages, options)
  }

  override async *generateStream(
    messages: any[],
    options?: any,
  ): AsyncIterable<any> {
    await this._refreshApiKey()
    yield* super.generateStream(messages, options)
  }
}

// ---- Helper ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
