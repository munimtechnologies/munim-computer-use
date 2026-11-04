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
  stalled before text injection. This queue correction did not resolve issue 47.
  Upstream has since merged its native typing/readback correction in `4778cac`
  (PR #49), now included as the base of the reconciled PR #51.

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

## Later resource-pressure report

Additional observations were fetched from:

- https://github.com/munimtechnologies/munim-computer-use/issues/52#issuecomment-6641101922
- https://github.com/munimtechnologies/munim-computer-use/issues/52#issuecomment-6641191672

The saved Tavi activity contains a `browser_list_tabs` response showing **20
LinkedIn tabs** in session `tavi-fixed` while Junshen and two other tabs repeatedly
failed read-only snapshots. Other tabs still responded. The newer user message
in that thread identifies memory pressure as the bottleneck and requests at most
five prospect tabs in the group, fewer if necessary, closing completed tabs only
after confirmation. This is the user's diagnosis plus verified workload evidence;
no contemporaneous memory measurement was captured by this investigation.

At the later inspection, none of those prospect tabs, including original Chad
`1809485137`, appeared in the extension's whole-browser inventory. This investigator
did not close, reload, alter, or send from them. Their disappearance is not evidence
of whether drafts were saved or why the tabs vanished. No new prospect tab was opened.
Current memory was 7.73 GiB free of 15.75 GiB, and no recent Windows resource-exhaustion
event was returned by the log query. This cannot reconstruct earlier pressure.

Separately, the native test build encountered an actually full C: drive. Only
this worktree's generated debug build artifacts were removed; source, backups,
browser state and drafts were preserved. The release-profile native tests then
passed. Disk pressure at build time does not establish the cause of the earlier
Chrome symptoms.

### Prevention and honest diagnostics

- Explicit `browser_open_tab` calls stop at five agent-created tabs per task,
  before creation, without closing an existing tab. Closing a deliberately chosen,
  completed tab frees a slot. Adopted user tabs are excluded; page-created popups
  are not prevented, and multiple tasks share machine resources. This prevents
  the observed sequence of 20 explicit opens; it is not a global memory guarantee.
- Debugger failures append available status/frozen/discarded metadata obtained
  from Chrome's browser process. This read does not activate, reload or close a
  tab, and does not diagnose memory pressure by itself.
- Tab selection now says Chrome reports the tab active, explicitly leaving page
  rendering unverified. Active-tab metadata and a screenshot's painted contents
  are different observations. The original mismatch was not reproduced because
  the affected tabs were no longer available.

The ignored Connect clicks, blank rendering, active-tab/screenshot mismatch, and
individual renderer timeouts are not established to share one cause. Dispatching
click events is not proof that LinkedIn accepted an action. Bing's reported
rejection and Rohit's uncertain outcome remain unchanged; no sends were retried.

Verification for this follow-up: 64 extension tests (including sixth-open
rejection, no draft removal, independent task budgets, and non-mutating lifecycle
diagnostics), complete Chromium suite, extension-build tests, tool parity, and
155 release-profile native tests passed. Live guard verification is pending the
extension reload and will use only blank tabs.
