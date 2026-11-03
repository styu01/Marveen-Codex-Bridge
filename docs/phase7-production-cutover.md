# 0.3.0 — controlled production cutover

The 0.3.0 release activates the Federation Edition without applying a Codex adapter to
the Marveen source tree.

## Safety order

1. Verify the Phase 0 recovery set, candidate commit, private Git bundle,
   fixed Node 22 runtime, Codex login, dashboard health and disabled Federation.
2. Install the standalone Bridge candidate's pinned production dependencies
   under the selected Node 22 runtime using an atomic staging directory, then
   verify the absence of legacy approvals.
3. Create a private cutover record, stop the legacy Bridge, start the candidate
   under the real hardened systemd unit, and require standalone readiness.
   On failure the legacy Bridge is restored before Marveen is touched.
4. Only after that systemd smoke test, stash the complete Marveen working tree.
5. Switch production Marveen to the already tested 1.25.1 candidate commit.
6. Preserve the old `node_modules` and `dist` directories by atomic rename,
   install clean Node 22 dependencies, typecheck, syntax-check and build into
   an absent, clean `dist` directory.
7. Restart and health-check Marveen while Federation is still disabled.
8. Pair the already-running standalone Bridge using only the public Federation
   API. Read Marveen's actual Federation `systemId`, atomically reconcile the
   Bridge peer and agent references to that identity, restart the Bridge while
   Federation is still disabled, and require readiness again.
9. Enable Federation in `advisory` mode and apply the generated main-agent
   instructions.
10. Require one exact Marveen → Codex → Marveen canary response with no
    duplicate.

## Automatic rollback

Every failure after the first mutation runs the rollback trap. If Marveen has
already been switched, the first action is the public Federation master switch
to `disabled`. A peer created by
the current attempt is removed only after its private state and token
fingerprints prove ownership. The new service is then stopped and any
cutover-time Bridge peer-identity rewrite is restored from its private
pre-reconciliation copy. If the Marveen
source was switched, the original branch and commit, the exact pre-cutover
stash, and the old `node_modules` and `dist` directories are restored before
the Claude dashboard is restarted. If the legacy Bridge had already been
stopped, it is enabled and started again and both services must pass their
health checks.

The standalone systemd unit always references the immutable release directory.
The `current` symlink remains an atomic release pointer but is never passed to
the runtime-module loader, whose symlink-traversal rejection stays enabled.
The production cutover never uses `--skip-dependencies` and never relies on a
previous release's or manually repaired `node_modules` directory.
`ProtectHome=read-only` remains active. The only additional writable home path
is the verified, non-symlink Codex state directory (`CODEX_HOME`, normally
`~/.codex`), which the Codex App Server needs for its authenticated runtime
state. Codex stderr is redacted, bounded and retained as a diagnostic tail.

The quarantined 0.2.1 adapter is deliberately not re-applied. Therefore the
rollback target is a safe Claude-only Marveen, not the old coupled architecture.
The Phase 0 archives and legacy quarantine stash remain untouched.

## Soak period

After a successful cutover, retain:

- the Phase 0 freeze;
- the private candidate bundle and checksum;
- the Phase 7 recovery record and pre-cutover stash;
- the old `node_modules` directory;
- the legacy adapter quarantine.

Do not remove these until a separate live acceptance suite and an agreed soak
period have passed.
