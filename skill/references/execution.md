# Verified script reuse

The bootstrap handles this workflow for the user using the existing Aside JavaScript runtime.

## Learning contract

A successful schema-version-1 learning record can include `execution`:

```json
{
  "schemaVersion": 1,
  "context": "example-check",
  "effect": "read-only",
  "routes": [{
    "id": "saved",
    "transport": "aside-repl",
    "code": "if (input.expected !== 42) throw new Error('invalid-input'); return {verified: input.actual === input.expected};"
  }]
}
```

This is a shape example, not execution evidence. Submit it inside a full verified learning record after checking the actual procedure. At most three routes are supported, each with at most 16 KiB of async function body accepting `input`. The whole record retains its 64 KiB limit. Validate task-specific input types, bounds and allowed destinations in the recipe.

Storage: `SKILL.md`, `execution.json` (metadata, no code), and `scripts/<route-id>.js`. Only the selected code enters the agent context. Hashes, snapshots, archive/restore and rollback cover the entire package. Old MD-only packages and snapshots remain supported. Omitting `execution` in a later learning record preserves existing scripts; changing the MD still invalidates their prior routing evidence.

Use generic IDs and context slugs. Never store personal paths, account identifiers, cookies, credentials, private messages or raw page results in records. Syntax checks and the heuristic scanner do not prove safety, correctness or privacy. `effect: read-only` is a caller declaration, not a sandbox. A trusted caller must review the code and retain the host permission rules.

## Selection

`route --name NAME --context CONTEXT` returns a compact recommendation, without executing or counting success. Eligible scripts match the exact current package hash and context, have at least two observations in the last 30 days, and succeeded on their last two observations. Rank the last ten observations by success ratio first, then measured total tokens divided by successful runs. Failures count in cost. Missing or estimated usage is not treated as zero. Without measured costs, the deterministic order is not an assertion of savings.

Two checks are a pilot gate, not statistical proof. Test representative variations. A failed script requires revalidation; an unresolved attempt blocks further script execution for that managed skill across versions. `--probe` permits a bounded authorized candidate check; `--probe --route-id ID` selects a deliberate comparison. Do not run every alternative on every task or manufacture separate MCP/CLI copies of identical code.

## Native Aside

1. Retain a random UUID for the task and recovery.
2. Run `begin --name NAME --context CONTEXT --task-id UUID`; use `--probe` only for authorized candidate validation.
3. Read the returned file with the supported host tool and verify SHA-256 against `scriptHash`. If changed, record a blocked attempt and rediscover; never execute different bytes under the old attempt.
4. Execute that body as an async function accepting non-sensitive `input` using the existing native JavaScript tool. Node modules/processes are not available in Aside REPL. Avoid a nested Aside CLI.
5. Verify the result and record the original attempt. A failure invokes MD recovery, not a blind restart. Keep the attempt open until needed readback/recovery usage is available; another script cannot overlap it.

Loading code can still cost tokens. The intended savings come from avoiding repeated code generation, full-page context and reasoning between deterministic steps. No zero-token guarantee is made.

## External CLI

```sh
node bin/oma.mjs run --account-root "$ASIDE_ACCOUNT_ROOT" \
  --name oma-example --context example-check \
  --task-id "$TASK_UUID" --aside-account "$ASIDE_ACCOUNT_ID" \
  --input "$TASK_INPUT_JSON"
```

Resolve all variables on the owning host. The local Aside account ID is mandatory; the adapter passes `--host local` and never infers a browser profile from the learning directory. `run` handles begin/record itself. It invokes `aside repl` without a shell, passes only non-sensitive input, limits output to 256 KiB, and times out at 125 seconds (Aside documents 120 seconds). Timeout does not prove browser execution stopped: read back first.

The adapter extracts a unique result marker and verifier boolean. It does not echo or persist raw child stdout/stderr. Exceptions, missing markers and connection failures remain unknown; false verification requests MD recovery. The bootstrap handles AI repair, not another agent launched by the CLI. The CLI reports tokens=null because it has no provider usage feed.

## Receipts

Native callers use `record --receipt FILE`:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "outcome": "success",
  "verified": true,
  "failure": "none",
  "tokens": null,
  "tokenSource": "unknown"
}
```

Use the actual attempt ID. Outcomes: success, failed, unknown, blocked. Failures: none, check-failed, script-error, auth-required, timeout, interrupted, package-changed. Only success can set verified=true and failure=none. Token sources: measured, estimated, unknown; unknown requires null. Measured means actual provider usage, including relevant parent/child/repair consumption. Failed-script cost may include successful subsequent MD repair, but the script outcome stays failed.

Account-local `execution-state.json` holds these observations and version/context IDs, not personal memory. Duplicate identical final receipts are idempotent; conflicting final receipts fail. A later actual readback can resolve unknown. At most two script attempts are accepted per task UUID, including probes. Bootstrap guidance additionally limits MD repair to one attempt; it cannot cap arbitrary model spending outside these entrypoints.

Interrupted runs remain unresolved. Never delete evidence or invent IDs to bypass a blocker. State is bounded at 5,000 attempts and 2 MiB; reaching the limit requires reviewed maintenance rather than silent eviction.
