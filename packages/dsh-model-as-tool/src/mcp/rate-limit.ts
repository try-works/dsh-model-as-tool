/**
 * Per-client request rate limiting for the MCP HTTP transport (AT-12).
 *
 * AT-12's named gap was that the host had ZERO rate limiting: an authenticated client could
 * drive unbounded inference traffic, and nothing anywhere counted it. This module is the
 * counter. Its discipline is deliberate:
 *
 * - **Keyed on the AUTHENTICATED client identity, never the socket.** The remote address is
 *   caller-forgeable (proxies, NAT, header tricks) and the endpoint is loopback-only anyway,
 *   so every client would share one address and one bucket. The identity comes from the
 *   transport's resolved authentication — the static-token `clientId` or the OAuth subject —
 *   which is the one thing the transport already proved.
 * - **Fixed-window buckets.** One counter per client per window. Simpler to reason about than
 *   a token bucket, and its boundary semantics are exactly testable: a client that exhausted
 *   a window is admitted again when the next window opens, with `retryAfterMs` naming when.
 * - **Bounded in-memory state, never persisted.** Entries carry only a window, a count and a
 *   last-seen timestamp; when the map is at capacity a NEW client evicts the longest-idle
 *   entry, so a deployment cannot be grown without limit by many short-lived clients. A
 *   restart forgets everything, which is correct for a burst guard: persistence would turn
 *   a request limiter into an availability policy.
 * - **Counting is not an auth oracle.** The HTTP layer admits a client only AFTER the
 *   credential was accepted; an unauthenticated or malformed-credential request is refused
 *   before any counter moves. Counting authentication failures would let a caller learn
 *   whether a credential exists from the timing of a 429, which is the leak this refuses.
 *
 * @module @try-works/dsh-model-as-tool/mcp/rate-limit
 */

/** The policy one deployment enforces. */
export interface RateLimitPolicy {
  /** Requests admitted per window for ONE client. */
  readonly maxRequests: number
  /** Window length in milliseconds. */
  readonly windowMs: number
  /** Most clients tracked; a new client at capacity evicts the longest-idle entry. */
  readonly maxClients: number
}

/**
 * The default policy: 60 requests per client per minute, 10 000 tracked clients.
 *
 * Sensible for a loopback single-user endpoint while still bounding a runaway client; an
 * operator overrides it through the transport configuration.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  maxRequests: 60,
  windowMs: 60_000,
  maxClients: 10_000,
}

/** The verdict of one admission. */
export type RateLimitDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly retryAfterMs: number }

/** A per-client limiter. */
export interface RateLimiter {
  /** Consume one request for a client, refusing it when the window is exhausted. */
  admit(clientId: string): RateLimitDecision
  /** Requests still available to this client in the current window. */
  remaining(clientId: string): number
  /** How many clients are currently tracked. */
  trackedClients(): number
}

interface ClientBucket {
  /** The window this bucket counts. */
  window: number
  /** Requests consumed in this window. */
  count: number
  /** Last admission timestamp, for idle eviction. */
  lastSeen: number
}

/** Read a positive integer policy field, refusing a value that would mis-count. */
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`rate limit ${name} must be a positive integer, not ${String(value)}`)
  }
  return value
}

/**
 * Create a per-client fixed-window rate limiter.
 * @param policy - the enforced policy; fields are validated at construction so a broken
 *   configuration fails when the transport starts, not on the first request.
 * @param now - a clock, injectable so window boundaries are testable.
 * @returns the limiter.
 */
export function createRateLimiter(
  policy: RateLimitPolicy,
  now: () => number = Date.now,
): RateLimiter {
  const maxRequests = positiveInteger(policy.maxRequests, 'maxRequests')
  const windowMs = positiveInteger(policy.windowMs, 'windowMs')
  const maxClients = positiveInteger(policy.maxClients, 'maxClients')

  const buckets = new Map<string, ClientBucket>()

  /** Evict the longest-idle client, so the map stays bounded while new clients arrive. */
  const evictIdle = (): void => {
    let oldest: { id: string; lastSeen: number } | undefined
    for (const [id, bucket] of buckets) {
      if (oldest === undefined || bucket.lastSeen < oldest.lastSeen) {
        oldest = { id, lastSeen: bucket.lastSeen }
      }
    }
    if (oldest !== undefined) buckets.delete(oldest.id)
  }

  const bucketFor = (clientId: string, at: number): ClientBucket => {
    const existing = buckets.get(clientId)
    if (existing !== undefined) return existing
    if (buckets.size >= maxClients) evictIdle()
    const created: ClientBucket = { window: 0, count: 0, lastSeen: at }
    buckets.set(clientId, created)
    return created
  }

  const currentWindow = (at: number): number => Math.floor(at / windowMs)

  return {
    admit(clientId: string): RateLimitDecision {
      const at = now()
      const bucket = bucketFor(clientId, at)
      bucket.lastSeen = at
      const window = currentWindow(at)
      // A NEW WINDOW RESETS the count: the client exhausted the PREVIOUS window, not all time.
      if (bucket.window !== window) {
        bucket.window = window
        bucket.count = 0
      }
      if (bucket.count >= maxRequests) {
        return {
          admitted: false,
          // The client is admitted again at the next window boundary.
          retryAfterMs: windowMs - (at % windowMs),
        }
      }
      bucket.count += 1
      return { admitted: true }
    },

    remaining(clientId: string): number {
      const bucket = buckets.get(clientId)
      if (bucket === undefined) return maxRequests
      if (bucket.window !== currentWindow(now())) return maxRequests
      return Math.max(0, maxRequests - bucket.count)
    },

    trackedClients(): number {
      return buckets.size
    },
  }
}
