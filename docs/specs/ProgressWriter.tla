----------------------------- MODULE ProgressWriter -----------------------------
(***************************************************************************)
(* `progressRecorder` in apps/worker/src/progress.ts: steps arrive while   *)
(* an agent works; one write to the run is out at a time; steps that       *)
(* arrive during a write are carried by the next; a write that fails is    *)
(* let go, and the next step tries again.                                  *)
(*                                                                         *)
(*   step()   records the step, then flush(): start a write when none is   *)
(*            out, otherwise mark the one out as stale (`dirty`)           *)
(*   flush    do { dirty = false; snapshot; await write } while (dirty)    *)
(*                                                                         *)
(* The snapshot is taken in the same synchronous turn that clears `dirty`, *)
(* so no step can fall between them; the model keeps that atomicity.       *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS MaxSteps

VARIABLES
  steps,      \* steps recorded so far
  writing,    \* a write is out
  dirty,      \* a step arrived while it was
  inFlight,   \* the step count the write out carries
  written,    \* the step count the last successful write carried
  lastFailed  \* the last write to resolve failed

vars == <<steps, writing, dirty, inFlight, written, lastFailed>>

TypeOK ==
  /\ steps \in 0..MaxSteps
  /\ writing \in BOOLEAN
  /\ dirty \in BOOLEAN
  /\ inFlight \in 0..MaxSteps
  /\ written \in 0..MaxSteps
  /\ lastFailed \in BOOLEAN

Init ==
  /\ steps = 0
  /\ writing = FALSE
  /\ dirty = FALSE
  /\ inFlight = 0
  /\ written = 0
  /\ lastFailed = FALSE

Step ==
  /\ steps < MaxSteps
  /\ steps' = steps + 1
  /\ IF writing
       THEN dirty' = TRUE /\ UNCHANGED <<writing, inFlight>>
       ELSE writing' = TRUE /\ dirty' = FALSE /\ inFlight' = steps'
  /\ UNCHANGED <<written, lastFailed>>

\* The write out resolves, well or badly. While dirty, the loop goes round
\* again with a fresh snapshot; otherwise the recorder is settled.
Resolve(ok) ==
  /\ writing
  /\ written' = IF ok THEN inFlight ELSE written
  /\ lastFailed' = ~ok
  /\ IF dirty
       THEN dirty' = FALSE /\ inFlight' = steps /\ writing' = TRUE
       ELSE writing' = FALSE /\ UNCHANGED <<dirty, inFlight>>
  /\ UNCHANGED steps

Next == Step \/ Resolve(TRUE) \/ Resolve(FALSE)

\* Every write resolves one way or the other.
Spec == Init /\ [][Next]_vars /\ WF_vars(Resolve(TRUE) \/ Resolve(FALSE))

-----------------------------------------------------------------------------

\* When nothing is out, the run holds every step recorded, unless the last
\* write failed, which the code lets go until the next step.
SettledIsCurrent == ~writing => (written = steps \/ lastFailed)

\* A write that is out and not stale carries every step recorded so far;
\* one that is stale will be followed by one that does.
InFlightCovers == writing => (inFlight <= steps /\ (~dirty => inFlight = steps))

\* The run never goes backwards.
WrittenMonotone == [][written' >= written]_vars

\* settled() resolves: the loop ends once steps stop arriving.
WritesSettle == writing ~> ~writing

=============================================================================
