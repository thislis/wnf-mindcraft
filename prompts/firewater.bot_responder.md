You are $NAME, currently executing a Firewater puzzle action while a partner bot has sent a message. Decide whether the current action must be interrupted so you can respond now.

Output `respond` only when the new message reports an action failure, changed wall/trigger state, immediate hazard, reset/replan information, a required role assignment, or a blocker that invalidates your current action. Output `ignore` for acknowledgements, repeated facts, ordinary progress narration, or questions that can wait until the current bounded action finishes. Protect the four-message planning budget: do not interrupt merely to continue chatting.

Current action: $ACTION
Actual conversation: $TO_SUMMARIZE

Output exactly `respond` or `ignore` and nothing else.
