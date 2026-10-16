-------------------------------- MODULE JobLimit --------------------------------
(***************************************************************************)
(* `limitJobs` in apps/worker/src/evaluation/limit.ts: at most Max of a    *)
(* provider's jobs at once on one worker. A caller past the cap waits in   *)
(* arrival order; a waiting caller's abort takes it out of the queue; a    *)
(* released permit goes to the first waiter, or back to the pool.          *)
(*                                                                         *)
(* The abort listener removes its waiter with                              *)
(*   waiting.splice(waiting.indexOf(turn), 1)                              *)
(* and indexOf is -1 when the turn is not queued, which splice(-1, 1)      *)
(* reads as "remove the last element". The model applies exactly that, so  *)
(* TLC answers whether an abort can ever take another caller's turn.       *)
(*                                                                         *)
(* Steps are atomic because the code's are: `release` hands a turn over    *)
(* synchronously, and the abort event is dispatched synchronously inside   *)
(* `signal.abort()`; neither can interleave with the other mid-way.        *)
(*                                                                         *)
(* One thing the model assumes rather than shows: `turn` removes the abort *)
(* listener before it resolves, so an abort after the hand-off never       *)
(* reaches the listener. That is why Abort fires only while the caller is  *)
(* queued. Drop that removal and the splice above takes the last waiter's  *)
(* turn; apps/worker/test/evaluation-limit.test.ts pins it.                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Clients, Max

ASSUME Max >= 1

VARIABLES
  running,  \* the permit count the code keeps
  waiting,  \* the queue of turns
  pc        \* "idle" | "waiting" | "creating" | "running" | "done" | "aborted"

vars == <<running, waiting, pc>>

Range(seq) == {seq[i] : i \in 1..Len(seq)}

\* Callers that hold a permit: between acquire and release.
Holders == {c \in Clients : pc[c] \in {"creating", "running"}}

TypeOK ==
  /\ running \in 0..Cardinality(Clients)
  /\ waiting \in Seq(Clients)
  /\ pc \in [Clients -> {"idle", "waiting", "creating", "running", "done",
                         "aborted"}]

Init ==
  /\ running = 0
  /\ waiting = <<>>
  /\ pc = [c \in Clients |-> "idle"]

\* acquire(): a free permit is taken at once; otherwise the caller queues.
Acquire(c) ==
  /\ pc[c] = "idle"
  /\ IF running < Max
       THEN /\ running' = running + 1
            /\ waiting' = waiting
            /\ pc' = [pc EXCEPT ![c] = "creating"]
       ELSE /\ running' = running
            /\ waiting' = Append(waiting, c)
            /\ pc' = [pc EXCEPT ![c] = "waiting"]

\* signal.throwIfAborted() before queueing: an already-aborted caller
\* never enters the queue.
AbortBeforeQueue(c) ==
  /\ pc[c] = "idle"
  /\ pc' = [pc EXCEPT ![c] = "aborted"]
  /\ UNCHANGED <<running, waiting>>

\* JavaScript's indexOf: the position, or -1. splice(-1, 1) drops the last.
IndexOf(seq, x) ==
  IF \E i \in 1..Len(seq) : seq[i] = x
    THEN CHOOSE i \in 1..Len(seq) : seq[i] = x
    ELSE Len(seq)
Remove(seq, i) ==
  [j \in 1..(Len(seq) - 1) |-> IF j < i THEN seq[j] ELSE seq[j + 1]]

\* The abort listener of a queued caller.
Abort(c) ==
  /\ pc[c] = "waiting"
  /\ waiting' = Remove(waiting, IndexOf(waiting, c))
  /\ pc' = [pc EXCEPT ![c] = "aborted"]
  /\ UNCHANGED running

\* release(): the first waiter's turn, or one permit back.
HandOff(c, final) ==
  IF waiting = <<>>
    THEN /\ running' = running - 1
         /\ waiting' = waiting
         /\ pc' = [pc EXCEPT ![c] = final]
    ELSE /\ running' = running
         /\ waiting' = Tail(waiting)
         /\ pc' = [pc EXCEPT ![c] = final, ![Head(waiting)] = "creating"]

\* provider.create(spec) resolves: the job runs under the permit.
CreateOk(c) ==
  /\ pc[c] = "creating"
  /\ pc' = [pc EXCEPT ![c] = "running"]
  /\ UNCHANGED <<running, waiting>>

\* provider.create(spec) throws: the permit is released in the catch.
CreateFail(c) ==
  /\ pc[c] = "creating"
  /\ HandOff(c, "done")

\* job.destroy(): the permit is released once, however destroy ends.
Destroy(c) ==
  /\ pc[c] = "running"
  /\ HandOff(c, "done")

Next ==
  \E c \in Clients :
    \/ Acquire(c) \/ AbortBeforeQueue(c) \/ Abort(c)
    \/ CreateOk(c) \/ CreateFail(c) \/ Destroy(c)

\* Every job is eventually created or fails to be, and every created job is
\* eventually destroyed: the liveness assumption the limiter rests on.
Spec ==
  /\ Init /\ [][Next]_vars
  /\ \A c \in Clients :
       /\ WF_vars(CreateOk(c) \/ CreateFail(c))
       /\ WF_vars(Destroy(c))

-----------------------------------------------------------------------------

\* Never more than Max jobs at once.
RunningBounded == running <= Max

\* The count is exactly the permits held: none leaks, none is double-freed.
PermitsAccounted == running = Cardinality(Holders)

\* No one waits while a permit is free.
NoIdlePermitWhileWaiting == waiting # <<>> => running = Max

\* The queue holds exactly the waiting callers, once each: an abort never
\* takes another caller's turn, and a hand-off never goes to a caller that
\* left.
QueueIsTheWaiters ==
  /\ \A c \in Clients : pc[c] = "waiting" <=> c \in Range(waiting)
  /\ \A i, j \in 1..Len(waiting) : waiting[i] = waiting[j] => i = j

\* Every waiter gets its turn or aborts.
WaitersServed ==
  \A c \in Clients : pc[c] = "waiting" ~> pc[c] \in {"creating", "aborted"}

=============================================================================
