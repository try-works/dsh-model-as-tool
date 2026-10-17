# Tool Mode author guide (EXT-36)

A concise author-side reference. The protocol requirements are normative:
`Tool_Mode_Extension_Protocol_v1.1.md`; the SDK ships the schemas and conformance helpers.

## Build and pack
- Write `tool-mode.extension.json` (id == package `name`, version == package `version`),
  ship it at the package root, and point `package.json` `toolMode.manifest` at it.
- A **module** extension exports `./tool-mode` (default-export `ToolModeExtensionV1`);
  a **declarative** extension ships only static recipe files and no executable entry.
- Build with your own toolchain before packing; end-user installation never runs a
  TypeScript toolchain. `npm pack --dry-run` must show dist/schemas/skills/
  models.lock.json/manifest/LICENSE.

## npm publication
- Publish exact versions; tags resolve once at install and are locked after.
- Record the published SHA-512 for HTTPS distribution (`--integrity`).

## HTTPS archive distribution
- Host the `.tgz`; operators install with a pinned integrity value. A URL package
  does NOT inherit the npm publisher's identity or grants.

## Verified model assets
- `models.lock.json` entries carry the provider/model identity, exact revision,
  engine, platform, license records, and per-asset byte length + SHA-256/512.
- Real lock files never contain placeholder hashes. Weights ship inside the archive
  only when redistribution rights allow; otherwise ship acquisition instructions.
- Downloads require the separate preparation consent — never the install.

## Cancellation and disposal
- `inspect`/`load`/`invoke`/`unload` honor the supplied `AbortSignal`; `dispose()`
  is idempotent and settles after owned resources stop. No attempt is retried
  automatically after an ambiguous transport failure.

## Typed results
- `invoke()` returns the domain payload WITHOUT the reserved `meta` field; the host
  derives the payload schema by removing only `meta`, validates, attaches the
  authoritative `ToolMeta`, and validates the canonical result. Public output-schema
  changes follow the contract-versioning rules (breaking change = new contract major
  + reviewed alias migration).

## Skills
- A skill is a data file the host surfaces as guidance; it performs no work and grants
  nothing. `requiresTools` names the executable tools the skill's surface needs.

## Licensing
- Declare per-layer licences (`code`, `engine`, `weights`, `conversion-artifacts`,
  `sdk`) in the manifest; a missing layer is a GAP, never a default. A config boolean
  is not a licence grant (LIC-03); attribution text travels with the record.
