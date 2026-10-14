# Tool Mode release report

Generated 2026-10-14T02:47:15.357Z from commit `c62716efcfc621ae1ea1c5baa311c83e00107ffa` (working tree DIRTY, so this describes a state that exists in no commit).

## How to reproduce

From a clean checkout of the commit above: `npm install && npm run verify`.
No credentials or model assets are required for the suites reported here;
requirements needing either are recorded as BLOCKED or NOT_RUN rather than PASS.

## Installed package identities

| Package | Version |
|---|---|
| `@try-works/dsh-model-as-tool` | 0.1.3 |
| `@try-works/tool-mode-contracts` | 0.1.0 |
| `@try-works/tool-mode-extension-sdk` | 0.1.0 |
| `@try-works/extension-desert-ant-tongue` | 0.1.0 |
| `@try-works/extension-desert-ant-voz` | 0.1.0 |

## Requirement status

| Status | Count |
|---|---|
| PASS | 3 |
| FAIL | 96 |
| BLOCKED | 5 |
| NOT_RUN | 213 |
| NOT_APPLICABLE | 0 |

Total: 317 requirements, of which 3 PASS.

## MCP conformance matrix

| Fact | Value |
|---|---|
| Revision implemented | 2026-07-28 |
| Pinned schema commit | 5f5440bb26a62e2cf3440b92da5a667efa03b267 |
| Official SDK supports the revision | NO |
| Basis | Schema-conformant adaptation, verified by an independent probe |
| Probe checks | `npm run verify:mcp` |

## Model and modality support

| Model | Platform | Modality | Status |
|---|---|---|---|
| Tongue | win32 x64 | text to language | extension extracted, **not yet run against a real inference** |
| Voz | win32 x64 | audio to text | extension extracted, **not yet run against a real recording** |
| 16 further catalog models | varies | varies | cannot run on this host; recorded in the capability resolver |

## Known limitations and unresolved gates

314 requirement(s) are not PASS.
208 requirement(s) have no status written for them, and are reported as NOT_RUN.
No status key names something that is not a requirement.

The first 40 unresolved requirements:

- BASE-02 is FAIL
- BASE-03 is FAIL
- BASE-04 is FAIL
- BASE-05 is FAIL
- BASE-06 is NOT_RUN
- BASE-07 is NOT_RUN
- BASE-08 is NOT_RUN
- BASE-10 is NOT_RUN
- BASE-11 is NOT_RUN
- BASE-12 is NOT_RUN
- BASE-13 is NOT_RUN
- BASE-14 is NOT_RUN
- ARCH-01 is FAIL
- ARCH-02 is FAIL
- ARCH-03 is FAIL
- ARCH-04 is NOT_RUN
- ARCH-05 is FAIL
- ARCH-06 is FAIL
- RUN-01 is FAIL
- RUN-02 is FAIL
- RUN-03 is NOT_RUN
- RUN-04 is NOT_RUN
- RUN-05 is FAIL
- RUN-06 is FAIL
- RUN-07 is FAIL
- RUN-08 is FAIL
- MCP-01 is FAIL
- MCP-02 is FAIL
- MCP-03 is FAIL
- MCP-04 is FAIL
- MCP-05 is FAIL
- MCP-06 is FAIL
- MCP-07 is NOT_RUN
- MCP-08 is FAIL
- MCP-09 is FAIL
- MCP-10 is FAIL
- MCP-11 is NOT_RUN
- MCP-12 is FAIL
- MCP-13 is FAIL
- SEC-01 is NOT_RUN
- …and 274 more, in `verification/evidence.json`

## What this report does NOT claim

Per TDD-10: this document is not evidence that implementation, live inference or
Windows verification has occurred. It records statuses and identities. Where a
requirement needs a platform, model or credential this run did not have, it is
BLOCKED or NOT_RUN — never PASS.
