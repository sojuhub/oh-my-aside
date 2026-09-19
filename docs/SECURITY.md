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

Heuristics can miss sensitive content or false-positive. Local filesystem permissions and a compromised caller are outside this tool's protection. Snapshot data contains generated, sanitized procedure text. Do not submit material that should not be locally stored. No claim is made that lifecycle events mean success, that bootstrap loads globally, or that records prove a real-world action.

Report vulnerabilities privately through the repository security contact when configured; do not include secrets in reports.
