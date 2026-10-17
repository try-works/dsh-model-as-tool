# OBS-04 note — settings/diagnostic surface and catalog-change notifications

- The settings/diagnostic surface is served through the management channel
  (`model_tools` actions `list`/`installed`/`describe`/`diagnostics`/`receipts`/`mcp`/
  `extensions-pending`) plus the DECL-07 native discovery pair `tool_mode_list`/
  `tool_mode_describe`. A dedicated settings UI is not built; generic tool cards
  are the accepted initial form (OBS-04).
- Catalog-change notifications (MCP-07, P26-09): the host-side
  `SubscriptionRegistry` is constructed in the plugin and
  `notifyCatalogChange()` fires on every catalog transition — model
  install/uninstall (`install`/`uninstall` in src/index.ts), extension update
  commit and rollback (the `extensions-commit`/`extensions-rollback` management
  actions), and the readiness/registration flows these drive. Each transition
  publishes `notifications/tools/list_changed` per eligible subscriber with the
  catalog generation AND runs it through the DELIVERY consumer
  (`deliverCatalogChange` in src/mcp/subscriptions.ts): the registry's
  per-caller filtering decides who gets the event, the sink carries it to each
  client's stream ack-first (an acknowledgement is marked sent before any
  publish can run), and revocation closes the stream with the
  teardown-cancelled frame first. `MemoryDeliverySink` is the transport seam a
  streaming endpoint injects its writer into; the consumer path, the
  unauthorized-client isolation and the revocation discipline are pinned by
  tests/subscription-delivery.test.ts.
- DELIVERY POSTURE (recorded, honest): the finite Streamable-HTTP response
  interface still refuses `subscriptions/listen` with `methodNotFound`
  (src/mcp/http.ts, the pinned posture) — the CONSUMER half now exists and is
  wired, so a transport that offers open streams receives the published events
  through it; the open-stream endpoint itself remains the recorded remainder.
