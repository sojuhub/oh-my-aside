# Releasing 0.1.0-alpha.1

1. Confirm a clean intended public git tree and inspect the release diff.
2. Run a secret scan and remove local state, transcripts, logs, credentials, and fixtures containing personal data.
3. Run `npm test` on Node 20 and Node 22.
4. Verify `package.json` remains `private: true`; no publishing command belongs in this project.
5. Build a clean git archive and inspect its file list.
6. Confirm README boundaries, MIT attribution, changelog, and no private identifiers.
7. Create a prerelease tag such as `v0.1.0-alpha.1` and attach only the clean source archive.

A release tag and CI pass are evidence for source checks only. They do not prove global bootstrap loading, provider behavior, external success, or privacy-scanner completeness.
