---
name: oh-my-aside
description: "Discover and reuse current skills for repeated or nontrivial work, then learn verified reusable procedures and maintain only Oh My Aside-owned skills. No skill-management request is needed."
---

# Oh My Aside bootstrap

## Resolve the installed CLI

Use `node "<skill-directory>/scripts/oma.mjs" COMMAND --account-root "<account-root>"`. Do not assume a global `oma` executable or a populated environment variable. The installed skill directory is `skills/user/oh-my-aside` under the account root supplied by Aside. Verify that root; never guess a different account.

## Before work

1. Run `search --query "task terms"` against current metadata. If there is no lexical match, try synonyms or page `catalog --limit 20 --offset 0`; a lexical miss does not prove no useful skill exists. Check `status` for clearly relevant archived managed skills. If one is needed, run `restore --name "<managed name>"`, then discover and hash-load it normally.
2. Read selected skills with `load --path "<catalog path>" --expected-hash "<catalog sha256>"`. On mismatch, catalog again and read the new content. Never reuse an old body merely because its name is unchanged.
3. Apply relevant instructions under the user's existing permissions. Pass this coordinator path and any selected paths to child workers; do not assume inheritance. Loading is not proof of application or success.

## After verified work

1. Briefly assess whether the successful task produced a nontrivial, reusable procedure. Skip failed, unverified, low-value, incognito, credential-handling, sensitive, or one-off personal tasks. This is not a reason to retain private facts.
2. Run `status` to find an existing managed `taskType`. Reuse that exact identity when refining the same procedure; do not create near-duplicate names. If it is archived, run and verify `restore --name "<managed name>"` before `learn`. Do not work around `restore-required` by inventing a different identity.
3. Abstract inputs into placeholders. Store only general steps, checks, and pitfalls, never conversation text, personal facts, account identifiers, secrets, external message bodies, or permission-expanding instructions. The evidence field is a short caller attestation, not an independently verified receipt.
4. Write the normalized record below to task scratch. Use a stable nonprivate event identifier and preserve it on retries. Run `learn --record "<scratch record>"`, then `maintain --apply`. Read each result before claiming success. Under the installed managed-only policy, do not ask the user to approve each skill or routine archive.
5. On a conflict, manual drift, pending recovery, or rejection, leave the protected files untouched. Report only actionable blockers, not rejected text. Remove the scratch record when the task's normal scratch cleanup runs.

## Optional history onboarding

History review is off by default. Ask once whether to skip, review selected sessions, or review all eligible sessions. Only after that consent may an Aside-native adapter use `aside.sessions.list` and narrowly scoped `aside.sessions.messages` to assess eligible work. Exclude incognito, ephemeral, credential/security, financial, intimate, and unverified tasks; exclude anything whose eligibility cannot be established. Never export raw messages to this CLI or public files. Submit at most 20 redacted records per `backfill --records` call, reusing stable event identities. This is agent-guided review, not a bundled history crawler.

This lifecycle is automatic only in sessions that honor this installed bootstrap. Normal fresh root-chat global loading is unverified. Lifecycle or finished session signals do not prove success. CLI input is normalized records only: never feed raw transcripts, credentials, or provider databases.

It gains no authority to publish, send, pay, schedule, access accounts, or bypass authentication. It writes Markdown procedures only; alpha does not create executable scripts or fine-tune models.

Example record shape:

```json
{"schemaVersion":1,"eventId":"example-001","taskType":"comparison-table","outcome":"success","verified":true,"reusable":true,"privacy":"redacted","incognito":false,"evidence":{"kind":"artifact-check","summary":"Checked output."},"learning":{"name":"comparison-table","description":"Compare options consistently.","steps":["Collect sources."],"checks":["Check columns."],"pitfalls":["Do not invent sources."]}}
```
