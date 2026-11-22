/**
 * TubeDeck – Background Service Worker
 * ====================================
 * Handles global Picture-in-Picture shortcuts, syncs shortcuts from chrome.commands,
 * tracks active PiP across all YouTube tabs, and handles window focus (Alt+Tab) for Auto-PiP.
 */

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

async function syncCommandShortcuts() {
  try {
    if (chrome.commands && typeof chrome.commands.getAll === "function") {
      const commands = await chrome.commands.getAll();
      const pipCmd = commands.find((c) => c.name === "toggle-pip");
      if (pipCmd && pipCmd.shortcut) {
        const parsed = parseShortcutString(pipCmd.shortcut);
        if (parsed) {
          await chrome.storage.local.set({ pipShortcut: parsed });
        }
      }
    }
  } catch (_) {}
}

async function getPipInfo() {
  try {
    const data = await chrome.storage.session.get(["pipTabId", "pipWindowId"]);
    return {
      tabId: data.pipTabId || null,
      windowId: data.pipWindowId || null,
    };
  } catch {
    return { tabId: null, windowId: null };
  }
}

async function setPipInfo(tabId, windowId) {
  try {
    if (tabId) {
      await chrome.storage.session.set({ pipTabId: tabId, pipWindowId: windowId || null });
    } else {
      await chrome.storage.session.remove(["pipTabId", "pipWindowId"]);
    }
  } catch {}
}

// Last focused YouTube tab, kept in session storage: the MV3 worker is killed after ~30s idle,
// so plain variables are empty again exactly when the user switches away from a video.
async function getYtActive() {
  try {
    const data = await chrome.storage.session.get(["ytTabId", "ytWindowId"]);
    return { tabId: data.ytTabId || null, windowId: data.ytWindowId || null };
  } catch {
    return { tabId: null, windowId: null };
  }
}

async function setYtActive(tabId, windowId) {
  try {
    if (tabId) {
      await chrome.storage.session.set({ ytTabId: tabId, ytWindowId: windowId || null });
    } else {
      await chrome.storage.session.remove(["ytTabId", "ytWindowId"]);
    }
  } catch {}
}

// Real youtube.com host only (not e.g. a search URL that merely contains "youtube.com").
// Without the "tabs" permission, Chrome only exposes tab.url for hosts we have access to anyway.
function isYouTubeUrl(url) {
  return /^https?:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(url || "");
}

chrome.runtime.onInstalled.addListener(() => {
  syncCommandShortcuts();
});

chrome.runtime.onStartup.addListener(() => {
  syncCommandShortcuts();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.action === "pip-started" && sender.tab?.id) {
    setPipInfo(sender.tab.id, sender.tab.windowId || null);
    setYtActive(sender.tab.id, sender.tab.windowId);
    sendResponse({ received: true });
  } else if (message.action === "pip-stopped") {
    setPipInfo(null, null);
    // Keep tracking this tab so later Alt+Tab / focus changes still trigger
    if (sender.tab?.id && isYouTubeUrl(sender.tab.url)) {
      setYtActive(sender.tab.id, sender.tab.windowId);
    }
    sendResponse({ received: true });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabId: currentPipTabId } = await getPipInfo();
  if (currentPipTabId === tabId) {
    await setPipInfo(null, null);
  }
  const { tabId: ytTabId } = await getYtActive();
  if (ytTabId === tabId) {
    await setYtActive(null, null);
  }
});

/* ── Tab Switch Listener for Auto-PiP ────────────────────────────── */
// Entering PiP when leaving a tab is done in content.js (visibilitychange → hidden), which needs
// no tracking here. This listener only restores the video and records the active YouTube tab.

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const data = await chrome.storage.local.get({
      enabled: true,
      autoPip: true,
    });
    if (!data.enabled || !data.autoPip) return;

    // If returning to the YouTube tab with active PiP, restore video inside the tab
    const { tabId: currentPipTabId } = await getPipInfo();
    if (currentPipTabId && activeInfo.tabId === currentPipTabId) {
      chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
    }

    const activeTab = await chrome.tabs.get(activeInfo.tabId);
    if (isYouTubeUrl(activeTab?.url)) {
      await setYtActive(activeTab.id, activeTab.windowId);
    } else {
      // Only forget the YouTube tab if it lived in this window; another window may still show it
      const yt = await getYtActive();
      if (yt.windowId === activeInfo.windowId) await setYtActive(null, null);
    }
  } catch (_) {}
});

/* ── Window Focus & Minimize Listeners for Auto-PiP ───────────────── */

chrome.windows.onBoundsChanged.addListener(async (win) => {
  try {
    const data = await chrome.storage.local.get({
      enabled: true,
      autoPip: true,
      pipOnMinimize: true,
    });
    if (!data.enabled || !data.autoPip || !data.pipOnMinimize) return;

    if (win && win.state === "minimized") {
      const tabs = await chrome.tabs.query({ windowId: win.id });
      for (const tab of tabs) {
        if (tab.active && tab.id && isYouTubeUrl(tab.url)) {
          chrome.tabs.sendMessage(tab.id, {
            action: "enter-pip",
            reason: "window-minimized",
          }).catch(() => {});
        }
      }
    } else if (win && (win.state === "normal" || win.state === "maximized")) {
      // Only signal window-focused if this window is currently focused
      if (win.focused) {
        const { tabId: currentPipTabId, windowId: currentPipWindowId } = await getPipInfo();
        if (currentPipTabId && currentPipWindowId && win.id === currentPipWindowId) {
          chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
        }
      }
    }
  } catch (_) {}
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  try {
    const data = await chrome.storage.local.get({
      enabled: true,
      autoPip: true,
      pipOnMinimize: true,
    });
    if (!data.enabled || !data.autoPip) return;

    const yt = await getYtActive();

    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      // 1. Check all windows to see if any YouTube window is currently minimized
      if (data.pipOnMinimize) {
        try {
          const allWindows = await chrome.windows.getAll();
          for (const w of allWindows) {
            if (w.state === "minimized") {
              const tabs = await chrome.tabs.query({ windowId: w.id });
              for (const tab of tabs) {
                if (tab.active && tab.id && isYouTubeUrl(tab.url)) {
                  chrome.tabs.sendMessage(tab.id, {
                    action: "enter-pip",
                    reason: "window-minimized",
                  }).catch(() => {});
                }
              }
            }
          }
        } catch (_) {}
      }

      // 2. If switching away from an active YouTube window to another browser window:
      if (data.pipOnMinimize && yt.tabId && yt.windowId && windowId !== yt.windowId) {
        chrome.tabs.sendMessage(yt.tabId, {
          action: "enter-pip",
          reason: "window-switched",
        }).catch(() => {});
      }

      // 3. Query and update tracking for the newly focused window:
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId });
        if (activeTab?.id && isYouTubeUrl(activeTab.url)) {
          await setYtActive(activeTab.id, windowId);
        }
      } catch (_) {}

      // 4. Returning focus to the browser window with YouTube that had PiP open:
      const { tabId: currentPipTabId, windowId: currentPipWindowId } = await getPipInfo();
      if (currentPipTabId && currentPipWindowId && windowId === currentPipWindowId) {
        try {
          const targetWin = await chrome.windows.get(windowId);
          if (targetWin && targetWin.state !== "minimized") {
            chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
          }
        } catch (_) {
          chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
        }
      }
      return;
    }

    // 5. Defocusing / Alt-Tab / Minimize all windows (windowId === WINDOW_ID_NONE):
    if (data.pipOnMinimize) {
      try {
        const allWindows = await chrome.windows.getAll();
        for (const w of allWindows) {
          if (w.state === "minimized") {
            const tabs = await chrome.tabs.query({ windowId: w.id });
            for (const tab of tabs) {
              if (tab.active && tab.id && isYouTubeUrl(tab.url)) {
                chrome.tabs.sendMessage(tab.id, {
                  action: "enter-pip",
                  reason: "window-minimized",
                }).catch(() => {});
              }
            }
          }
        }
      } catch (_) {}

      if (yt.tabId) {
        chrome.tabs.sendMessage(yt.tabId, {
          action: "enter-pip",
          reason: "alt-tab-defocused",
        }).catch(() => {});
      } else {
        // Fallback: trigger PiP on any currently active YouTube tab
        const ytTabs = await chrome.tabs.query({ active: true, url: "*://*.youtube.com/*" });
        for (const tab of ytTabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              action: "enter-pip",
              reason: "alt-tab-defocused",
            }).catch(() => {});
          }
        }
      }
    }
  } catch (_) {}
});

/* ── Global Command Dispatcher (chrome.commands) ──────────────────── */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-pip") return;

  // Sync latest command shortcut
  syncCommandShortcuts();

  // 1. If we have a cached PiP tab, ask it to exit PiP
  const { tabId: trackedTabId } = await getPipInfo();
  if (trackedTabId) {
    try {
      const response = await chrome.tabs.sendMessage(trackedTabId, { action: "exit-pip" });
      if (response?.exited) {
        await setPipInfo(null, null);
        return;
      }
    } catch {
      await setPipInfo(null, null);
    }
  }

  // 2. Query all YouTube tabs: exit PiP on any tab that currently has an active PiP element
  let closedAny = false;
  try {
    const ytTabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
    for (const tab of ytTabs) {
      if (!tab.id) continue;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "exit-pip" });
        if (response?.exited) {
          closedAny = true;
          await setPipInfo(null, null);
          return;
        }
      } catch {}
    }
  } catch {}

  if (closedAny) return;

  // 3. If no tab had PiP open, user wanted to open PiP on the currently active YouTube tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id && isYouTubeUrl(activeTab.url)) {
      chrome.tabs.sendMessage(activeTab.id, { action: "toggle-pip" }).catch(() => {});
    }
  } catch {}
});