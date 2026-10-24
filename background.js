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

async function getPipTabId() {
  const info = await getPipInfo();
  return info.tabId;
}

async function setPipTabId(tabId) {
  await setPipInfo(tabId, null);
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
    currentActiveYouTubeTabId = sender.tab.id;
    if (sender.tab.windowId) {
      currentActiveYouTubeWindowId = sender.tab.windowId;
    }
    sendResponse({ received: true });
  } else if (message.action === "pip-stopped") {
    setPipInfo(null, null);
    // Retain currentActiveYouTubeTabId and currentActiveYouTubeWindowId so subsequent Alt+Tab / focus changes still trigger
    if (sender.tab?.id && sender.tab.url && sender.tab.url.includes("youtube.com")) {
      currentActiveYouTubeTabId = sender.tab.id;
      if (sender.tab.windowId) {
        currentActiveYouTubeWindowId = sender.tab.windowId;
      }
    }
    sendResponse({ received: true });
  } else if (message.action === "sync-shortcuts") {
    syncCommandShortcuts().then(() => sendResponse({ synced: true }));
    return true;
  } else if (message.action === "open-shortcuts-page") {
    try {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      sendResponse({ opened: true });
    } catch (_) {
      sendResponse({ opened: false });
    }
  } else if (message.action === "open-flags-page") {
    try {
      const flagUrl = message.url || "chrome://flags/#auto-picture-in-picture-for-video-playback";
      chrome.tabs.create({ url: flagUrl });
      sendResponse({ opened: true });
    } catch (_) {
      sendResponse({ opened: false });
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabId: currentPipTabId } = await getPipInfo();
  if (currentPipTabId === tabId) {
    await setPipInfo(null, null);
  }
  if (lastActiveTabId === tabId) {
    lastActiveTabId = null;
  }
});

/* ── Tab Switch Listener for Auto-PiP ────────────────────────────── */

let lastActiveTabId = null;
let currentActiveYouTubeTabId = null;
let currentActiveYouTubeWindowId = null;

async function initActiveTabTracking() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      lastActiveTabId = tab.id;
      if (tab.url && tab.url.includes("youtube.com")) {
        currentActiveYouTubeTabId = tab.id;
        currentActiveYouTubeWindowId = tab.windowId;
      }
    }
  } catch (_) {}
}

initActiveTabTracking();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab && tab.active) {
    lastActiveTabId = tabId;
    if (tab.url && tab.url.includes("youtube.com")) {
      currentActiveYouTubeTabId = tabId;
      currentActiveYouTubeWindowId = tab.windowId;
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const data = await chrome.storage.local.get({
      enabled: true,
      autoPip: true,
    });
    if (!data.enabled || !data.autoPip) {
      lastActiveTabId = activeInfo.tabId;
      return;
    }

    const { tabId: currentPipTabId } = await getPipInfo();

    // 1. If returning to the YouTube tab with active PiP, restore video inside the tab
    if (currentPipTabId && activeInfo.tabId === currentPipTabId) {
      chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
    }

    // 2. If leaving a YouTube tab, tell the previously active tab to enter PiP
    if (lastActiveTabId && lastActiveTabId !== activeInfo.tabId) {
      try {
        const prevTab = await chrome.tabs.get(lastActiveTabId);
        if (prevTab?.id && prevTab.url && prevTab.url.includes("youtube.com")) {
          chrome.tabs.sendMessage(prevTab.id, {
            action: "enter-pip",
            reason: "tab-switch",
          }).catch(() => {});
        }
      } catch (_) {}
    }

    lastActiveTabId = activeInfo.tabId;

    try {
      const activeTab = await chrome.tabs.get(activeInfo.tabId);
      if (activeTab?.url && activeTab.url.includes("youtube.com")) {
        currentActiveYouTubeTabId = activeTab.id;
        currentActiveYouTubeWindowId = activeTab.windowId;
      } else {
        currentActiveYouTubeTabId = null;
      }
    } catch (_) {}
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
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab?.id && tab.url && tab.url.includes("youtube.com")) {
        chrome.tabs.sendMessage(tab.id, {
          action: "enter-pip",
          reason: "minimized",
        }).catch(() => {});
      }
    } else if (win && (win.state === "normal" || win.state === "maximized")) {
      const { tabId: currentPipTabId, windowId: currentPipWindowId } = await getPipInfo();
      if (currentPipTabId && currentPipWindowId && win.id === currentPipWindowId) {
        chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
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

    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      // 1. If switching away from an active YouTube window to another browser window:
      if (
        data.pipOnMinimize &&
        currentActiveYouTubeWindowId &&
        windowId !== currentActiveYouTubeWindowId &&
        currentActiveYouTubeTabId
      ) {
        chrome.tabs.sendMessage(currentActiveYouTubeTabId, {
          action: "enter-pip",
          reason: "window-switched",
        }).catch(() => {});
      }

      // 2. Query and update tracking for the newly focused window:
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId });
        if (activeTab?.id) {
          lastActiveTabId = activeTab.id;
          if (activeTab.url && activeTab.url.includes("youtube.com")) {
            currentActiveYouTubeTabId = activeTab.id;
            currentActiveYouTubeWindowId = windowId;
          }
        }
      } catch (_) {}

      // 3. Returning focus to the browser window with YouTube that had PiP open:
      const { tabId: currentPipTabId, windowId: currentPipWindowId } = await getPipInfo();
      if (currentPipTabId && currentPipWindowId && windowId === currentPipWindowId) {
        chrome.tabs.sendMessage(currentPipTabId, { action: "window-focused" }).catch(() => {});
      }
      return;
    }

    // 4. Alt+Tab or defocusing away from all browser windows (windowId === WINDOW_ID_NONE):
    if (data.pipOnMinimize) {
      if (currentActiveYouTubeTabId) {
        chrome.tabs.sendMessage(currentActiveYouTubeTabId, {
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
  const trackedTabId = await getPipTabId();
  if (trackedTabId) {
    try {
      const response = await chrome.tabs.sendMessage(trackedTabId, { action: "exit-pip" });
      if (response?.exited) {
        await setPipTabId(null);
        return;
      }
    } catch {
      await setPipTabId(null);
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
          await setPipTabId(null);
          return;
        }
      } catch {}
    }
  } catch {}

  if (closedAny) return;

  // 3. If no tab had PiP open, user wanted to open PiP on the currently active YouTube tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id && activeTab.url?.includes("youtube.com")) {
      chrome.tabs.sendMessage(activeTab.id, { action: "toggle-pip" }).catch(() => {});
    }
  } catch {}
});