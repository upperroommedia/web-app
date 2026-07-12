# Callable Contracts

The Callable Contracts context defines typed commands and results exchanged across the web app, Firebase functions, process-audio queues, and browser fallback.

## Language

**Callable Contract**:
The typed input and output shape for a Firebase callable workflow.
_Avoid_: API type, endpoint schema

**Publish Command**:
A callable contract that asks Firebase functions to create, update, delete, or reorder external publishing state.
_Avoid_: Request payload, mutation payload

**Publish Result**:
The callable result describing whether a publish command succeeded, partially succeeded, or failed.
_Avoid_: Response, return type

**Process Audio Command**:
The contract for enqueueing or executing process-audio work for a sermon.
_Avoid_: Audio payload, task payload

**Process Audio Queue State**:
The contract describing queued, running, deferred, and blocked process-audio requests.
_Avoid_: Queue metadata

**Browser Fallback Request**:
The contract sent to the browser fallback when YouTube direct extraction needs browser-assisted resolution.
_Avoid_: Fallback payload

**Remote State Snapshot**:
The contract result that describes current external state, such as a Subsplash list overflow chain or series membership.
_Avoid_: Remote response

**Drift Report**:
The contract result that identifies mismatches between local state and remote published state.
_Avoid_: Sync report, diff

**Role Request Contract**:
The contract shape for asking to grant, accept, deny, or list user role requests.
_Avoid_: Permission request payload

**Speaker Request Contract**:
The contract shape for creating, accepting, denying, or listing requested speaker records.
_Avoid_: Speaker submission payload
