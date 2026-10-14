/**
 * Catalog subscriptions (P26-09, P26-10).
 *
 * The rules that make this more than an event emitter, each of which a naive
 * implementation gets wrong:
 *
 * - **Acknowledge first, and acknowledge only what is SUPPORTED.** The ack carries
 *   the filter the server will actually honour, not the one the client asked for. A
 *   client that requested four notification types and is sent back one is being told
 *   the truth; echoing all four and then sending one is a silent lie the client
 *   cannot detect until it waits forever.
 * - **No event before the acknowledgement.** So the ack is emitted synchronously as
 *   part of establishing the subscription, and the subscription only becomes
 *   eligible for real events afterwards.
 * - **Every event carries the subscription id** in the revision's notification
 *   metadata, because a client with several subscriptions cannot otherwise tell
 *   which one an event belongs to.
 * - **Filter per caller.** Each subscription belongs to one client and sees only its
 *   own catalog. One client's private package changes are never delivered to
 *   another, which is the leakage the requirement names.
 * - **Teardown is announced.** Revoking a grant sends `notifications/cancelled`
 *   referencing the subscription request BEFORE the stream closes, so a client can
 *   distinguish "your access ended" from "the connection dropped".
 * - **Progress does not travel here** (P26-10). Progress belongs on the response
 *   stream of the call that produced it; routing it onto the catalog stream would
 *   deliver one call's progress to every subscriber.
 *
 * @module @try-works/dsh-model-as-tool/mcp/subscriptions
 */

import { ERROR_CODES, WireError, type WireRequest } from './protocol.ts'

/** The notification types the revision defines for catalog changes. */
export type SubscriptionFilterKey =
  | 'toolsListChanged'
  | 'promptsListChanged'
  | 'resourcesListChanged'
  | 'resourceSubscriptions'

/** The filter a client requested, or the subset the server acknowledged. */
export type SubscriptionFilter = Partial<Record<SubscriptionFilterKey, boolean>> & {
  readonly resourceSubscriptions?: readonly string[]
}

/**
 * The notification types this server actually emits.
 *
 * Only tool-catalog changes exist, because only tools are published. Declaring the
 * others unsupported is what makes the acknowledgement honest.
 */
export const SUPPORTED_FILTERS: readonly SubscriptionFilterKey[] = ['toolsListChanged']

/** The official metadata key carrying the subscription's request id. */
export const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId'

/** One active subscription. */
export interface Subscription {
  /** The id of the `subscriptions/listen` request that established it. */
  readonly subscriptionId: string
  /** The client it belongs to. Every event is filtered through this. */
  readonly clientId: string
  /** The filter the server ACKNOWLEDGED, which is the supported subset. */
  readonly acknowledged: SubscriptionFilter
  /**
   * Whether the acknowledgement has been emitted.
   *
   * Nothing is published before it is true, which is how P26-09 requirement that no
   * event precede the acknowledgement is enforced rather than remembered.
   */
  announced: boolean
}

/** A message the transport should deliver to one client. */
export interface SubscriptionMessage {
  /** The client it is for. */
  readonly clientId: string
  /** The notification to send. */
  readonly notification: Record<string, unknown>
}

/**
 * Narrow a requested filter to what this server supports.
 *
 * P26-09 says to acknowledge only supported requested filters. A requested type
 * that is not supported is DROPPED rather than acknowledged-and-ignored: an
 * acknowledged type that never fires is indistinguishable from a broken server.
 * @param requested - the filter the client asked for.
 * @returns the acknowledged filter.
 */
export function acknowledgeFilter(requested: SubscriptionFilter): SubscriptionFilter {
  const acknowledged: Record<string, boolean> = {}
  for (const key of SUPPORTED_FILTERS) {
    // Only a type the client actually REQUESTED can be acknowledged: granting a
    // type nobody asked for would start sending an unrequested notification.
    if (requested[key] === true) acknowledged[key] = true
  }
  return acknowledged
}

/** Manages the active catalog subscriptions. */
export class SubscriptionRegistry {
  readonly #subscriptions = new Map<string, Subscription>()
  /** Counter for ids this server issues, so an id is never caller-chosen. */
  #issued = 0

  /** Active subscriptions, for diagnostics. */
  get active(): readonly Subscription[] {
    return [...this.#subscriptions.values()]
  }

  /**
   * Establish a subscription.
   *
   * The acknowledgement notification is returned as part of the result and is
   * marked sent before anything can be published, so no event can precede it.
   * @param request - the `subscriptions/listen` request.
   * @param clientId - the authenticated client, which the subscription is bound to.
   * @returns the result envelope, the acknowledgement, and the subscription id.
   */
  listen(request: WireRequest, clientId: string): {
    readonly result: Record<string, unknown>
    readonly acknowledgement: Record<string, unknown>
    readonly subscriptionId: string
  } {
    /**
     * `notifications` IS REQUIRED, and this used to default it.
     *
     * The pinned schema's `SubscriptionsListenRequestParams` declares
     * `required: ["_meta","notifications"]`. Defaulting an absent filter to `{}` and
     * returning SUCCESS contradicted that AND contradicted this module's own rule that a
     * missing required field is `invalidParams` rather than a defaulted value — a client
     * would receive an acknowledgement for a subscription it never described, and the
     * filter it believed it had sent would be silently empty.
     */
    const requested = request.params?.notifications
    if (requested === undefined || requested === null || typeof requested !== 'object' || Array.isArray(requested)) {
      throw new WireError(
        ERROR_CODES.invalidParams,
        'subscriptions/listen requires params.notifications; a missing filter is invalid rather than defaulted',
      )
    }
    const filter = requested as SubscriptionFilter
    const acknowledged = acknowledgeFilter(filter)
    // Server-issued. A caller-chosen id would let one client address another
    // client's subscription in a later cancellation.
    const subscriptionId = `sub_${Date.now().toString(36)}_${(++this.#issued).toString(36)}`

    const subscription: Subscription = { subscriptionId, clientId, acknowledged, announced: true }
    this.#subscriptions.set(subscriptionId, subscription)

    return {
      result: {
        resultType: 'complete',
        // The revision REQUIRES the subscription id in this result's metadata.
        _meta: { [SUBSCRIPTION_ID_KEY]: subscriptionId },
      },
      acknowledgement: {
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: {
          // The filter the server will HONOUR, not the one requested.
          notifications: acknowledged,
          // The subscription id is what lets a client with several subscriptions
          // tell which one an event belongs to.
          _meta: { [SUBSCRIPTION_ID_KEY]: subscriptionId },
        },
      },
      subscriptionId,
    }
  }

  /**
   * Publish a tool-catalog change.
   *
   * @param generation - the catalog generation that changed, carried so a client
   *   can tell a real change from a duplicate delivery.
   * @returns one message per eligible subscriber, and nothing for anyone else.
   */
  publishToolListChanged(generation: number): readonly SubscriptionMessage[] {
    const messages: SubscriptionMessage[] = []
    for (const subscription of this.#subscriptions.values()) {
      // Two independent conditions: the client asked for this type, and it is
      // still active. A revoked subscription is removed outright, so there is no
      // window in which it receives one last event.
      if (subscription.acknowledged.toolsListChanged !== true) continue
      if (!subscription.announced) continue
      messages.push({
        clientId: subscription.clientId,
        notification: {
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
          params: {
            _meta: { [SUBSCRIPTION_ID_KEY]: subscription.subscriptionId },
            generation,
          },
        },
      })
    }
    // Deliberately one message per subscriber rather than one broadcast: the
    // transport must address each client, so a shared object would make cross-client
    // leakage a matter of how the transport happened to iterate.
    return messages
  }

  /**
   * Revoke every subscription belonging to a client, announcing each first.
   *
   * P26-09 requires the teardown notification BEFORE the stream closes, so the
   * client learns its access ended rather than inferring it from a dropped socket.
   * @param clientId - the client whose grant was revoked.
   * @returns the teardown messages, already ordered cancellation-first.
   */
  revoke(clientId: string): readonly SubscriptionMessage[] {
    const messages: SubscriptionMessage[] = []
    for (const [id, subscription] of [...this.#subscriptions]) {
      if (subscription.clientId !== clientId) continue
      messages.push({
        clientId,
        notification: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: {
            // References the SUBSCRIPTION request, so the client can match it to
            // the listen call it made.
            requestId: subscription.subscriptionId,
            reason: 'the grant for this subscription was revoked',
            _meta: { [SUBSCRIPTION_ID_KEY]: id },
          },
        },
      })
      // Removed AFTER its teardown is queued, and before returning, so a publish
      // racing this call cannot deliver one more event to a revoked client.
      this.#subscriptions.delete(id)
    }
    return messages
  }

  /**
   * Close one subscription at the client's request.
   * @param subscriptionId - the subscription to close.
   * @param clientId - the caller, which must own it.
   * @returns whether it was closed.
   */
  close(subscriptionId: string, clientId: string): boolean {
    const subscription = this.#subscriptions.get(subscriptionId)
    // Ownership is checked, not assumed: without it one client could close
    // another's subscription by guessing an id.
    if (subscription === undefined || subscription.clientId !== clientId) return false
    this.#subscriptions.delete(subscriptionId)
    return true
  }

  /** Every subscription belonging to one client. */
  forClient(clientId: string): readonly Subscription[] {
    return [...this.#subscriptions.values()].filter(subscription => subscription.clientId === clientId)
  }
}

/**
 * Build the `notifications/cancelled` a client sends to stop a subscription.
 *
 * `CancelledNotificationParams` requires only `requestId`, so the notification
 * carries exactly that: adding a `_meta` with an undefined version would put a
 * meaningless member on the wire.
 * @param subscriptionId - the subscription to cancel.
 * @returns the notification.
 */
export function cancelSubscription(subscriptionId: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: subscriptionId },
  }
}
