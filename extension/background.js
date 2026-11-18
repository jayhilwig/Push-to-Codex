const host = "com.push_to_codex.host";
let transferInProgress = false;
let lastTransferEnded = 0;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      sender.origin !== "https://chatgpt.com" || message?.type !== "push") return false;

  const { prompt, mode, submit } = message;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") ||
      !["active", "new"].includes(mode) || typeof submit !== "boolean") {
    respond({ code: "invalid" });
    return false;
  }
  const request = { prompt, mode, submit };
  if (new TextEncoder().encode(JSON.stringify(request)).length > 1024 * 1024) {
    respond({ code: "too_long" });
    return false;
  }
  if (transferInProgress || Date.now() - lastTransferEnded < 1200) {
    respond({ code: "in_progress" });
    return false;
  }

  transferInProgress = true;
  let port;
  let timeout;
  function finish(result) {
    if (!transferInProgress || !timeout) return;
    clearTimeout(timeout);
    timeout = undefined;
    transferInProgress = false;
    lastTransferEnded = Date.now();
    port?.disconnect();
    respond(result);
  }
  timeout = setTimeout(() => finish({ code: "unknown_outcome" }), 22000);
  try {
    port = chrome.runtime.connectNative(host);
    port.onMessage.addListener(reply => finish(
      typeof reply?.code === "string" ? { code: reply.code } : { code: "unknown_outcome" }
    ));
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || "";
      const code = /not found|not registered/i.test(error) ? "helper_missing" :
        /forbidden|not allowed/i.test(error) ? "helper_forbidden" :
        /failed to start/i.test(error) ? "helper_failed" : "unknown_outcome";
      finish({ code });
    });
    port.postMessage(request);
  } catch {
    finish({ code: "helper_failed" });
  }
  return true;
});
