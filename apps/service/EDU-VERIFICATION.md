# Short pronunciation verification in the execution service

The default guest environment remains `EDU_AI_ENABLED=0`. This optional bridge
only enables pronunciation for one frozen edu instance, for 300 seconds and at
most two provider dispatches. Scoring, submission idempotence, lexical/miscue
normalization and qualification transactions remain the edu backend's authority.
This module adds no production HTTP endpoint.

## Service API

- `app.verification.begin`: `{workspaceId,projectId,appInstanceId,sourceSha256}`.
  The instance/digest are the caller's current frozen view. Admission locks
  synchronously. After cancellation/drain, actual guest source is exported and
  checked again before the original instance is stopped. The leased process has
  a **new** instance UUID.
- `app.verification.status` and `.end`:
  `{workspaceId,projectId,appInstanceId,sessionId}`, identifying that leased
  instance/session. Wrong or old identity is rejected.
- `edu-verification-event` and RPC responses carry `{lease,phase,callsUsed,
maintenanceLocked,error}`. Events start during preparation, supplying the new
  leased identity before begin finishes.

Phases are `preparing`, `active`, `revoking`, `restoring`, `revoked`, `ended`,
`failed`. End aborts and drains SSH, closes leased stdin, confirms app process and
mapping cleanup, checks the old URL refuses/closes the connection, and starts a
new default instance with matching source and identity health. Only then does
maintenance unlock. Timeout is not proof of URL closure. `app.stop` instead
reaches `revoked`, leaves the app stopped and maintenance locked; a subsequent
explicit verification end restores default mode. Desktop/service shutdown only
revokes and cleans up, without restarting an app.

Configuration or initial instance/source rejection does not stop any project and
releases this admission lock. Once application ownership is taken, failures
attempt owned cleanup and retain the lock if confirmation fails. A coding or
terminal drain failure retains the lock without treating an unrelated app as
owned. Such failure requires reconciliation; it is not successful acceptance.

The global gate covers personal/legacy coding sends, terminal open/write,
create/import/start, edu candidate prepare/apply and mutating app-agent requests.
Admission epochs revoke requests queued before the lease even after it ends.
Read queries and cancellation remain available. Active coding and terminal owners
are drained before source freeze. AppService's existing guest PID/start-time and
port ownership receipts remain the cleanup authority; issuing close alone is
insufficient.

## Durable recovery

The private service-root `edu-verification-recovery.json` is the recovery authority;
Main's marker only displays a failure until the service confirms recovery. Presence
locks admission synchronously, before asynchronous reads or incoming mutations.
Malformed, linked, nonregular, oversized, foreign-owner or public-mode journals
keep the gate locked and report `verification_journal_invalid` in initialization.
Updates use a private temporary file, file fsync, atomic rename and directory
fsync. Parent directories must belong to the service user and not be writable by
others. A completed marker is persisted before unlocking.

`app.verification.reconcile` takes the same target as status/end, solely to match
that private journal. It accepts no renderer URLs, process IDs or source facts.
Recovery never enables scoring or renews a lease. It drains maintenance owners,
checks the registry belongs to the original/leased/pre-reserved restoration
instance and frozen source, re-reads actual source, then obtains owned cleanup.
A fresh default UUID is journaled before start; all restoration UUIDs and observed
URLs remain in bounded append-only histories, including a default started before
its response was delivered. Repeating completed recovery while the exact restored
instance is healthy does not start again. If that same persisted instance stopped
before Main confirmed completion, explicit recovery can restore another fresh
AI0 instance. A different current instance is rejected without stopping it.
Completed journals load only into internal idempotence state; startup does not
replay their events or create a recovery UI after normal shutdown.

`app.verification.recoverAdmission` takes the original strict begin payload from
Main's frozen marker when service dispatch never produced a lease target. Its
separate `edu-admission-recovery-event` and RPC result contain
`{schemaVersion:1,kind:"admission-recovery",recoveryId,originalIdentity,sourceSha256,
phase,restoredIdentity,maintenanceLocked,error}`. It never creates or renews a
pronunciation lease, loads provider configuration, or dispatches a provider.
An unfinished verification or concurrent begin rejects admission recovery.

Only the original v3 identity/source plus actual source can admit a new recovery.
Before stop, an `admissionOnly:true` record and reserved restoration UUID are
fsynced to the same journal. After drain, identity/source are checked again;
owned stop, all old URL closure checks and a new default instance must succeed.
The `restoring` event supplies its already persisted `restoredIdentity` before
start. Interrupted recovery accepts only the original or recorded reserved
instance. Restored identities must belong to the original workspace/project,
differ from the original instance and appear in the reserved UUID history.
Repeated ended recovery checks that exact default identity/source is still
running; a newer unrelated instance is rejected without stopping it.

A begin failure after journal publication but before ownership stays `failed`
and locked. The existing target-based reconcile then performs explicit fresh
AI0 restoration. It does not report the untouched original as `ended`.
Journal loading never releases a pending admission recovery's gate, even when
it reads an older completed record. Completed records unlock only after service
initialization or the owning recovery operation confirms its terminal state.
An already completed admission marker follows the same healthy-versus-stopped
reserved-instance rule as verification reconciliation.

App registry v3 records last instance/source, an intended publication, committed
mapping tuple and removal intent. v1/v2 registries remain readable but do not
invent missing process ownership. A missing publish acknowledgement, changed
mapping, rebooted VM or lost helper without a final durable receipt remains
unconfirmed. A persisted removal intent plus an absent mapping is distinct from
an unexplained missing mapping and can be completed idempotently.

Only edu starts create a private guest receipt before sending startup input. It
binds boot ID, instance/source, helper and leader PID/start ticks, observed child
identities and final cleanup. A new service asks the same original helper to
revoke through a narrow private control file, waits for its durable cleanup and
exact process identities to disappear, and keeps its own guest connection alive
while removing the committed mapping. It never kills by cwd/project name. A dead
host's broken stdout cannot suppress that durable cleanup. Standard template and
ordinary Codex stdin behavior remain unchanged.

The same owned adapter is available through ordinary `app.stop` after default-AI0
edu execution lost its process handle. The v3 instance/source and actual source
must match, and its receipt must prove ownership. Standard-template stop is not
extended to infer an owner.

Unconfirmed recovery requires review of the preserved service journal, v3 registry,
guest receipt/boot ID/PID-start ticks, complete process cleanup, source digest and
exact original mapping/publication acknowledgement. Preserve old URLs through
retries; timeout is not closed-port evidence. If a publication acknowledgement or
final ownership proof is missing, the current implementation provides no manual
"trust this port/PID" override. Keep the failed run and resolve the missing facts
or use a separately approved isolated run; do not rewrite a receipt to manufacture
confirmation.

The cutpoint tests use real private journal/registry files and injected process or
mapping adapters. The Python receipt test simulates `/proc` identities. They prove
ordering and failure behavior, not real service/desktop/guest strong-exit recovery.

## Private host configuration

`WSL_EDU_PROVIDER_CONFIG` must point to an absolute, single-link regular JSON file
owned by the service user and not writable by group/others. It is not accepted
from renderer/workspace request payloads. Strict fields:

```json
{
  "schemaVersion": 1,
  "host": "provider.example.invalid",
  "user": "provider",
  "identityFile": "/private/provider-key",
  "hostKeyAlias": "provider-pinned",
  "knownHostsFile": "/private/provider-known-hosts",
  "pythonExecutable": "/immutable/version/.venv/bin/python",
  "providerPath": "/immutable/version/deploy/provider.py",
  "bindInterface": "interface0"
}
```

`bindInterface` is optional. No arbitrary arguments, shell fragments, URLs or
credential fields are accepted. `/usr/bin/ssh -F /dev/null` uses fixed strict host
checking, identity-only and noninteractive options, disables agent forwarding,
proxies/local commands and TTY, and executes only quoted absolute Python `-B`
plus the fixed script. The trusted installation must pin immutable code and
credentials remotely. Public source contains no deployment address or secret.

## Framing and disclosure

The helper initially consumes one bounded JSON line. Duplex mode is explicit;
ordinary Codex input still closes after its prompt. The guest's dedicated
`WSL_EDU_ASSESSMENT_REQUEST:` line is intercepted before any ordinary logging,
with its own 1,500,000-byte budget. Normal readiness budgets remain 65,536 bytes.
Leased stdout/stderr never enters app logs. Once ready, unknown stdout fails
closed. Pre-ready build output is discarded; source/ready receipts are checked.

Request validation checks strict fields, UUIDs, full frozen identity/source,
request replay, canonical base64, WAV format/duration and decoded audio SHA256.
The SSH child receives exactly one JSON line followed by EOF; guest response
stdin remains open through both calls. Provider stdout is bounded to 65,536
bytes, its exit code must match success/failure, and response association,
structure, finite scores and score=accuracy are checked. The guest rechecks the
same Python normalizer and lease/channel inside its local authorization
transaction. Provider stderr is drained without retaining even a tail. Errors
publish only fixed safe codes. Raw WAV/base64, provider exception text and
credentials must never be copied into evidence.

## Offline verification

`pnpm exec vitest run apps/service/src/edu-verification.test.ts
apps/service/src/app-service.test.ts apps/service/src/index.test.ts` exercises
framing, real local Python child boundaries, cancellation/late results, budgets,
configuration, maintenance admission and stdout disclosure. These checks do not
execute SSH, sbx, Azure, physical audio, a packaged app or user acceptance.
