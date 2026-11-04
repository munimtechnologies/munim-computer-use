# LinkedIn invitation dialog: issue 46

Live investigation on Windows, 2026-11-04, for
https://github.com/munimtechnologies/munim-computer-use/issues/46.

Chrome CDP `DOM.getDocument({depth:-1,pierce:true})` captured the invitation at:

```text
document / HTML / BODY / DIV#root / DIV#interop-outlet
  / #document-fragment (shadowRootType: open)
  / DIV / DIV#artdeco-modal-outlet / DIV#ember43 / DIV[role=dialog]
```

In the same post-click snapshot, `Accessibility.getFullAXTree` reported
`dialog`, name `Add a note to your invitation?`, backend DOM node `6885`.
The ordinary snapshot reported `scope: page`; `[role='dialog']` readiness
timed out after 8004 ms. The dialog is in the top-level document's open
shadow root, not in the child iframe also present on this page.

Root-cause branches investigated:

- DOM boundary: confirmed open shadow root. Document-only queries cannot
  discover its dialog, controls, or indexed click targets.
- Child frame: ruled out for this captured dialog by its DOM ancestry.
- Visibility and modal heuristics: existing Chromium tests pass; the actual
  dialog never reached those heuristics because discovery excluded its root.
- Timing: the dialog was present in DOM and AX after the readiness timeout.
- Runtime drift: Chrome originally loaded extension source at `99333ca`
  and cached native `0.9.1`. Source was advanced and the extension reloaded
  before the diagnostic capture. At that capture the existing MCP bridge owner
  still ran `0.9.1`. Superseded by the later verification: the bridge now runs
  the source-built `0.10.0` fork and its executable hashes match the local build.

The fix shares open-root discovery across snapshots, readiness, indexed click
lookup and credential fields. Visibility checks cross shadow hosts; modal
containment and hit testing account for shadow boundaries. Regression coverage
uses real Chromium with the captured interop-outlet structure, nested roots,
background exclusion, indexed clicks, hidden hosts and inert hosts.

CSS selectors remain root-local. Child frames and closed shadow roots are
not traversed. No claim is made about those structures or arbitrary SPA readiness.

## Live verification follow-up

After loading the fix, a read-only re-observation reported readiness `met`
in 13 ms for `[role='dialog']` and exposed `Dismiss`, `Add a note`, and
`Send without a note` at indices 253–255. However, snapshot scope remained
`page`: discovery was fixed, but modal scoping still needed work. No invitation
was sent at this checkpoint.

The implicit ARIA-dialog heuristic requires the dialog to cover the viewport
centre. Added coverage and handling for a dialog near the top of a full-viewport,
fixed, hit-tested blocking backdrop. Focus alone does not imply modality, and
explicit `aria-modal=false` remains nonmodal. This follow-up passes the Chromium
suite. The pending live verification above is superseded by the result below.

## Completed live verification

After reloading the extension card with the backdrop correction installed:

- One background-tab click opened Izzy Nill's invitation dialog. Its initial
  10-second readiness wait timed out during LinkedIn loading; no click was replayed.
- Read-only re-observation reported readiness `met` in 23 ms, `scope: modal`,
  total `3`: `Dismiss`, `Add a note`, `Send without a note`. No background
  profile controls were indexed.
- Indexed click `2` (`Send without a note`) ran as page events in the background
  tab. A subsequent page read reported `Invitation sent to Izzy.`
- Independent navigation to https://www.linkedin.com/in/isabelle-nill/
  reported `Pending, click to withdraw invitation sent to Izzy Nill`.

The user explicitly authorized sending a connection request to any recipient
for this final test. The manifest remains version `0.10.0`; the local source
commits distinguish this build. No push or pull request was made.

Validation: the new real-Chromium shadow-modal regression fails on the unchanged
source (`page` versus expected `modal`) and passes with the fix. The complete
Chromium suite, 61 extension tests, native action-contract test, tool parity,
release build and 155 native unit tests passed during this investigation.

## Upstream reconciliation

Upstream subsequently merged its shadow-root fix in `5ffb8d7` (PR #48) and
Windows typing/readback fix in `4778cac` (PR #49). PR #51 now builds on those
commits rather than retaining a competing shadow-root implementation. Its page
scripts use upstream's shared `pageDomInPage` helper, preserving slots, shadow
text reading and skipped-frame reporting. The remaining additions are offset
blocking-backdrop scoping, debugger liveness/recovery, tab-load prevention and
honest rendering-status diagnostics. Historical capture details above describe
the implementation at the time of that capture, not a second current helper.
