# EXT-30 update & rollback — side-by-side staged design

**Status:** DESIGN ONLY. No source, test, package or lock-file changes accompany this
document. It refines the previously REJECTED swap-overwrite sketch into the approved
side-by-side staged shape. Implementation proceeds in three slices, each of which must
be its own task with its own review.

**Authoritative clauses** (Tool_Mode_Extension_Protocol_v1.1.md):

- **EXT-30** — "Install updates side-by-side; do not mutate a live directory. Resolve
  exact code/dependency/asset changes, recheck API/platform compatibility, permissions,
  schemas and license changes, and run validation/self-tests in a nonpublished staging
  scope. Any model download during qualification still requires preparation consent.
  Quiesce old generation admissions and perform a coherent switch after validation.
  Existing compositions retain a pinned contract/binding generation or fail explicitly;
  they never silently adopt incompatible semantics. Retain the last working version
  until the new version succeeds. On failure restore the last valid catalog and report
  the failed upgrade. Rollback does not undo security revocations or re-enable
  deliberately disabled tools, and cannot reactivate quarantined content without
  approval. Breaking contract changes require a reviewed migration. No background
  package auto-update or mandatory migration callback execution is required in v1.
  State-schema migrations must be reversible from a backup or blocked before changing
  data."
- **AT-36** — "Failed activation and failed updates roll back catalog publication.
  Successful side-by-side updates preserve old callers' semantics or fail them
  explicitly; rollback preserves revocations/disabled state."
- **AT-35** (supporting) — "Permission/identity changes require approval."
- **AT-39** (supporting) — "An ordinary MCP client/program cannot … update … packages."

## 1. Why the swap-overwrite design was rejected

The earlier sketch staged a new archive, backed up the live directory by RENAME, and
then renamed the new bytes into the same path. Three properties make that shape
unacceptable under EXT-30:

1. **It mutates the live installation path.** A rename-away backup + rename-in
   replacement is still an in-place directory swap: any live caller (managed worker,
   open native-library handle on Windows, the registry's cached entry resolution)
   sees the path change underneath it. EXT-29/AT-37 exist precisely because Windows
   file locks make that unsafe.
2. **Rollback is a byte copy over a live install.** Restoring means copying the backup
   back into the live path — exactly the "mutate a live directory" operation EXT-30
   forbids, and a crash mid-copy leaves a hybrid directory that fails open or fails
   closed with no honest state.
3. **Ownership of the path changes across arbitrary ownership domains.** The rename
   crosses from the store's staging area into a directory another process may hold
   open; no token or lease exists to make that safe.

## 2. The approved shape: a version pool + an atomic active pointer

The store ALREADY has a versioned pool: `installPathFor` returns
`<storeDir>/extensions/<extensionId>/<version>` (staged.ts), and `activate(id, version)`
selects a version. The update design keeps that pool and makes the SELECTION an
explicit, atomically committed pointer instead of an implicit activation choice.

```
<storeDir>/
  extensions/<id>/<v1>/            # the last working version — NEVER mutated
  extensions/<id>/<v2>/            # the staged, validated, approved new version
  staging/<id>-<token>/            # extraction/validation workspace (nonpublished)
  profiles/<profile>/state.json    # the ACTIVE POINTER + tools/readiness/revocations
```

- **Staging** extracts the new archive into `staging/`, never into `extensions/<id>/`.
- **Admission** moves the staged directory to `extensions/<id>/<v2>` only after every
  validation gate and the operator approval (below) — a plain `renameSync` into a NEW
  sibling path, not over the live version.
- **The active pointer** is a new `activeVersion` field carried by the versioned
  profile state document. Committing the pointer is the existing atomic
  `writeProfileState` (temp + rename, inside `store.lock`). A crash before the pointer
  write leaves `<v1>` active; a crash after it leaves `<v2>` active — there is no
  hybrid state.
- **Rollback is a pointer restore.** `activeVersion` is written back to the previous
  value. No bytes are copied over any live install, and the old version directory is
  never touched. (OPEN DECISION 1: a sidecar `profiles/<profile>/active.json` pointer
  file is the alternative placement; the profile-state field is preferred because it
  reuses the existing atomic write, lock and migration machinery.)

The `<v1>` directory is retained (the "last working version") until the operator
removes it deliberately — an update never garbage-collects it as a side effect.

## 3. Validation gates, in order

Every gate below runs against the STAGED directory in the nonpublished staging scope
before the staged directory is admitted as `<v2>`:

1. **Manifest validation** — `discoverExtension` + the manifest validator, exactly as
   install uses them (AT-35's identity rules included: no name/contract theft, no
   built-in self-marking).
2. **Integrity** — digest over the staged bytes recorded beside the version dir, so a
   later mutation is detectable (`verifyUnchanged`'s discipline).
3. **API/platform compatibility** — the existing `compatibility.hostApi` /
   `requiredFeatures` recheck against the CURRENT host surface.
4. **Schema compatibility** — input/output schema diffs against the ACTIVE version's
   schemas: additive/optional changes proceed with a delta record; narrowing,
   re-typing or removing a published field is a BREAKING change and is REFUSED pending
   a reviewed migration (EXT-30's breaking-change clause). Compositions pinned to a
   contract/binding generation keep the old generation or fail explicitly — never a
   silent adoption of the new semantics.
5. **License delta** — the shipped license text/layer is compared to the active
   version's. A difference produces a delta record and requires operator approval.
6. **Permission delta** — `permissions.*` diffed field-by-field (networkOrigins,
   inputFiles, storage, secrets, nativeCode). Expansions are listed in the approval
   record; no expansion takes effect without explicit operator approval (AT-35).
7. **Self-tests in the nonpublished scope** — fixture/validation scripts run against
   the staged bytes in a scope that CANNOT publish (host-executed, see §6). Any model
   download the self-tests would need still requires preparation consent — a staged
   update performs NO preparation on its own.

The gate outputs are collected into an `UpdateValidationReport`; any refusal leaves the
staged directory quarantined (`<id>-<token>.rejected`) with the recorded reason, or is
deleted, per the operator's choice — never admitted.

## 4. Commit, quiesce and failure behavior

1. **Quiesce old-generation admissions first.** The SDK's existing
   deactivate/withdraw machinery (including the `onWithdrawal` teardown hook) stops
   admissions for the OLD version's callable surface before the pointer moves. Live
   calls already in flight finish under their pinned generation; new admissions wait
   on the pointer.
2. **Commit the pointer** — `writeProfileState` with `activeVersion: <v2>` under
   `store.lock` (the store's single serialization point; §5).
3. **Rebind** — the host's registrar publishes the new version's surface (host half,
   §6) and the catalog generation advances.
4. **Activation failure AFTER the pointer commit** → automatic rollback: the pointer is
   written back to `<v1>` and the failed upgrade is reported
   (`EXTENSION_FAULT`-vocabulary record naming the failing gate), OR the record is
   left `quarantined` with the recorded reason when the host chose explicit quarantine.
   Either way the durable answer is never "half updated".
5. **Rollback semantics** — rollback restores ONLY the pointer. It never re-enables a
   deliberately disabled tool, never undoes a security revocation (those facts live in
   the profile state beside the pointer and are not touched), and never reactivates
   quarantined content without a fresh approval.
6. **Fail-closed corruption** — before a pointer commit or a rollback, the target
   version directory's digest is verified. A corrupt `<v2>` refuses the commit; a
   corrupt `<v1>` refuses the rollback and the extension is quarantined with the
   recorded reason — the pointer never points at unverified bytes.

## 5. Concurrency

Two updaters (CLI + host) are serialized by the EXISTING `store.lock` (the same lock
install and profile writes use): stage → validate → approve → quiesce → pointer commit
runs as one read-modify-write inside the lock, so a second updater cannot commit a
stale pointer over the first's commit. No new lock mechanism is introduced.

## 6. Host participation — REQUIRED vs SDK-only

**SDK-only (this package owns and tests):**

- the staged extraction/validation gates and the `UpdateValidationReport`;
- the version-pool admission, the atomic pointer commit, rollback and quarantine
  records;
- the approval RECORD persistence (what needs approving and whether it was granted).

**Host-REQUIRED (the SDK refuses or defers to these, never invents them):**

- the OPERATOR APPROVAL SURFACE — the human decision over the license/permission
  deltas and breaking changes; the SDK persists the record, the host decides;
- the DEPLOYMENT COORDINATOR — preparation consent for any model assets the new
  version declares, and the readiness re-recording after the switch;
- a NONPUBLISHED EXECUTION SCOPE for self-tests (the managed-worker mechanism with
  publication disabled — the same isolation task-27 owns);
- the CATALOG REBIND — the host's registrar publish/withdraw under the new
  generation (the SDK's lifecycle already exposes this via the registrar).

**Interface sketch (to be refined when the slice tasks are written):**

```ts
// SDK side (store + lifecycle additions)
interface UpdateStageResult {
  readonly extensionId: string
  readonly stagedVersion: string
  readonly report: UpdateValidationReport   // gates 1-7, deltas listed
  readonly requiresApproval: boolean
}
stageUpdate(request: { extensionId: string; source: InstallSource; expectedSha512?: string })
  : Promise<UpdateStageResult>                                   // store lock held
recordApproval(extensionId: string, stagedVersion: string,
  decision: { approved: true } | { denied: true; reason: string }): void
commitUpdate(extensionId: string, stagedVersion: string): Promise<UpdateResult>
  // quiesce → pointer → rebind; on failure: rollbackPointer + named reason
rollback(extensionId: string): Promise<RollbackResult>            // pointer restore ONLY

// Host side (interface sketch only)
interface UpdateHostSurface {
  requestApproval(record: ApprovalRecord): Promise<ApprovalDecision>
  runSelfTests(staged: StagedUpdateLocation, scope: NonPublishedScope): Promise<SelfTestResult>
  rebindCatalog(extensionId: string, activeVersion: string): Promise<void>
}
```

## 7. Phased implementation plan

**Slice 1 — stage + validate + approval record (SDK).** `stageUpdate` (staging dir,
all seven gates, digest record, `UpdateValidationReport`, approval record
persistence). Satisfies: EXT-30's "install side-by-side; do not mutate a live
directory", "resolve exact code/dependency/asset changes", "recheck API/platform
compatibility, permissions, schemas and license changes", the nonpublished
validation-scope half of "run validation/self-tests in a nonpublished staging scope"
(fixture self-tests where host execution is not yet wired), and the AT-35
permission/identity-approval record.

**Slice 2 — pointer commit + rollback (SDK).** The `activeVersion` pointer
(profile-state field with a STATE_VERSION bump + reversible migration — the migration
discipline task-26 established), `commitUpdate` with quiesce-before-commit, automatic
rollback on post-commit activation failure, `rollback` as pointer restore with the
revocation/disabled-state preservation guarantees, fail-closed corruption checks.
Satisfies: "quiesce old generation admissions and perform a coherent switch", "retain
the last working version until the new version succeeds", "on failure restore the
last valid catalog and report the failed upgrade", "rollback does not undo security
revocations or re-enable deliberately disabled tools", "existing compositions retain
a pinned contract/binding generation or fail explicitly", and AT-36's rollback clauses.

**Slice 3 — host approval wiring (host lane, coordinated like task-27).** The operator
approval surface over the SDK's approval records, the deployment coordinator
(preparation consent + readiness re-record), self-tests through the managed-worker
nonpublished scope, and the catalog rebind through the host registrar; the management
channel stays the ONLY update path (AT-39: an ordinary MCP client cannot update).
Satisfies: "any model download during qualification still requires preparation
consent", "breaking contract changes require a reviewed migration", "cannot
reactivate quarantined content without approval", the explicit no-background-
auto-update guarantee, and AT-39's management-channel-only update rule.

## 8. Open decisions (for the Lead)

1. Pointer placement: profile-state `activeVersion` field (preferred) vs a sidecar
   `active.json` pointer.
2. Self-test scope in slice 1: SDK fixture self-tests only, or host-executed from the
   start (affects slice 1's size).
3. Approval-record retention/expiry policy (denied records, re-approval after edits).
4. Whether `rollback` is an operator command only, or also automatic on any
   `commitUpdate` post-commit failure (the design above does both: automatic on the
   failed commit, operator-commandable later).
