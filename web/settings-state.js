const VIEWS = {
  server: {
    status: "Managed by this site",
    statusState: "saved",
    hint: "This site provides the service key. No action is needed.",
    showForm: false,
    showForget: false,
  },
  browser: {
    status: "Saved in this browser",
    statusState: "saved",
    hint: "The key is stored for this browser. Save a new key to replace it, or forget it to remove it.",
    showForm: true,
    showForget: true,
  },
  none: {
    status: "Not set",
    statusState: "missing",
    hint: "Paste your Alibaba Cloud Model Studio key to enable translation on this device.",
    showForm: true,
    showForget: false,
  },
  unknown: {
    status: "Status unavailable",
    statusState: "missing",
    hint: "Could not read the key status. Saving a key may still work.",
    showForm: true,
    showForget: false,
  },
};

export function settingsView(source) {
  return VIEWS[source] || VIEWS.unknown;
}

export function keyIssue(value, mode) {
  if (mode === "live" && String(value).startsWith("sk-sp-")) {
    return "That is a Token Plan key. The live interpreter only accepts a workspace key (sk-ws-…); copying one from Model Studio's workspace API keys fixes it.";
  }
  return "";
}

export function storedKeyWarning(mode, keyFamily) {
  if (mode === "live" && keyFamily === "token_plan") {
    return "The key saved here is a Token Plan key, which the live interpreter cannot use. Save a workspace key (sk-ws-…) to connect.";
  }
  return "";
}
