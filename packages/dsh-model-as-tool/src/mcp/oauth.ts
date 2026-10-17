/**
 * The embedded LOCAL OAuth 2.1 authorization server + resource-server verifier
 * (P26-15).
 *
 * P26-15 permits exactly two implementations: a tested authorization-server
 * integration, or a properly implemented embedded/local server — and forbids
 * inventing token cryptography. This module is the second: the signing and
 * verification primitives are Node's OWN WebCrypto (`crypto.subtle` HMAC-SHA256),
 * and only the JWT envelope around them is assembled here. No cipher, mode or
 * hash is hand-rolled.
 *
 * The shape follows the parts of RFC 6749/6750/8414/9728 a resource server and a
 * local issuer need:
 *
 * - HS256-signed JWTs with `iss`, `sub` (client id), `aud`, `scope`, `iat`, `exp`
 *   and a unique `jti`;
 * - RFC 6750 challenges: `WWW-Authenticate: Bearer error="invalid_token"|...`
 *   with `scope="..."` on insufficient_scope;
 * - per-client credentials with INDEPENDENT revocation (a revoked client's tokens
 *   fail while every other client keeps working);
 * - RFC 8414 authorization-server metadata and RFC 9728 protected-resource
 *   metadata, so a client can discover issuer/audience/token endpoint.
 *
 * The static-token mode remains available as CUSTOM authentication and still
 * claims nothing; this module is what a deployment turns on when it wants the
 * OAuth profile, and `authProfile()` reports which mode is live.
 *
 * @module @try-works/dsh-model-as-tool/mcp/oauth
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ClientCredentialStore } from './credential-store.ts'

/** One registered client of the local authorization server. */
export interface OAuthClient {
  /** The client's identity, recorded in the token's `sub` and in receipts. */
  readonly clientId: string
  /** The client's secret, the shared symmetric key for HS256. */
  readonly secret: string
  /** The scope this client may be granted. */
  readonly scope: readonly string[]
}

/** Configuration for the embedded authorization server. */
export interface LocalOAuthServerConfig {
  /** The issuer URI, stamped into every token's `iss`. */
  readonly issuer: string
  /** The resource the tokens target, stamped into `aud`. */
  readonly audience: string
  /** Token lifetime in seconds. */
  readonly tokenLifetimeSeconds?: number
  /** Clock skew tolerated on verification, in seconds. */
  readonly leewaySeconds?: number
  /**
   * The durable credential store (SEC-01).
   *
   * When present, generated and operator-provisioned clients are PERSISTED
   * owner-only, revocation survives restarts, and the server hydrates its
   * registry from the store at construction. A generation that cannot be
   * persisted registers nothing (fail-closed). Absent keeps the earlier
   * in-memory behavior.
   */
  readonly store?: ClientCredentialStore
}

/** A generated credential, with the secret returned exactly once. */
export interface GeneratedClientCredential {
  readonly clientId: string
  /** Crypto-random, shown once here and never re-echoed (SEC-01). */
  readonly secret: string
}

/** Why verification failed, in RFC 6750 error-code vocabulary. */
export type OAuthTokenError =
  | { readonly code: 'invalid_request'; readonly description: string }
  | { readonly code: 'invalid_token'; readonly description: string }
  | { readonly code: 'insufficient_scope'; readonly description: string; readonly scope: string }

/** A verified token's claims. */
export interface VerifiedToken {
  readonly clientId: string
  readonly scope: readonly string[]
  readonly audience: string
  readonly jti: string
}

/** The embedded local authorization server. */
export interface LocalOAuthServer {
  /** Register or replace a client credential. */
  upsertClient(client: OAuthClient): void
  /**
   * GENERATE a fresh client credential with a crypto-random secret (SEC-01).
   *
   * The secret is returned EXACTLY ONCE, in the returned object; every later surface
   * names only the clientId. The generation is fail-closed: when the durable store is
   * present and the credential cannot be persisted, nothing is registered and the
   * call throws — a credential that a restart would forget must never appear usable.
   */
  generateClient(options: { readonly clientId: string; readonly scope?: readonly string[] }): GeneratedClientCredential
  /** Revoke ONE client; its tokens fail, every other client is untouched. */
  revokeClient(clientId: string): void
  /** Issue an access token for a client, or undefined for an unknown/revoked client. */
  issueAccessToken(clientId: string, scope?: readonly string[]): Promise<string>
  /**
   * Verify a presented bearer token: signature, issuer, audience, expiry and
   * scope, against the live client registry and revocation set.
   */
  verify(token: string, requiredScope?: readonly string[]): Promise<
    | { readonly ok: true; readonly token: VerifiedToken }
    | { readonly ok: false; readonly error: OAuthTokenError }
  >
  /** RFC 8414 authorization-server metadata. */
  authorizationServerMetadata(): Record<string, unknown>
  /** RFC 9728 protected-resource metadata. */
  protectedResourceMetadata(): Record<string, unknown>
}

const ENCODER = new TextEncoder()

/** Base64url without padding, the JWT alphabet. */
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Decode one base64url JWT part to its JSON value. */
function decodePart(part: string | undefined): Record<string, unknown> | undefined {
  if (part === undefined || part.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Create the embedded local authorization server.
 *
 * The signing key is DERIVED per client from its secret (SHA-256), so each
 * client's tokens are signed with a key only that client's secret can produce —
 * and revoking a client is removing its secret from the registry, which is the
 * one-sided operation a resource server can perform without consulting the
 * authorization server.
 * @param config - issuer, audience and lifetimes.
 * @returns the server.
 */
export function createLocalOAuthServer(config: LocalOAuthServerConfig): LocalOAuthServer {
  const lifetime = config.tokenLifetimeSeconds ?? 900
  const leeway = config.leewaySeconds ?? 30
  const clients = new Map<string, OAuthClient>()
  const revoked = new Map<string, string>() // clientId -> secret hash, so a re-registration restores access

  // SEC-01: hydrate the registry from the durable store, so generated credentials
  // survive a restart. Revoked clients are ABSENT from the store (revocation deletes),
  // so everything listed is live.
  for (const stored of config.store?.list() ?? []) {
    if (stored.scheme !== 'oauth-resource-server') continue
    clients.set(stored.clientId, { clientId: stored.clientId, secret: stored.secret, scope: stored.scope })
  }

  // The key type is inferred: naming `CryptoKey` here collides with the DOM value
  // of the same name in the Node type surface.
  const keyFor = (secret: string) => {
    const digest = createHash('sha256').update(secret).digest()
    return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  }

  /**
   * The LIVE registry entry for one client id.
   *
   * When the durable store exists it is the SOLE authority: the store row is
   * read fresh on every issue and verify, and there is NO fallback to the
   * construction-time hydration —
   *
   * - a row ABSENT from the store is an unknown/revoked client, even if this
   *   process hydrated the id earlier (delete-then-recreate invalidates old
   *   tokens; deletion through any surface takes effect on the next call);
   * - a row with the WRONG SCHEME (static-token where an OAuth row was
   *   hydrated) is REJECTED as an OAuth client — scheme confusion must not
   *   resurrect a hydrated entry;
   * - a credential generated after this server was constructed ISSUES
   *   immediately (the earlier design answered "unknown client" until
   *   restart).
   *
   * The in-memory map serves ONLY the store-less mode.
   */
  const liveClient = (clientId: string): OAuthClient | undefined => {
    if (config.store !== undefined) {
      const stored = config.store.get(clientId)
      if (stored === undefined) return undefined
      if (stored.scheme !== 'oauth-resource-server') return undefined
      return { clientId: stored.clientId, secret: stored.secret, scope: stored.scope }
    }
    return clients.get(clientId)
  }

  /** Validate scope names once, so a bad name is refused at registration. */
  const assertScopeNames = (scope: readonly string[]): void => {
    // Scope names are RFC 6749 scope-tokens: no whitespace. A name containing a
    // space can never be satisfied (issue joins with ' ', verify splits), so
    // registering one is a configuration error and is refused here rather than
    // silently issuing credentials that can never authorize (review F-g).
    for (const name of scope) {
      if (!/^[A-Za-z0-9._:\/-]+$/.test(name)) {
        throw new Error(`scope name ${JSON.stringify(name)} is not an RFC 6749 scope-token`)
      }
    }
  }

  const register = (client: OAuthClient): void => {
    assertScopeNames(client.scope)
    // SEC-01 FAIL-CLOSED: persist FIRST, register only when the credential is durable —
    // a generation that a restart would forget must never appear usable.
    if (config.store !== undefined) {
      config.store.upsert({
        clientId: client.clientId,
        secret: client.secret,
        scheme: 'oauth-resource-server',
        scope: client.scope,
        createdAt: new Date().toISOString(),
      })
    }
    clients.set(client.clientId, client)
    revoked.delete(client.clientId)
  }

  return {
    upsertClient(client) {
      register(client)
    },

    generateClient(options) {
      if (typeof options.clientId !== 'string' || options.clientId.length === 0 || options.clientId.length > 64) {
        throw new Error('clientId must be a non-empty string of at most 64 characters')
      }
      if (clients.has(options.clientId) || config.store?.get(options.clientId) !== undefined) {
        throw new Error(`a credential for ${JSON.stringify(options.clientId)} already exists; revoke it first`)
      }
      // SEC-01: high entropy — 32 crypto-random bytes, base64url-encoded. The secret
      // is generated SERVER-SIDE and returned exactly once from this function.
      const secret = randomBytes(32).toString('base64url')
      register({ clientId: options.clientId, secret, scope: options.scope ?? ['mcp:call'] })
      return { clientId: options.clientId, secret }
    },

    revokeClient(clientId) {
      /**
       * Revocation is decided by the LIVE authority, never by the hydrated map:
       * a client generated AFTER this server was constructed (a "late client")
       * exists only in the durable store, and revoking it must delete the
       * durable record just like any other. The revocation FINGERPRINT is the
       * hash of the client's own SECRET — scoped to the credential, not the id —
       * so a legitimate re-generation of the same id with a fresh secret is
       * never blocked by an old revocation.
       */
      const client = liveClient(clientId)
      if (client !== undefined) {
        revoked.set(clientId, createHash('sha256').update(client.secret).digest('hex'))
        // Durable revocation: the store entry is DELETED, so the credential does not
        // resurrect on the next boot. A persistence failure surfaces to the caller;
        // the in-memory revocation still stands for this process.
        config.store?.delete(clientId)
      }
    },

    async issueAccessToken(clientId, scope) {
      const client = liveClient(clientId)
      if (client === undefined) return undefined as never
      // SECRET-SCOPED revocation: the fingerprint is the hash of the revoked
      // secret itself, so re-generating the same id with a FRESH secret issues
      // again, while a revoked secret never does.
      const revokedHash = revoked.get(clientId)
      if (revokedHash !== undefined && revokedHash === createHash('sha256').update(client.secret).digest('hex')) {
        return undefined as never
      }
      const grantedScope = scope === undefined || scope.length === 0
        ? [...client.scope]
        : [...new Set(scope.filter(name => client.scope.includes(name)))]
      const now = Math.floor(Date.now() / 1000)
      const header = b64url(ENCODER.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
      const payload = b64url(ENCODER.encode(JSON.stringify({
        iss: config.issuer,
        sub: client.clientId,
        aud: config.audience,
        scope: grantedScope.join(' '),
        iat: now,
        exp: now + lifetime,
        jti: `jti_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      })))
      const signingInput = `${header}.${payload}`
      const signature = await crypto.subtle.sign('HMAC', await keyFor(client.secret), ENCODER.encode(signingInput))
      return `${signingInput}.${b64url(new Uint8Array(signature))}`
    },

    async verify(token, requiredScope) {
      const parts = token.split('.')
      if (parts.length !== 3) {
        return {
          ok: false,
          error: { code: 'invalid_request', description: 'the credential is not a JWT with three parts' },
        }
      }
      const header = decodePart(parts[0])
      const payload = decodePart(parts[1])
      if (header?.alg !== 'HS256' || payload === undefined) {
        return {
          ok: false,
          error: { code: 'invalid_request', description: 'the credential is not an HS256 JWT with a JSON payload' },
        }
      }
      const clientId = payload.sub
      if (typeof clientId !== 'string') {
        return {
          ok: false,
          error: { code: 'invalid_request', description: 'the credential carries no subject' },
        }
      }
      // The LIVE registry entry: the durable store first, so a rotated or
      // deleted credential is judged by the CURRENT secret and scope, never by
      // the construction-time snapshot.
      const client = liveClient(clientId)
      if (client === undefined) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential is from an unknown client' },
        }
      }

      // SIGNATURE FIRST: only a credential signed with the client's own key may
      // present claims about that client, so nothing below reads an unsigned claim
      // — including the revocation state, which a forged credential must not be
      // able to probe (F2: the revoked check sat here before and answered an
      // unsigned token claiming sub=X, revealing whether X is revoked).
      const signingInput = `${parts[0]}.${parts[1]}`
      const signaturePart = parts[2] as string
      const presented = Buffer.from(signaturePart, 'base64url')
      const expected = new Uint8Array(await crypto.subtle.sign(
        'HMAC', await keyFor(client.secret), ENCODER.encode(signingInput),
      ))
      const matches = presented.length === expected.length && timingSafeEqual(presented, expected)
      if (!matches) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential signature does not verify' },
        }
      }

      const revokedHash = revoked.get(clientId)
      if (revokedHash !== undefined && revokedHash === createHash('sha256').update(client.secret).digest('hex')) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential is revoked' },
        }
      }
      // SEC-01: a client deleted from the durable store by ANY surface — the local
      // revokeClient, the host's management action, or another process — is revoked
      // for this process too, on the very next verification. The live lookup above
      // consults the store; this is the in-memory fallback check.
      if (config.store !== undefined && config.store.get(clientId) === undefined) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential is revoked' },
        }
      }

      // Issuer and audience are validated AFTER the signature: only then are they
      // facts the issuer asserted rather than text an attacker wrote.
      if (payload.iss !== config.issuer) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential was issued by a different authorization server' },
        }
      }
      const audience = payload.aud
      const audiences = Array.isArray(audience) ? audience : [audience]
      if (!audiences.includes(config.audience)) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: `the credential audience does not include ${config.audience}` },
        }
      }

      const exp = payload.exp
      const now = Math.floor(Date.now() / 1000)
      if (typeof exp !== 'number' || now > exp + leeway) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential has expired' },
        }
      }
      const iat = payload.iat
      if (typeof iat === 'number' && iat > now + leeway) {
        return {
          ok: false,
          error: { code: 'invalid_token', description: 'the credential is not yet valid' },
        }
      }

      const scope = typeof payload.scope === 'string'
        ? payload.scope.split(' ').filter(Boolean)
        : []
      /**
       * F1 FIX (review): the presented scope is CAPPED at the client's registered
       * grant. Issuance already caps it, but with symmetric keys a client can
       * self-mint a token claiming ANY scope — verification is therefore the only
       * place the per-client grant can be enforced, and it was not. A claim the
       * registry does not admit is refused here, never trusted.
       */
      const overGrant = scope.filter(name => !client.scope.includes(name))
      if (overGrant.length > 0) {
        return {
          ok: false,
          error: {
            code: 'invalid_token',
            description: `the credential claims scope beyond this client's grant: ${overGrant.join(', ')}`,
          },
        }
      }
      const required = requiredScope ?? []
      const missing = required.filter(name => !scope.includes(name))
      if (missing.length > 0) {
        return {
          ok: false,
          error: {
            code: 'insufficient_scope',
            description: `the credential lacks required scope: ${missing.join(', ')}`,
            scope: required.join(' '),
          },
        }
      }

      return {
        ok: true,
        token: {
          clientId,
          scope,
          audience: config.audience,
          jti: typeof payload.jti === 'string' ? payload.jti : '',
        },
      }
    },

    authorizationServerMetadata() {
      return {
        issuer: config.issuer,
        // NO token_endpoint (F3, review): issuance is programmatic-only here, so
        // advertising an endpoint the transport never serves would be an RFC 8414
        // lie. A client that finds this issuer knows credentials come from the
        // operator's configuration, not from a token request.
        response_types_supported: ['token'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        grant_types_supported: ['client_credentials'],
      }
    },

    protectedResourceMetadata() {
      return {
        resource: config.audience,
        authorization_servers: [config.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: [...new Set([...clients.values()].flatMap(client => client.scope))],
      }
    },
  }
}

/** Build the RFC 6750 challenge header for a verification failure. */
export function oauthChallenge(error: OAuthTokenError, realm = 'tool-mode'): string {
  const params = [
    `realm="${realm}"`,
    `error="${error.code}"`,
    `error_description="${error.description.replaceAll('"', "'")}"`,
  ]
  if (error.code === 'insufficient_scope') params.push(`scope="${error.scope}"`)
  return `Bearer ${params.join(', ')}`
}

/**
 * The HTTP status RFC 6750 §3.1 assigns to each token error.
 *
 * All three are 401-shaped failures, but the RFC distinguishes them so a client
 * can tell "malformed request, fix it" (400) from "credential bad, re-auth"
 * (401) from "credential fine, grant too small" (403). Flattening every
 * challenge to 401 was the F4 gap: a client receiving 400 for a revoked token
 * would re-send the same request, and one receiving 401 for insufficient scope
 * would re-authenticate pointlessly instead of asking for the scope.
 */
export function oauthErrorStatus(error: OAuthTokenError): 400 | 401 | 403 {
  switch (error.code) {
    case 'invalid_request': return 400
    case 'insufficient_scope': return 403
    case 'invalid_token': return 401
  }
}

/** Extract the error code from a challenge, for tests and diagnostics. */
export function challengeErrorCode(challenge: string): string | undefined {
  return /error="([^"]+)"/.exec(challenge)?.[1]
}
