# Changelog

## Unreleased

- Fix direct managed-skill selection bypassing the coordinator and guessed route identifiers; record bounded fresh-chat verification.

- Added optional verified Aside JavaScript recipes with whole-package hashes, snapshots, archive/restore and rollback, retaining MD-only compatibility.
- Added route selection, persisted attempt reservations and receipts, conservative retry limits, and an external Aside CLI adapter without another browser or MCP server.
- Added bootstrap guidance for existing-skill-first discovery, bounded MD recovery and verified recipe improvement; preserved Aside memory and original skills.
- Added execution/lifecycle regression checks and a Hermes/Aside workflow review.
- Fixed installed CLI detection through macOS symlinked temporary paths.

## 0.1.0-alpha.1

- Added explicit-root local install, managed Markdown learning, replay protection, snapshots, rollback, archive preview/apply, restore, pinning, and hash-aware drift protection.
- Added normalized-record validation and documented bootstrap-dependent automation boundary.
- Added isolated Node fixture tests and release/security documentation.

Limitations: alpha supports one generated Markdown file per managed package, exact task-type deduplication only, heuristic privacy screening, and no global completion hook, scheduler, external action, raw transcript ingestion, executable generation, or semantic consolidation.
