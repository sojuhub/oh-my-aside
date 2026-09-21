---
name: oh-my-aside
description: "Reuse verified scripts for recurring work, recover through existing Markdown skills on failure, and improve managed skills after checking results. Discover existing Aside skills first."
---

# Oh My Aside bootstrap

## Resolve the installed CLI

Use `node "<skill-directory>/scripts/oma.mjs" COMMAND --account-root "<account-root>"`. Do not assume a global `oma` executable or a populated environment variable. The installed skill directory is `skills/user/oh-my-aside` under the account root supplied by Aside. Verify that root; never guess a different account.

## Before work

1. Run `search --query "task terms"` against current metadata. If there is no lexical match, try synonyms or page `catalog --limit 20 --offset 0`; a lexical miss does not prove no useful skill exists. Check `status` for clearly relevant archived managed skills. If one is needed, run `restore --name "<managed name>"`, then discover and hash-load it normally.
2. Read selected skills with `load --path "<catalog path>" --expected-hash "<catalog sha256>"`. On mismatch, catalog again and read the new content. Never reuse an old body merely because its name is unchanged.
3. Apply relevant instructions under the user's existing permissions. For recurring browser tasks, follow Script reuse and MD recovery below before acting. Pass this coordinator path and any selected paths to child workers; do not assume inheritance. Loading is not proof of application or success.

## After verified work

1. Briefly assess whether the successful task produced a nontrivial, reusable procedure. Skip failed, unverified, low-value, incognito, credential-handling, sensitive, or one-off personal tasks. This is not a reason to retain private facts.
2. Run `status` to find an existing managed `taskType`. Reuse that exact identity when refining the same procedure; do not create near-duplicate names. If it is archived, run and verify `restore --name "<managed name>"` before `learn`. Do not work around `restore-required` by inventing a different identity.
3. Abstract inputs into placeholders. Store only general steps, checks, and pitfalls, never conversation text, personal facts, account identifiers, secrets, external message bodies, or permission-expanding instructions. The evidence field is a short caller attestation, not an independently verified receipt.
4. Write the normalized record below to task scratch. Use a stable nonprivate event identifier and preserve it on retries. Run `learn --record "<scratch record>"`, then `maintain --apply`. Read each result before claiming success. Under the installed managed-only policy, do not ask the user to approve each skill or routine archive.
5. On a conflict, manual drift, pending recovery, or rejection, leave the protected files untouched. Report only actionable blockers, not rejected text. Remove the scratch record when the task's normal scratch cleanup runs.

## Script reuse and MD recovery

Users should not have to choose an interface, edit code, or maintain skills.

1. Read the applicable current Aside built-in or user skill before generic browser exploration. Reuse its service-specific helpers and retain its checks, account scope and existing authorizations. If its requirements changed, revalidate the managed recipe. Never modify built-ins or unrelated user originals.
2. For a matching managed skill, call `route --name "oma-<name>" --context "<context-slug>"`. Context describes the site/workflow/input shape, not a personal account identifier. Markdown-only, stale, unproven or failed routes fall back to the existing MD procedure. A recommendation is not execution success.
3. Retain one random UUID task ID through this task and its repair. `begin --name ... --context ... --task-id ...` reserves a script attempt and returns its ID, path and hash. It executes nothing, blocks overlapping/unresolved attempts, and allows at most two script attempts per task. Never change task IDs to bypass this limit.
4. **Inside Aside:** read the selected script with the supported file tool, verify its SHA-256 against `scriptHash`, and execute that exact async function body with a non-sensitive `input` object through the existing native REPL/JavaScript tool. Reuse a loaded function in the same session when safe. Follow current tab selection, snapshot/ref freshness and permissions. Do not start a nested `aside repl` CLI, which can lack native session authentication.
5. **External local coordinator:** `run --name ... --context ... --task-id ... --aside-account <verified-u-id> --input <scratch-json>` reserves, executes and records through the existing local Aside CLI. Do not also call `begin`. Verify the profile belongs to this task: account-root is learning storage, not browser authorization. No second MCP server or browser profile is needed.
6. Recipes validate their inputs and task-specific outputs before returning `{verified:true}`. Exit status, no exception, or a finished session does not prove success. Keep credentials, authentication, sensitive data and consequential external actions out of automatic recipes; use the original authorized domain workflow for those.
7. Native callers use `record --receipt <scratch-json>` with `{id,outcome,verified,failure,tokens,tokenSource}` (see `references/execution.md`). Record failures too. Include full task and repair usage when available; unknown is null, never zero. A failed script followed by successful MD repair remains a failed-script observation. Receipts are caller attestations.
8. After failure, inspect current state and read the existing MD Steps/Checks/Pitfalls. Try at most one targeted MD repair within the task budget. For timeout, interruption or ambiguous output, read back before retrying and resolve the original attempt; stop if its state cannot be established. Retain authentication/security checkpoints and never weaken verification or duplicate an accepted action.
9. After verified repair, improve the same managed taskType through `learn`, including corrected MD and execution recipe. Store a generalized fix, not debugging transcripts. The entire previous version remains available via `rollback`. Changed packages start unproven. Use `--probe` only for bounded authorized read-only validation; two recent successful observations enable default reuse but do not prove universal reliability. Do not run extra real work just to fill counters. `--probe --route-id <id>` can deliberately compare an alternative.

Read `references/execution.md` only when authoring, recording or repairing a recipe. Aside memory remains responsible for personal context; do not add another memory store, scheduler or background reviewer.

## Optional history onboarding

History review is off by default. Ask once whether to skip, review selected sessions, or review all eligible sessions. Only after that consent may an Aside-native adapter use `aside.sessions.list` and narrowly scoped `aside.sessions.messages` to assess eligible work. Exclude incognito, ephemeral, credential/security, financial, intimate, and unverified tasks; exclude anything whose eligibility cannot be established. Never export raw messages to this CLI or public files. Submit at most 20 redacted records per `backfill --records` call, reusing stable event identities. This is agent-guided review, not a bundled history crawler.

This lifecycle is automatic only in sessions that honor this installed bootstrap. Normal fresh root-chat global loading is unverified. Lifecycle or finished session signals do not prove success. CLI input is normalized records only: never feed raw transcripts, credentials, or provider databases.

It gains no authority to publish, send, pay, schedule, access accounts, or bypass authentication. Optional caller-verified read-only JavaScript recipes are stored with their MD as one package. No fine-tuning or code-generating service is installed.

Example record shape:

```json
{"schemaVersion":1,"eventId":"example-001","taskType":"comparison-table","outcome":"success","verified":true,"reusable":true,"privacy":"redacted","incognito":false,"evidence":{"kind":"artifact-check","summary":"Checked output."},"learning":{"name":"comparison-table","description":"Compare options consistently.","steps":["Collect sources."],"checks":["Check columns."],"pitfalls":["Do not invent sources."]}}
```
