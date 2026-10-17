# EXT-35 — where the invocation generation on receipts is owned (SDK evidence note)

EXT-35 requires invocation receipts to record "extension ID, package version/content
digest, dependency-lock digest, model/recipe identity and **activation generation**".

**Ownership split (honest):**

- The SDK half records the DURABLE identity facts at install and activation time:
  `InstalledRecord` carries the extension id, version, `archiveDigest`,
  `contentDigest`, the locked dependency graph (`dependencies[]` with per-dependency
  `integrity`) and the recorded source (`packages/tool-mode-extension-sdk/src/install/store.ts`,
  `InstalledRecord`). The lifecycle advances the per-profile catalog generation on every
  activation change (`packages/tool-mode-extension-sdk/src/install/lifecycle.ts`,
  `#generation`, exposed as `generation`).
- The RECEIPT half — attaching that generation to an invocation receipt — is
  HOST-side by design: the SDK never builds receipts (it has no invocation
  accounting). The host package owns it in
  `packages/dsh-model-as-tool/src/invocation-accounting.ts` and
  `packages/dsh-model-as-tool/src/receipt.ts`, where the host-supplied invocation
  generation is stamped onto each receipt from the lifecycle's generation counter.
  The SDK's contribution to EXT-35 is therefore: the identity facts + the
  generation COUNTER; the host's is the receipt projection. This split is by
  design, not a gap: the SDK cannot attach a host-owned generation to a receipt
  it does not build.
