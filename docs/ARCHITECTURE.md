# Architecture

The CLI is Node 20 ESM with no dependencies. Lifecycle/routing are local; optional execution uses the existing local Aside CLI.

- `bin/oma.mjs` invokes the bundled `skill/scripts/oma.mjs` CLI.
- `safety.mjs` provides bounded reads, atomic writes, path checks, and an inode-owned lock.
- Existing `skills.mjs` remains read-only retrieval.
- `lifecycle.mjs` validates normalized records and owns managed lifecycle state.
- `packages.mjs` validates optional read-only recipe bundles, safely reads files and computes whole-package hashes (legacy MD-only hashes remain unchanged).
- `execution.mjs` selects verified routes, reserves attempts, records sanitized outcomes, and optionally invokes Aside without a shell. Native agents use begin/record with their existing tool; they do not spawn nested Aside.
- `install.mjs` copies the public bootstrap payload and owns only its manifest/marker.

State is account-local `.oh-my-aside/registry.json`, `snapshots/`, `archives/`, audit entries, replay hashes, and an exclusive lock. Registry paths are never trusted: packages are recomputed as `skills/user/oma-<validated-slug>`. State and package symlinks are rejected.

Learn validates before state creation where practical. It hashes canonical record payloads, rejects replay mismatch, snapshots the whole package before update, atomically writes each file, then records processed events. A failed backup prevents mutation. Ordinary failures compensate changed owned files, while a pending journal blocks mutations after an interrupted or unrecoverable operation. Registry and pending payloads have a 2 MiB budget. Archive requires the exact generated file set and moves the package outside the active skill tree. Restore refuses collisions and verifies all archived files. Archived procedures must be restored before learning. Rollback restores MD, metadata and scripts together, including old MD-only snapshots.

Execution observations live in account-local `execution-state.json` (5,000 attempts / 2 MiB maximum). Evidence is scoped by whole-package hash and context. Default routing needs two recent successful observations; last-ten observed reliability precedes measured tokens per successful run. Unknown usage stays null. Begin reserves before browser calls; unresolved attempts block overlap, and the task UUID persists across a maximum of two script attempts. No account lock is held across browser execution. The external runner verifies the pinned package again before sending code. Native callers verify the returned script hash before execution.

There is no semantic merge across task types, scheduler, daemon, raw-data extractor, model-based code generator, or automatic deletion. The bootstrap owns bounded MD-based repair and resubmits only verified generalized learning. Original Aside memory, service helpers and account permissions remain their owners' responsibility.


Directly discovered managed skills link to the sibling bootstrap and carry exact execution identifiers. This closes the path where native skill selection bypassed account-level guidance or reconstructed the wrong name/context. The bootstrap can validate an unproven read-only candidate on the current requested task; receipts distinguish that evidence from default eligible reuse. No native global hook is added.
