/**
 * YouTube Split Scroll – Popup Script
 * ====================================
 *
 * Reads/writes settings to chrome.storage.local and synchronizes
 * active keyboard shortcuts with chrome.commands.
 */

(function () {
  "use strict";

  const DEFAULT_PIP_SHORTCUT = {
    key: "8",
    code: "Digit8",
    altKey: false,
    ctrlKey: true,
    shiftKey: true,
    metaKey: false,
    display: "Ctrl+Shift+8",
  };

  const DEFAULTS = {
    enabled: true,
    stickyPlayer: false,
    hideScrollbars: true,
    hideShorts: true,
    autoPip: false,
    pipShortcut: DEFAULT_PIP_SHORTCUT,
  };

  const enabledEl = document.getElementById("enabled");
  const stickyEl = document.getElementById("stickyPlayer");
  const hideScrollbarsEl = document.getElementById("hideScrollbars");
  const hideShortsEl = document.getElementById("hideShorts");
  const autoPipEl = document.getElementById("autoPip");
  const autoPipFlagRow = document.getElementById("autoPipFlagRow");
  const openFlagLink = document.getElementById("openFlagLink");
  const pipShortcutBtn = document.getElementById("pipShortcutBtn");
  const resetShortcutBtn = document.getElementById("resetShortcutBtn");
  const openShortcutsLink = document.getElementById("openShortcutsLink");
  const presetChips = document.querySelectorAll(".preset-chip");
  const statusEl = document.getElementById("shortcutStatus");

  let currentShortcut = { ...DEFAULT_PIP_SHORTCUT };
  let isRecording = false;
  let statusTimeout = null;

  function setStatus(msg, type = "info") {
    if (!statusEl) return;
    if (statusTimeout) clearTimeout(statusTimeout);
    statusEl.textContent = msg;
    statusEl.className = `shortcut-status visible ${type}`;
    statusTimeout = setTimeout(() => {
      statusEl.className = "shortcut-status";
    }, 4000);
  }

  function parseShortcutString(str) {
    if (!str || typeof str !== "string") return null;
    const rawParts = str.split("+").map((t) => t.trim()).filter(Boolean);
    if (rawParts.length === 0) return null;

    const keyToken = rawParts[rawParts.length - 1];
    const modifiers = rawParts.slice(0, -1).map((m) => m.toLowerCase());

    const ctrlKey = modifiers.includes("ctrl") || modifiers.includes("macctrl") || modifiers.includes("control");
    const altKey = modifiers.includes("alt") || modifiers.includes("option");
    const shiftKey = modifiers.includes("shift");
    const metaKey = modifiers.includes("command") || modifiers.includes("meta");

    let code = "";
    if (/^[a-zA-Z]$/.test(keyToken)) {
      code = "Key" + keyToken.toUpperCase();
    } else if (/^[0-9]$/.test(keyToken)) {
      code = "Digit" + keyToken;
    } else if (/^f[1-9][0-2]?$/i.test(keyToken)) {
      code = keyToken.toUpperCase();
    } else if (keyToken.toLowerCase() === "up") {
      code = "ArrowUp";
    } else if (keyToken.toLowerCase() === "down") {
      code = "ArrowDown";
    } else if (keyToken.toLowerCase() === "left") {
      code = "ArrowLeft";
    } else if (keyToken.toLowerCase() === "right") {
      code = "ArrowRight";
    }

    return {
      key: keyToken.toLowerCase(),
      code: code || keyToken,
      altKey,
      ctrlKey,
      shiftKey,
      metaKey,
      display: str,
    };
  }

  function safeSetStorage(data) {
    try {
      if (chrome.storage?.local) {
        chrome.storage.local.set(data);
      }
    } catch (_) {}
  }

  function formatShortcutDisplay(shortcut) {
    if (!shortcut || !shortcut.key) return "None";
    const parts = [];
    if (shortcut.ctrlKey) parts.push("Ctrl");
    if (shortcut.altKey) parts.push("Alt");
    if (shortcut.shiftKey) parts.push("Shift");
    if (shortcut.metaKey) parts.push("Meta");

    let keyName = shortcut.key.toUpperCase();
    if (shortcut.code && shortcut.code.startsWith("Key")) {
      keyName = shortcut.code.slice(3).toUpperCase();
    } else if (shortcut.code && shortcut.code.startsWith("Digit")) {
      keyName = shortcut.code.slice(5);
    }
    parts.push(keyName);
    return parts.join("+");
  }

  function updateShortcutUI(shortcut) {
    currentShortcut = shortcut || DEFAULT_PIP_SHORTCUT;
    const displayText = currentShortcut.display || formatShortcutDisplay(currentShortcut);
    pipShortcutBtn.textContent = displayText;

    // Highlight preset chip if matching
    presetChips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.shortcut.toLowerCase() === displayText.toLowerCase());
    });
  }

  function startRecording() {
    isRecording = true;
    pipShortcutBtn.classList.add("recording");
    pipShortcutBtn.textContent = "Press keys...";
    setStatus("Press any shortcut combination (e.g. Alt+P, Ctrl+Shift+8)...", "info");
  }

  function stopRecording() {
    isRecording = false;
    pipShortcutBtn.classList.remove("recording");
    updateShortcutUI(currentShortcut);
  }

  /* ── Load settings & synchronize with chrome.commands ────────────── */

  async function initSettings() {
    try {
      const settings = await chrome.storage.local.get(DEFAULTS);
      enabledEl.checked = settings.enabled;
      stickyEl.checked = settings.stickyPlayer;
      hideScrollbarsEl.checked = settings.hideScrollbars;
      hideShortsEl.checked = settings.hideShorts;
      autoPipEl.checked = settings.autoPip;
      if (autoPipFlagRow) {
        autoPipFlagRow.style.display = settings.autoPip ? "flex" : "none";
      }
      updateShortcutUI(settings.pipShortcut);
    } catch (_) {}

    // Check Chrome's native command registration
    try {
      if (chrome.commands && typeof chrome.commands.getAll === "function") {
        const commands = await chrome.commands.getAll();
        const pipCmd = commands.find((c) => c.name === "toggle-pip");
        if (pipCmd && pipCmd.shortcut) {
          const parsed = parseShortcutString(pipCmd.shortcut);
          if (parsed) {
            safeSetStorage({ pipShortcut: parsed });
            updateShortcutUI(parsed);
          }
        }
      }
    } catch (_) {}
  }

  initSettings();

  /* ── Save on toggle change ────────────────────────────────────────── */

  enabledEl.addEventListener("change", () => {
    safeSetStorage({ enabled: enabledEl.checked });
  });

  stickyEl.addEventListener("change", () => {
    safeSetStorage({ stickyPlayer: stickyEl.checked });
  });

  hideScrollbarsEl.addEventListener("change", () => {
    safeSetStorage({ hideScrollbars: hideScrollbarsEl.checked });
  });

  hideShortsEl.addEventListener("change", () => {
    safeSetStorage({ hideShorts: hideShortsEl.checked });
  });

  autoPipEl.addEventListener("change", () => {
    safeSetStorage({ autoPip: autoPipEl.checked });
    if (autoPipFlagRow) {
      autoPipFlagRow.style.display = autoPipEl.checked ? "flex" : "none";
    }
  });

  /* ── Quick Preset Chips ───────────────────────────────────────────── */

  presetChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      if (isRecording) stopRecording();
      const shortcutStr = chip.dataset.shortcut;
      const parsed = parseShortcutString(shortcutStr);
      if (parsed) {
        currentShortcut = parsed;
        safeSetStorage({ pipShortcut: parsed });
        updateShortcutUI(parsed);
        setStatus(`Set to ${shortcutStr}! (Works in YouTube & PiP)`, "success");
      }
    });
  });

  /* ── Shortcut Recorder ────────────────────────────────────────────── */

  pipShortcutBtn.addEventListener("click", () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (!isRecording) return;
      e.preventDefault();
      e.stopPropagation();

      // Ignore solitary modifier presses
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
        return;
      }

      if (e.key === "Escape") {
        stopRecording();
        return;
      }

      const newShortcut = {
        key: e.key.toLowerCase(),
        code: e.code,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      };
      newShortcut.display = formatShortcutDisplay(newShortcut);

      currentShortcut = newShortcut;
      safeSetStorage({ pipShortcut: newShortcut });
      stopRecording();
      setStatus(`Saved ${newShortcut.display}! (Active in-page)`, "success");
    },
    true
  );

  resetShortcutBtn.addEventListener("click", () => {
    if (isRecording) stopRecording();
    currentShortcut = { ...DEFAULT_PIP_SHORTCUT };
    safeSetStorage({ pipShortcut: currentShortcut });
    updateShortcutUI(currentShortcut);
    setStatus("Reset to default Ctrl+Shift+8", "info");
  });

  /* ── Open Chrome Flags Page ───────────────────────────────────────── */

  const FLAG_URL = "chrome://flags/#auto-picture-in-picture-for-video-playback";

  if (openFlagLink) {
    openFlagLink.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.tabs.create({ url: FLAG_URL }, () => {
          if (chrome.runtime.lastError) {
            fallbackCopyFlagLink();
          }
        });
      } catch (_) {
        fallbackCopyFlagLink();
      }
    });
  }

  function fallbackCopyFlagLink() {
    try {
      navigator.clipboard.writeText(FLAG_URL);
      setStatus("Copied flag URL to clipboard! Open a tab and paste.", "info");
    } catch (_) {
      setStatus(`Open ${FLAG_URL} in browser bar.`, "info");
    }
  }

  /* ── Open Chrome Shortcuts Config ─────────────────────────────────── */

  if (openShortcutsLink) {
    openShortcutsLink.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.tabs.create({ url: "chrome://extensions/shortcuts" }, () => {
          if (chrome.runtime.lastError) {
            fallbackCopyLink();
          }
        });
      } catch (_) {
        fallbackCopyLink();
      }
    });
  }

  function fallbackCopyLink() {
    try {
      navigator.clipboard.writeText("chrome://extensions/shortcuts");
      setStatus("Copied chrome://extensions/shortcuts to clipboard! Open a tab and paste.", "info");
    } catch (_) {
      setStatus("Open chrome://extensions/shortcuts in your browser bar.", "info");
    }
  }
})();
