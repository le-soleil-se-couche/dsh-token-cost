/**
 * Browser-side API client for the /api/dsh-token-cost route family — the only
 * data access path the surfaces use. Plain fetch, same origin, loopback fence
 * enforced by the host.
 */

import { TOKEN_COST_API } from '../protocol.ts'
import type {
  ModelsResponse,
  SavePricesResponse,
  ResyncResponse,
  SessionDetailResponse,
  SessionsResponse,
  StatusResponse,
  SummaryResponse,
} from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class TokenCostApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenCostApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new TokenCostApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new TokenCostApiError(message)
  }
  return body as T
}

/** One client instance per surface (stateless; cheap to construct). */
export class TokenCostApi {
  async status(): Promise<StatusResponse> {
    const response = await fetch(`${TOKEN_COST_API}/status`, { headers: { accept: 'application/json' } })
    return readJson<StatusResponse>(response)
  }

  async summary(from: number, to: number, tzOffsetMinutes?: number): Promise<SummaryResponse> {
    const query = new URLSearchParams({ from: String(from), to: String(to) })
    if (tzOffsetMinutes !== undefined) query.set('tz', String(tzOffsetMinutes))
    const response = await fetch(`${TOKEN_COST_API}/summary?${query}`, { headers: { accept: 'application/json' } })
    return readJson<SummaryResponse>(response)
  }

  async sessions(): Promise<SessionsResponse> {
    const response = await fetch(`${TOKEN_COST_API}/sessions`, { headers: { accept: 'application/json' } })
    return readJson<SessionsResponse>(response)
  }

  async session(id: string): Promise<SessionDetailResponse> {
    const response = await fetch(`${TOKEN_COST_API}/session/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
    return readJson<SessionDetailResponse>(response)
  }

  async resync(): Promise<ResyncResponse> {
    const response = await fetch(`${TOKEN_COST_API}/resync`, { method: 'POST' })
    return readJson<ResyncResponse>(response)
  }

  async models(): Promise<ModelsResponse> {
    const response = await fetch(`${TOKEN_COST_API}/models`, { headers: { accept: 'application/json' } })
    return readJson<ModelsResponse>(response)
  }

  async savePrices(customPrices: string): Promise<SavePricesResponse> {
    const response = await fetch(`${TOKEN_COST_API}/prices`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ customPrices }),
    })
    return readJson<SavePricesResponse>(response)
  }
}