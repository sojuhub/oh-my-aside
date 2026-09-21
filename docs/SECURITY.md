# Security and threat model

## Assets and trust boundaries

The account root, AGENTS file, managed skills, and local lifecycle state are local assets. Normalized records are caller attestations: `verified` and evidence do not independently prove an external result. The tool is not a sandbox and cannot secure arbitrary caller code.

## Controls

- Explicit existing account root for mutations; no active-account guessing.
- Managed paths only, validated names, no traversal, no symlink escapes.
- Fail-closed unmanaged conflicts and hash drift.
- Exclusive lock, atomic writes, snapshot-before-change, archive-before-removal.
- Replay stores hashes, not raw event records or transcripts.
- Heuristic rejection of common secret, private-path, email, and auth-bypass patterns; errors do not echo input.
- Installer manifest and marker ownership checks; uninstall preserves user changes.

## Known gaps

Optional JavaScript recipes are trusted caller-authored code, not untrusted executable uploads. Syntax compilation never invokes the code locally. `effect: read-only` and the secret scanner are not a sandbox or proof of behavior. A trusted agent must validate inputs and outputs, keep sensitive/authentication/external-write operations in the original domain workflow, and honor current host permissions. Native execution retains Aside's tool boundary. The external adapter invokes a local Aside account explicitly, without a shell, and does not echo or persist raw child output. Pass no credentials or sensitive data in runtime inputs; they are passed to the local process in memory/arguments.

Execution receipts attest checks; a hostile caller can lie about verification or usage. Unknown outcomes block retries until actual readback; timeout does not prove the remote browser action was cancelled. The task attempt budget cannot limit a caller that invents new task IDs or uses other tools. Do not claim autonomous correctness, universal bootstrap loading, or a hard provider spending cap.

Heuristics can miss sensitive content or false-positive. Local filesystem permissions and a compromised caller are outside this tool's protection. Snapshot data contains generated, sanitized procedure text. Do not submit material that should not be locally stored. No claim is made that lifecycle events mean success, that bootstrap loads globally, or that records prove a real-world action.

Report vulnerabilities privately through the repository security contact when configured; do not include secrets in reports.
