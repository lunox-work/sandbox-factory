------------------------------- MODULE RunLease -------------------------------
(***************************************************************************)
(* One analysis run between the workers that claim it and the watchdog     *)
(* that fails expired leases, as `packages/db/src/analysis-runs.ts` and    *)
(* `apps/api/src/analysis/watchdog.ts` implement them. `bounty-runs.ts`    *)
(* follows the same protocol.                                              *)
(*                                                                         *)
(*   claim        queued -> running, a fresh token, a lease and a deadline *)
(*   heartbeat    fenced; extends the lease while the deadline holds       *)
(*   write        recordProgress / recordPreview / finish; fenced          *)
(*   release      fenced but not deadline-checked; the run goes back       *)
(*   fail         the worker reports its own failure; fenced but not       *)
(*                deadline-checked; final whatever the attempt             *)
(*   failExpired  the watchdog: running and past its lease or deadline     *)
(*                -> queued while attempts remain, else failed             *)
(*                                                                         *)
(* The fence every guarded statement carries is                            *)
(*   status = 'running' /\ lease_token = token /\ lease_expires_at > now   *)
(* where `now` is the clock of the worker making the call, while the       *)
(* watchdog reads the API's clock. Worker clocks may be off by up to Skew. *)
(*                                                                         *)
(* Checked with RunLease.cfg: see docs/specs/README.md.                    *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
  Workers,      \* worker identities
  Lease,        \* lease length (60 s in the code)
  Deadline,     \* deadline_at - started_at (params.deadlineMinutes)
  MaxAttempts,
  Skew,         \* each worker's clock is at most this far from the API's
  MaxClaims,    \* bound on claims, for a finite state space
  MaxTime       \* bound on the clock, for a finite state space

ASSUME Lease > 0 /\ Deadline > 0 /\ MaxAttempts > 0 /\ Skew >= 0

VARIABLES
  time,         \* the API's clock, which the watchdog reads
  skew,         \* each worker's clock offset from it, fixed per behaviour
  status,       \* "queued" | "running" | "succeeded" | "failed"
  token,        \* lease_token: 0 while none, else the epoch of the claim
  leaseExpires, \* lease_expires_at
  deadline,     \* deadline_at
  attempt,
  epoch,        \* claims made so far; each claim's token is unique
  held,         \* the token each worker's execution carries, 0 for none
  pc,           \* "idle" | "executing" | "crashed"
  writes        \* <<worker, token carried, epoch at the time>> per write

vars == <<time, skew, status, token, leaseExpires, deadline, attempt, epoch,
          held, pc, writes>>

Statuses == {"queued", "running", "succeeded", "failed"}

Now(w) == time + skew[w]

\* The SQL fence (`fence` in analysis-runs.ts).
Fence(w) == status = "running" /\ token = held[w] /\ leaseExpires > Now(w)
\* heartbeat, recordProgress, recordPreview and finish also need the deadline.
Guarded(w) == Fence(w) /\ deadline > Now(w)

TypeOK ==
  /\ time \in 0..MaxTime
  /\ skew \in [Workers -> (0 - Skew)..Skew]
  /\ status \in Statuses
  /\ token \in Nat
  /\ attempt \in 0..MaxAttempts
  /\ epoch \in 0..MaxClaims
  /\ held \in [Workers -> Nat]
  /\ pc \in [Workers -> {"idle", "executing", "crashed"}]

Init ==
  /\ time = 0
  /\ skew \in [Workers -> (0 - Skew)..Skew]
  /\ status = "queued"
  /\ token = 0
  /\ leaseExpires = 0
  /\ deadline = 0
  /\ attempt = 0
  /\ epoch = 0
  /\ held = [w \in Workers |-> 0]
  /\ pc = [w \in Workers |-> "idle"]
  /\ writes = {}

(***************************************************************************)
(* `claim`: one UPDATE ... WHERE status = 'queued' ... FOR UPDATE SKIP     *)
(* LOCKED, so it is atomic. The lease and the deadline are set from the    *)
(* worker's clock. Claims stop early enough that every deadline falls      *)
(* inside the bounded clock, so the watchdog gets its turn in every        *)
(* behaviour.                                                              *)
(***************************************************************************)
Claim(w) ==
  /\ pc[w] = "idle"
  /\ status = "queued"
  /\ epoch < MaxClaims
  /\ Now(w) + Deadline <= MaxTime
  /\ epoch' = epoch + 1
  /\ token' = epoch'
  /\ status' = "running"
  /\ leaseExpires' = Now(w) + Lease
  /\ deadline' = Now(w) + Deadline
  /\ held' = [held EXCEPT ![w] = epoch']
  /\ pc' = [pc EXCEPT ![w] = "executing"]
  /\ UNCHANGED <<time, skew, attempt, writes>>

Heartbeat(w) ==
  /\ pc[w] = "executing"
  /\ Guarded(w)
  /\ leaseExpires' = Now(w) + Lease
  /\ UNCHANGED <<time, skew, status, token, deadline, attempt, epoch, held,
                 pc, writes>>

\* recordProgress / recordPreview: the row is written when the guard holds.
Write(w) ==
  /\ pc[w] = "executing"
  /\ Guarded(w)
  /\ writes' = writes \cup {<<w, held[w], epoch>>}
  /\ UNCHANGED <<time, skew, status, token, leaseExpires, deadline, attempt,
                 epoch, held, pc>>

Finish(w) ==
  /\ pc[w] = "executing"
  /\ Guarded(w)
  /\ status' = "succeeded"
  /\ token' = 0
  /\ writes' = writes \cup {<<w, held[w], epoch>>}
  /\ held' = [held EXCEPT ![w] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<time, skew, leaseExpires, deadline, attempt, epoch>>

\* `release`: fenced but not deadline-checked; the run goes back to the queue.
Release(w) ==
  /\ pc[w] = "executing"
  /\ Fence(w)
  /\ status' = "queued"
  /\ token' = 0
  /\ held' = [held EXCEPT ![w] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<time, skew, leaseExpires, deadline, attempt, epoch, writes>>

\* `fail`: the worker gives up on the run itself. Fenced only, like
\* release, and final: the watchdog never requeues a failed run, so the
\* attempts left do not matter.
Fail(w) ==
  /\ pc[w] = "executing"
  /\ Fence(w)
  /\ status' = "failed"
  /\ token' = 0
  /\ writes' = writes \cup {<<w, held[w], epoch>>}
  /\ held' = [held EXCEPT ![w] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<time, skew, leaseExpires, deadline, attempt, epoch>>

\* A guarded statement matched no row: the worker learns its lease is gone
\* and stops executing the run.
Fenced(w) ==
  /\ pc[w] = "executing"
  /\ ~Guarded(w)
  /\ held' = [held EXCEPT ![w] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<time, skew, status, token, leaseExpires, deadline, attempt,
                 epoch, writes>>

\* The process dies mid-run, and later comes back as an idle worker.
Crash(w) ==
  /\ pc[w] = "executing"
  /\ pc' = [pc EXCEPT ![w] = "crashed"]
  /\ UNCHANGED <<time, skew, status, token, leaseExpires, deadline, attempt,
                 epoch, held, writes>>

Restart(w) ==
  /\ pc[w] = "crashed"
  /\ held' = [held EXCEPT ![w] = 0]
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<time, skew, status, token, leaseExpires, deadline, attempt,
                 epoch, writes>>

\* `failExpired`, on the API's clock. One UPDATE whose WHERE re-reads the
\* expiry, so a heartbeat that lands first makes it a no-op.
FailExpired ==
  /\ status = "running"
  /\ leaseExpires <= time \/ deadline <= time
  /\ IF attempt < MaxAttempts
       THEN status' = "queued" /\ attempt' = attempt + 1
       ELSE status' = "failed" /\ attempt' = attempt
  /\ token' = 0
  /\ UNCHANGED <<time, skew, leaseExpires, deadline, epoch, held, pc, writes>>

Tick ==
  /\ time < MaxTime
  /\ time' = time + 1
  /\ UNCHANGED <<skew, status, token, leaseExpires, deadline, attempt, epoch,
                 held, pc, writes>>

Next ==
  \/ \E w \in Workers :
       \/ Claim(w) \/ Heartbeat(w) \/ Write(w) \/ Finish(w) \/ Release(w)
       \/ Fail(w) \/ Fenced(w) \/ Crash(w) \/ Restart(w)
  \/ FailExpired
  \/ Tick

\* Time passes and the watchdog sweeps; nothing else is assumed of anyone.
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ WF_vars(FailExpired)

-----------------------------------------------------------------------------
(* What the fence guarantees. *)

\* A running run has a token; a queued, finished or failed one has none.
TokenMatchesStatus == (status = "running") <=> (token # 0)

\* No two workers pass the fence at once, whatever their clocks say.
FenceExclusive == Cardinality({w \in Workers : Fence(w)}) <= 1

\* Every write that landed carried the token of the claim in force when
\* it landed: a worker whose run was requeued and claimed again never
\* writes over the new holder's run. Remove `token = held[w]` from the
\* fence and TLC produces the trace.
NoStaleWrite == \A x \in writes : x[2] = x[3]

\* Once ended, always ended: no late write reopens a succeeded or failed
\* run, and the watchdog never requeues one.
EndedIsFinal ==
  [][(status \in {"succeeded", "failed"}) => status' = status]_vars

\* Only the watchdog retries, and it gives up exactly at the last attempt.
\* A worker's own `fail` is final whatever the attempt, so this is a claim
\* about the watchdog's step, not about every failed run.
WatchdogGivesUpLast ==
  [][FailExpired /\ status' = "failed" => attempt' = MaxAttempts]_vars

\* A crashed holder's run is taken back by the watchdog, within the
\* deadline it was claimed with.
CrashedHolderIsReclaimed ==
  \A w \in Workers :
    (pc[w] = "crashed" /\ status = "running" /\ token = held[w])
      ~> (status # "running" \/ token # held[w])

(***************************************************************************)
(* What the fence does NOT guarantee, and the rest of the system relies    *)
(* on: two workers may both be executing the same run, each believing it   *)
(* holds the lease, until the stale one's next guarded statement fails.    *)
(* Only the fenced writes are exclusive. A worker's side effects outside   *)
(* the database must be keyed by its token, as `logs/<run>/<token>.log`    *)
(* is. TLC shows the trace with RunLease_Exclusive.cfg.                    *)
(***************************************************************************)
ExecutionExclusive ==
  Cardinality({w \in Workers : pc[w] = "executing" /\ held[w] # 0}) <= 1

=============================================================================
