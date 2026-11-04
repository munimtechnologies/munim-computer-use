# Textarea click stalls a task queue: issue 52

Source report: https://github.com/munimtechnologies/munim-computer-use/issues/52.
Related, separate native-input report:
https://github.com/munimtechnologies/munim-computer-use/issues/47.

## Evidence and causal branches

On Windows/Chrome, an independent agent tab on Chad Aeschliman's profile
reproduced the sequence: Connect returned a three-control modal; Add a note
returned the textarea; clicking textarea index 1 timed out waiting for the
extension. No typing or Send action followed in that reproduction.

- Modal discovery: ruled out at the failing transition. Both modal snapshots
  were correctly scoped, unlike the original issue 46.
- Extension/native-host disconnection: ruled out as the explanation for the
  subsequent task-wide outage. While the click remained pending, another
  session's `browser_list_tabs` responded and the bridge-owner record reported
  the extension connected, with five host connections.
- Task serialization: confirmed liveness defect. `enqueue` chained later
  commands behind the unresolved action promise. `send` awaited Chrome's
  debugger request without a deadline; the native caller's timeout only removed
  its response waiter. It did not reject the extension's pending await. Thus
  subsequent commands in that task could remain blocked indefinitely.
- Initial Chrome stall: not established to a particular request or site handler.
  The original worker had no per-click-stage diagnostics. A controlled ordinary
  shadow-root textarea did not reproduce the stall. It would be incorrect to
  claim that shadow DOM, focus handling, or Windows native injection caused it.
- Issue 47: a separate `type_text`/Windows SendInput path; this reproduction
  stalled before text injection. This change does not resolve issue 47.

## Durable liveness correction

Debugger attach and protocol calls now have a six-second extension-side
deadline. Synchronous `Runtime.evaluate` calls also receive Chrome's four-second
execution limit. No failed action is replayed. Error handling reports uncertain
outcomes and bounded click-stage diagnostics, without reading field values.
Rejected awaits release the task queue; late results cannot resume the action's
remaining press steps. These limits bound individual debugger operations, not
the total duration of every multi-stage command, and are not SPA readiness.

## Verification

- A fake-Chrome regression holds target lookup unresolved, triggers the deadline,
  then successfully snapshots and lists tabs in the same task. Resolving the old
  request late produces zero input calls.
- Real Chromium opens an offset shadow modal and clicks its textarea. A controlled
  nonterminating textarea mousedown handler is interrupted by the protocol
  execution limit; the recorded stage is `mousedown-and-focus`, and a subsequent
  modal snapshot succeeds. This demonstrates recovery, not LinkedIn's initial trigger.
- After installing and reloading the bounded diagnostics, a separate Chad tab
  completed Connect, Add a note, and four consecutive textarea-focus clicks.
  An unsent multiline diagnostic note was visible in a fresh snapshot. Cancel
  adding a note succeeded, and only that test tab was closed. No Send action
  was issued, and the original Tavi draft was left untouched.

The live stall did not recur after reload, so its initiating request remains
unproven. The runtime is suitable for a guarded retry with actionable deadlines;
do not treat this as proof that LinkedIn can never stall. Re-observe the original
draft before retrying input. A timeout is never evidence that input was absent.
