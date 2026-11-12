import { keyIssue, settingsView, storedKeyWarning } from "./settings-state.js";

const KEY_COPY = {
  "one-shot":
    "One-shot mode accepts an Alibaba Cloud Model Studio Token Plan key. A site-managed key stays in the function; a browser key is kept in a protected cookie and never appears in the page.",
  live:
    "The live interpreter requires a Model Studio workspace key (sk-ws); Token Plan keys are rejected by the realtime service. A site-managed key stays in the function; a browser key is kept in a protected cookie and never appears in the page.",
};
const KEY_PLACEHOLDER = { "one-shot": "sk-sp-…", live: "sk-ws-…" };

const DIALOG_HTML = `
<dialog class="settings-dialog" id="settingsDialog" aria-labelledby="settingsTitle">
  <div class="settings-card">
    <div class="settings-head">
      <h2 id="settingsTitle">Settings</h2>
      <button class="ghost small" id="settingsClose" type="button">Close</button>
    </div>
    <section class="settings-block" aria-labelledby="serviceKeyTitle">
      <div class="settings-row">
        <h3 id="serviceKeyTitle">Service key</h3>
        <span class="key-status" id="keyStatus">Checking…</span>
      </div>
      <p class="key-copy" id="keyCopy"></p>
      <form class="key-form" id="keyForm" autocomplete="off" hidden>
        <label class="field" for="keyInput">
          <span>API key</span>
          <input id="keyInput" type="password" inputmode="text" autocomplete="off" spellcheck="false" placeholder="sk-sp-…">
        </label>
        <div class="actions">
          <button id="keySave" class="secondary" type="submit">Save key</button>
          <button id="keyForget" class="ghost" type="button" hidden>Forget key</button>
        </div>
      </form>
      <p class="hint key-hint" id="keyHint" aria-live="polite"></p>
    </section>
  </div>
</dialog>
`;

function ensureDialog() {
  let dialog = document.querySelector("#settingsDialog");
  if (dialog) return dialog;
  const template = document.createElement("template");
  template.innerHTML = DIALOG_HTML.trim();
  dialog = template.content.firstElementChild;
  document.body.append(dialog);
  return dialog;
}

export function initSettings({ onChange, mode = "one-shot" } = {}) {
  const button = document.querySelector("#settingsBtn");
  const dialog = ensureDialog();
  const elements = {
    copy: dialog.querySelector("#keyCopy"),
    close: dialog.querySelector("#settingsClose"),
    status: dialog.querySelector("#keyStatus"),
    form: dialog.querySelector("#keyForm"),
    input: dialog.querySelector("#keyInput"),
    save: dialog.querySelector("#keySave"),
    forget: dialog.querySelector("#keyForget"),
    hint: dialog.querySelector("#keyHint"),
  };
  const modeKey = mode === "live" ? "live" : "one-shot";
  elements.copy.textContent = KEY_COPY[modeKey];
  elements.input.placeholder = KEY_PLACEHOLDER[modeKey];

  let source = "unknown";
  let family = "other";
  let view = settingsView(source);
  let message = "";

  function warning() {
    return source === "server" ? "" : storedKeyWarning(modeKey, family);
  }

  function render() {
    elements.status.textContent = view.status;
    elements.status.dataset.state = view.statusState;
    elements.form.hidden = !view.showForm;
    elements.forget.hidden = !view.showForget;
    elements.hint.textContent = message || warning() || view.hint;
  }

  function setSource(next, nextFamily = "other") {
    source = next;
    family = typeof nextFamily === "string" ? nextFamily : "other";
    view = settingsView(next);
    message = "";
    render();
    onChange?.(source, family);
  }

  async function refresh() {
    try {
      const response = await fetch("/functions/v1/app/key", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data || data.ok !== true) throw new Error("unavailable");
      setSource(
        typeof data.source === "string" ? data.source : "none",
        typeof data.keyFamily === "string" ? data.keyFamily : "other",
      );
    } catch {
      setSource("unknown");
    }
  }

  function open({ focus = false } = {}) {
    message = "";
    render();
    if (!dialog.open) dialog.showModal();
    if (focus && view.showForm) elements.input.focus();
    else if (!view.showForm) elements.close.focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  if (button) button.addEventListener("click", () => open());
  elements.close.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = elements.input.value.trim();
    if (!value) {
      message = "Paste the key first.";
      render();
      elements.input.focus();
      return;
    }
    const issue = keyIssue(value, modeKey);
    if (issue) {
      message = issue;
      render();
      elements.input.focus();
      return;
    }

    elements.save.disabled = true;
    message = "Saving…";
    render();
    try {
      const response = await fetch("/functions/v1/app/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: value }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) {
        throw new Error(data && typeof data.error === "string" ? data.error : "The key could not be saved.");
      }
      elements.input.value = "";
      setSource(
        data.source === "server" ? "server" : "browser",
        typeof data.keyFamily === "string" ? data.keyFamily : "other",
      );
      message = "Key saved. Translation is ready.";
      render();
    } catch (error) {
      message = error && error.message ? error.message : "The key could not be saved.";
      render();
    } finally {
      elements.save.disabled = false;
    }
  });

  elements.forget.addEventListener("click", async () => {
    elements.forget.disabled = true;
    try {
      const response = await fetch("/functions/v1/app/key", { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) throw new Error("failed");
      setSource(
        data.source === "server" ? "server" : "none",
        typeof data.keyFamily === "string" ? data.keyFamily : "other",
      );
      message = "Key removed from this browser.";
      render();
    } catch {
      message = "The key could not be removed. Try again.";
      render();
    } finally {
      elements.forget.disabled = false;
    }
  });

  render();
  void refresh();

  return { open, close, refresh, get source() { return source; } };
}
