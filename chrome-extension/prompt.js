// The small window the extension opens when it needs the user, not the model:
// to approve a site under an "ask" rule, or to type credentials that go
// straight into the page. It reads its request from the background worker by
// id and answers once; closing the window counts as cancelling.

const id = location.hash.slice(1);
const $ = (selector) => document.getElementById(selector);
let answered = false;

function answer(approved, values) {
  if (answered) return;
  answered = true;
  chrome.runtime.sendMessage({ type: "cu-prompt-answer", id, approved, values }).finally(() => window.close());
}

const INPUT_TYPES = { password: "password", email: "email", code: "text", username: "text", text: "text" };
const AUTOCOMPLETE = { password: "current-password", email: "email", code: "one-time-code", username: "username", text: "off" };
const KIND_LABEL = { password: "Password", email: "Email", code: "Verification code", username: "Username", text: "Text" };

/** Grow the window to its content, so the buttons are never below the fold. */
async function fitWindow() {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const missing = document.documentElement.scrollHeight - window.innerHeight;
  if (missing <= 0) return;
  const current = await chrome.windows.getCurrent();
  await chrome.windows.update(current.id, { height: current.height + missing });
}

chrome.runtime.sendMessage({ type: "cu-prompt-init", id }).then((spec) => {
  if (!spec) {
    $("title").textContent = "This request has expired.";
    $("form").hidden = true;
    return;
  }
  let host = spec.origin;
  try {
    host = new URL(spec.origin).host;
  } catch {}
  $("host").textContent = host;
  $("origin").textContent = spec.origin;
  if (spec.reason) {
    $("reason").textContent = spec.reason;
    $("reason-line").hidden = false;
  }

  if (spec.kind === "credentials") {
    document.title = `Sign in to ${host}`;
    $("title").textContent = `Sign in to ${host}`;
    $("lock").textContent = spec.secure ? "🔒" : "⚠️";
    $("insecure").hidden = spec.secure;
    $("note").textContent = "What you type goes straight into the page. The agent never sees it.";
    $("ok").textContent = "Fill in";
    for (const field of spec.fields) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.id = `f${field.index}`;
      input.type = INPUT_TYPES[field.kind] ?? "text";
      input.autocomplete = AUTOCOMPLETE[field.kind] ?? "off";
      if (field.kind === "code") input.inputMode = "numeric";
      input.dataset.index = String(field.index);
      label.htmlFor = input.id;
      // The page's own label says which field this is; the kind is the fallback.
      label.textContent = field.label || KIND_LABEL[field.kind];
      $("fields").append(label, input);
    }
    $("fields").querySelector("input")?.focus();
  } else {
    const action = spec.action || "use";
    document.title = `Allow ${host}?`;
    $("title").textContent = `Let the agent ${action} ${host}?`;
    $("lock").textContent = "🛡️";
    $("note").textContent = "Your Computer Use policy asks before the agent uses this site. Allowing it lasts until this agent task ends.";
    $("ok").textContent = "Allow";
    $("cancel").textContent = "Don't allow";
    $("ok").focus();
  }

  void fitWindow();

  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (spec.kind !== "credentials") return answer(true);
    const values = {};
    for (const input of $("fields").querySelectorAll("input")) values[input.dataset.index] = input.value;
    answer(true, values);
  });
  $("cancel").addEventListener("click", () => answer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") answer(false);
  });
});
