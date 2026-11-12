export function authFailureView(source, { prompted = false, keyFamily = "other" } = {}) {
  if (source === "server") {
    return {
      message: "The key configured for this site was rejected by the live service. Ask the site owner to update it.",
      openSettings: false,
    };
  }
  if (keyFamily === "token_plan") {
    return {
      message: prompted
        ? "The key saved in this browser is a Token Plan key. Open Settings to replace it with a workspace key (sk-ws-…)."
        : "The live interpreter rejected the key saved in this browser because it is a Token Plan key. Open Settings and save a workspace key (sk-ws-…).",
      openSettings: !prompted,
    };
  }
  if (keyFamily === "workspace") {
    return {
      message: prompted
        ? "The saved workspace key was rejected again. It may be inactive, revoked, or from another workspace."
        : "The realtime service rejected the saved workspace key. It may be inactive, revoked, or from another workspace. Open Settings and save a current workspace key.",
      openSettings: !prompted,
    };
  }
  return {
    message: prompted
      ? "The saved key was rejected again. Open Settings to replace it with a workspace key."
      : "The service key saved in this browser was rejected. Open Settings and save a valid key.",
    openSettings: !prompted,
  };
}
