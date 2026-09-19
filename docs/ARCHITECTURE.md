# Architecture

The CLI is Node 20 ESM with no dependencies and no external calls.

- `bin/oma.mjs` invokes the bundled `skill/scripts/oma.mjs` CLI.
- `safety.mjs` provides bounded reads, atomic writes, path checks, and an inode-owned lock.
- Existing `skills.mjs` remains read-only retrieval.
- `lifecycle.mjs` validates normalized records and owns managed lifecycle state.
- `install.mjs` copies the public bootstrap payload and owns only its manifest/marker.

State is account-local `.oh-my-aside/registry.json`, `snapshots/`, `archives/`, audit entries, replay hashes, and an exclusive lock. Registry paths are never trusted: packages are recomputed as `skills/user/oma-<validated-slug>`. State and package symlinks are rejected.

Learn validates before state creation where practical. It hashes canonical record payloads, rejects replay mismatch, snapshots existing content before update, atomically writes, then records processed events. A failed backup prevents mutation. Ordinary failures compensate changed owned files, while a pending journal blocks new mutations after an interrupted or unrecoverable operation. Registry and pending payloads have a 2 MiB write/read budget. Archive is deterministic age-based curation with preview first. It requires exactly one generated file and moves packages outside the active skill tree. Restore refuses a collision and verifies archived content before moving it. Archived procedures must be restored before a new learn event; the coordinator performs these as separate transactions. Rollback snapshots current content before restoring the previous content snapshot.

There is deliberately no semantic merge across different task types, scheduler, daemon, raw-data extractor, executable generation, or automatic deletion.
