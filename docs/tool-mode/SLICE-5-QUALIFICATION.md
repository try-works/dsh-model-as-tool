# Slice 5 — target qualification record

**Every fact below was measured on this machine, not assumed.** Commands are given so each
result can be reproduced, and every limitation is stated narrowly rather than summarised as
"sandboxing works" or "sandboxing does not work".

## The environment measured

| Fact | Value | How it was read |
| --- | --- | --- |
| OS | Microsoft Windows 11 Home, `10.0.26200` | `Get-CimInstance Win32_OperatingSystem` |
| Platform / arch | `win32` / `x64` | `process.platform`, `process.arch` |
| Node | `v24.11.0` | `process.version` |
| Node module ABI | `137` | `process.versions.modules` |
| Repository | `D:\DEV\dsh-model-as-tool` | — |

## Sandbox confinement — the security finding

Confined modes were **untested** until this record. Every earlier PTC test ran under
`danger-full-access`, and the backend skips confinement entirely in that mode:

```js
// packages/ptc-runtime/ptc-runtime-node/src/index.ts
confined = policy.mode === 'danger-full-access'
  ? undefined
  : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)
```

So those tests proved dispatch and proved **nothing** about confinement. The gap was
recorded as open rather than left implied.

### `read-only` — WORKS

A generated program is executed and attempts `fs.writeFileSync` on a path inside its
workspace. The write does not happen and the file is not created. The run reports a
sandbox whose mode is not `danger-full-access`, so a confined run is distinguishable from
one that fell through to no confinement.

```
npx tsx --test packages/dsh-model-as-tool/tests/ptc-sandbox.test.ts
  ✔ read-only REFUSES a write the program attempts
  ✔ reports the ENFORCEMENT the sandbox actually applied
```

### `workspace-write` — BLOCKED on this machine, with the environment's own words

```
kind:    sandbox-unavailable
message: windows-acl-run: SetNamedSecurityInfoW failed (Win32 5):
         grantWrite(D:\DEV\dsh-model-as-tool)
```

Win32 error **5** is `ACCESS_DENIED`. The backend enforces `workspace-write` by granting
write through Windows ACLs, and this process cannot modify the ACL of the repository
directory it is asked to grant.

**This is an environment limitation, not an implementation defect**, and the distinction
matters: the code path is reached and it reports its failure precisely rather than
silently degrading to no confinement. The three `workspace-write` tests are **skipped with
this exact message** — not deleted, and not passing.

### A vacuous pass that was caught and fixed

The first version of the "workspace-write REFUSES a write OUTSIDE the workspace" test
**passed for the wrong reason**: the run errored out, the program's `wrote` field was
`undefined`, and `assert.notEqual(undefined, true)` held. A security assertion that passes
because its subject never executed is worse than no assertion, because it reads as
coverage. The tests now probe availability once at load and skip with the measured reason.

## What this record does NOT claim

- It does not claim the sandbox is enforced for `workspace-write`. It is not, here.
- It does not claim the security slice is satisfied. One of three modes is demonstrated.
- It does not claim `worker`, `process-tree` or memory confinement, which are separate
  requirements and were not exercised.
- It does not claim a Windows **clean install** of the packed artifact, which is a separate
  slice-5 item and remains outstanding.

## Outstanding slice 5 items

| Item | State |
| --- | --- |
| Windows clean install of the packed artifact | Not run in this record |
| No consumer build chain required | The published packages install without a compile step, but the *extension* packages have not been installed from the registry on a clean machine |
| Real model tests | `lang_detect` runs for real through the built artifact (`npm run verify:built`); the multimodal and specialist extensions do not |
| Sandbox/security tests | `read-only` demonstrated; `workspace-write` blocked; confinement beyond the filesystem not exercised |
| Modern MCP interoperability | 14 live checks over a real socket against revision `2026-07-28`; not interoperated with a third-party client implementation |
