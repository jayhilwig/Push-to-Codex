(() => {
  const rootSelector = ".push-to-codex";
  const legacyCopy = 'button[data-testid="copy-turn-action-button"]';
  const completeTurn = '[data-talvt-turn-state="complete"]';
  const modes = { active: "Continue active chat", new: "Start new chat" };
  const messages = {
    inserted: "Prompt inserted",
    submitted: "Prompt submitted",
    inserted_review: "Prompt inserted. Send it in Codex.",
    review_draft: "Review the draft in Codex",
    not_open: "Codex not open",
    ambiguous: "Multiple Codex windows open",
    no_chat: "Unable to identify active chat",
    no_composer: "Unable to verify the new composer",
    draft: "Existing draft detected",
    busy: "Codex is busy",
    focus: "Unable to focus the Codex composer",
    unsupported_editor: "Codex composer doesn’t support verified insertion",
    clipboard_unavailable: "Windows clipboard is unavailable",
    clipboard_format: "Push couldn’t preserve the current clipboard format",
    too_long: "Prompt is too long for this transfer",
    empty: "No response text to push",
    invalid: "This prompt couldn’t be transferred",
    helper_missing: "Windows helper not installed",
    helper_forbidden: "Windows helper isn’t registered for this extension",
    helper_failed: "Unable to start the Windows helper",
    codex_unavailable: "Unable to open Codex",
    in_progress: "A transfer just ran or is in progress",
    unknown_outcome: "Check Codex before trying again"
  };
  const icons = {
    active: '<path d="M4 4.5h8a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H7L3 14v-3a1.5 1.5 0 0 1-.5-1.1V6A1.5 1.5 0 0 1 4 4.5Z"/>',
    new: '<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M8 5.75v4.5M5.75 8h4.5"/>',
    chevron: '<path d="m4.5 6.5 3.5 3 3.5-3"/>',
    check: '<path d="m4.5 8 2.25 2.25 4.75-5"/>'
  };
  const icon = name => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + "</svg>";
  let prefs = { mode: "active", submit: false };
  let ready = false;
  let sending = false;
  let menuOwner;
  let refreshQueued = false;
  let sequence = 0;
  const buttonViews = new WeakMap();

  function refreshControls() {
    for (const root of document.querySelectorAll(rootSelector)) buttonViews.get(root)?.render();
  }

  function preferenceChanged(values) {
    prefs = { mode: values.mode === "new" ? "new" : "active", submit: values.submit === true };
    refreshControls();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.preferences) preferenceChanged(changes.preferences.newValue || {});
  });
  chrome.storage.local.get("preferences").then(values => {
    ready = true;
    preferenceChanged(values.preferences || {});
  }).catch(() => {
    ready = true;
    refreshControls();
  });

  function setPreference(change, showStatus) {
    preferenceChanged({ ...prefs, ...change });
    chrome.storage.local.set({ preferences: prefs }).catch(() => showStatus("Preferences couldn’t be saved."));
  }

  function findSources(toolbar) {
    const turn = toolbar.closest(completeTurn);
    if (turn) {
      return [...turn.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"] [data-response-body]')]
        .filter(body => body.closest(completeTurn) === turn && !body.closest("[hidden], [inert]"));
    }
    const legacy = toolbar.closest('[data-testid^="conversation-turn-"], article');
    if (!legacy || legacy.matches('[data-turn="user"], [aria-busy="true"]')) return [];
    // Legacy ChatGPT adds the response Copy action after the answer finishes.
    return [...legacy.querySelectorAll('[data-message-author-role="assistant"]')]
      .filter(body => !body.closest(".result-streaming, [aria-busy=true], [hidden], [inert]"));
  }

  function selectedRange(sources) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    return sources.some(body => body.contains(range.startContainer)) &&
      sources.some(body => body.contains(range.endContainer))
      ? range.cloneRange() : null;
  }

  function extract(sources, range) {
    if (range && (!sources.some(body => body.contains(range.startContainer)) ||
                  !sources.some(body => body.contains(range.endContainer)))) return "";

    return sources.map(body => {
      if (!range) return PushMarkdown.read(body);
      if (!range.intersectsNode(body)) return "";
      const portion = document.createRange();
      portion.selectNodeContents(body);
      if (body.contains(range.startContainer)) portion.setStart(range.startContainer, range.startOffset);
      if (body.contains(range.endContainer)) portion.setEnd(range.endContainer, range.endOffset);
      return PushMarkdown.read(body, portion);
    }).filter(Boolean).join("\n\n");
  }

  function mount(toolbar) {
    const root = document.createElement("span");
    root.className = rootSelector.slice(1);
    const menuId = "push-to-codex-menu-" + ++sequence;
    root.innerHTML =
      '<span class="push-status-wrap"><span class="push-status" role="status" aria-live="polite"></span>' +
        '<button type="button" class="push-fallback" hidden>Start new chat</button></span>' +
      '<span class="push-split">' +
        '<button type="button" class="push-main"><span class="push-mode-icon"></span>Push</button>' +
        '<button type="button" class="push-chevron" aria-label="Push options" aria-haspopup="menu" aria-expanded="false" aria-controls="' + menuId + '" title="Push options">' + icon("chevron") + '</button>' +
      '</span>' +
      '<span class="push-menu" id="' + menuId + '" role="menu" aria-label="Push options" hidden>' +
        Object.entries(modes).map(([mode, label]) =>
          '<button type="button" role="menuitemradio" tabindex="-1" data-mode="' + mode + '">' +
            icon(mode) + '<span>' + label + '</span><span class="push-check">' + icon("check") + '</span></button>').join("") +
        '<span class="push-divider" role="separator"></span>' +
        '<button type="button" role="menuitemcheckbox" tabindex="-1" class="push-submit">' +
          '<span class="push-checkbox">' + icon("check") + '</span><span>Automatically submit prompt</span></button>' +
      '</span>';

    const primary = root.querySelector(".push-main");
    const modeIcon = root.querySelector(".push-mode-icon");
    const chevron = root.querySelector(".push-chevron");
    const menu = root.querySelector(".push-menu");
    const choices = [...menu.querySelectorAll("button")];
    const submitItem = choices.at(-1);
    const status = root.querySelector(".push-status");
    const fallback = root.querySelector(".push-fallback");
    let statusTimer;
    let currentMode;
    let working = false;
    let capturedRange = null;
    let fallbackRange = null;

    function render() {
      if (currentMode !== prefs.mode) {
        modeIcon.innerHTML = icon(prefs.mode);
        currentMode = prefs.mode;
      }
      primary.title = modes[prefs.mode] + (prefs.submit ? " and submit prompt" : " with a prompt draft");
      primary.setAttribute("aria-label", "Push. " + primary.title);
      primary.setAttribute("aria-disabled", String(!ready || sending));
      chevron.setAttribute("aria-disabled", String(!ready || sending));
      fallback.setAttribute("aria-disabled", String(!ready || sending));
      root.toggleAttribute("data-sending", working);
      for (const choice of choices.slice(0, -1)) {
        choice.setAttribute("aria-checked", String(prefs.mode === choice.dataset.mode));
      }
      submitItem.setAttribute("aria-checked", String(prefs.submit));
    }

    function showStatus(text, showFallback = false) {
      clearTimeout(statusTimer);
      status.textContent = text;
      fallback.hidden = !showFallback;
      if (!showFallback) fallbackRange = null;
      if (text && !working && !showFallback) {
        statusTimer = setTimeout(() => { status.textContent = ""; }, 9000);
      }
    }

    function close(restoreFocus = false) {
      menu.hidden = true;
      chevron.setAttribute("aria-expanded", "false");
      if (menuOwner === close) menuOwner = undefined;
      if (restoreFocus) chevron.focus({ preventScroll: true });
    }

    function open(index = choices.findIndex(choice => choice.dataset.mode === prefs.mode)) {
      if (!ready || sending) return;
      menuOwner?.();
      menuOwner = close;
      menu.hidden = false;
      chevron.setAttribute("aria-expanded", "true");
      choices[index].focus({ preventScroll: true });
    }

    async function transfer(event, mode, range) {
      if (!event.isTrusted || !ready || sending) return;
      const sources = findSources(toolbar);
      const selection = range || selectedRange(sources);
      const prompt = extract(sources, selection);
      if (!prompt.trim()) {
        showStatus(messages.empty);
        return;
      }

      close();
      working = sending = true;
      refreshControls();
      showStatus("Sending…");
      let code;
      try {
        const reply = await chrome.runtime.sendMessage({ type: "push", prompt, mode, submit: prefs.submit });
        code = reply?.code;
      } catch {
        code = "unknown_outcome";
      } finally {
        working = sending = false;
        refreshControls();
      }
      const offerNew = mode === "active" && (code === "not_open" || code === "no_chat");
      if (offerNew) fallbackRange = selection;
      showStatus(messages[code] || messages.unknown_outcome, offerNew);
    }

    // Keep a response selection intact when a pointer would move focus to the split button.
    root.addEventListener("mousedown", event => {
      if (!event.isTrusted || event.button !== 0 || !event.target.closest("button")) return;
      capturedRange = selectedRange(findSources(toolbar));
      if (capturedRange) event.preventDefault();
    });
    primary.addEventListener("click", event => {
      const range = event.detail ? capturedRange : null;
      capturedRange = null;
      transfer(event, prefs.mode, range);
    });
    fallback.addEventListener("click", event => transfer(event, "new", fallbackRange));
    chevron.addEventListener("click", () => menu.hidden ? open() : close());
    chevron.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      open(event.key === "ArrowUp" ? choices.length - 1 : 0);
    });
    menu.addEventListener("keydown", event => {
      const index = choices.indexOf(document.activeElement);
      const next = {
        ArrowDown: (index + 1) % choices.length,
        ArrowUp: (index + choices.length - 1) % choices.length,
        Home: 0,
        End: choices.length - 1
      }[event.key];
      if (next !== undefined) {
        event.preventDefault();
        choices[next].focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") {
        close(true);
      }
    });
    for (const choice of choices) {
      choice.addEventListener("click", event => {
        if (!event.isTrusted || sending) return;
        if (choice === submitItem) setPreference({ submit: !prefs.submit }, showStatus);
        else {
          setPreference({ mode: choice.dataset.mode }, showStatus);
          close(true);
        }
      });
    }
    buttonViews.set(root, { render, close });
    render();
    toolbar.append(root);
  }

  function scan() {
    refreshQueued = false;
    const toolbars = new Set(document.querySelectorAll(completeTurn + " .turn-action-controls"));
    for (const copy of document.querySelectorAll(legacyCopy)) toolbars.add(copy.parentElement);

    for (const toolbar of toolbars) {
      if (!findSources(toolbar).length || toolbar.querySelector(rootSelector) || toolbar.closest(rootSelector)) continue;
      const action = toolbar.querySelector(toolbar.closest(completeTurn) ? "button" : legacyCopy);
      if (action && !action.disabled && action.getAttribute("aria-disabled") !== "true") mount(toolbar);
    }
    for (const root of document.querySelectorAll(rootSelector)) {
      if (!toolbars.has(root.parentElement) || !findSources(root.parentElement).length) {
        buttonViews.get(root)?.close();
        root.remove();
      }
    }
  }

  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(rootSelector)) menuOwner?.();
  }, true);
  document.addEventListener("focusin", event => {
    if (!event.target.closest(rootSelector)) menuOwner?.();
  });
  new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target instanceof Element && record.target.closest(rootSelector)) return false;
      return record.type === "attributes" || [...record.addedNodes, ...record.removedNodes]
        .some(node => node.nodeType === Node.ELEMENT_NODE && !node.matches(rootSelector));
    });
    if (relevant && !refreshQueued) {
      refreshQueued = true;
      setTimeout(scan, 50);
    }
  }).observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-talvt-turn-state", "data-testid", "aria-busy", "aria-disabled", "disabled"]
  });
  scan();
})();
