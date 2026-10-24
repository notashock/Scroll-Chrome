/**
 * TubeDeck – Popup Controller
 * ===========================
 * Handles user preferences and synchronizes with storage.
 * Detects Helium/Chromium (built-in native Auto-PiP) vs Brave (non-native toggle).
 */

(function () {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    stickyPlayer: false,
    hideScrollbars: true,
    hideShorts: true,
    autoPip: true,
    pipOnMinimize: true,
    fullAmbient: false,
  };

  // Browser detection: Brave does not feature native Chromium auto-pip tab helpers
  const isBrave = Boolean(navigator.brave) || navigator.userAgent.includes("Brave");
  const FLAG_URL = isBrave
    ? "brave://flags/#auto-picture-in-picture-for-video-playback"
    : "chrome://flags/#auto-picture-in-picture-for-video-playback";
  const PERM_URL = "chrome://settings/content/autoPictureInPicture";
  const SHORTCUTS_URL = "chrome://extensions/shortcuts";

  // Elements
  const enabledEl = document.getElementById("enabled");
  const hideShortsEl = document.getElementById("hideShorts");
  const fullAmbientEl = document.getElementById("fullAmbient");

  const nonNativePipContainer = document.getElementById("nonNativePipContainer");
  const autoPipEl = document.getElementById("autoPip");
  const pipOnMinimizeEl = document.getElementById("pipOnMinimize");
  const pipOnMinimizeRow = document.getElementById("pipOnMinimizeRow");

  const nativePipContainer = document.getElementById("nativePipContainer");
  const openFlagLink = document.getElementById("openFlagLink");
  const openPermLink = document.getElementById("openPermLink");
  const openShortcutsLink = document.getElementById("openShortcutsLink");
  const statusBanner = document.getElementById("statusBanner");

  let bannerTimeout = null;

  function showBanner(text) {
    if (!statusBanner) return;
    if (bannerTimeout) clearTimeout(bannerTimeout);
    statusBanner.textContent = text;
    statusBanner.className = "status-banner visible info";
    bannerTimeout = setTimeout(() => {
      statusBanner.className = "status-banner";
    }, 4500);
  }

  function safeSetStorage(data) {
    try {
      if (chrome.storage?.local) {
        chrome.storage.local.set(data);
      }
    } catch (_) {}
  }

  /* ── Configure Browser-Specific Auto-PiP Presentation ─────────────── */

  if (isBrave) {
    if (nonNativePipContainer) nonNativePipContainer.style.display = "block";
    if (nativePipContainer) nativePipContainer.style.display = "none";
  } else {
    // Built-in native Auto-PiP browser (Helium, Chrome, Edge, ungoogled-chromium)
    if (nonNativePipContainer) nonNativePipContainer.style.display = "none";
    if (nativePipContainer) nativePipContainer.style.display = "flex";
  }

  /* ── Load initial settings ────────────────────────────────────────── */

  try {
    chrome.storage.local.get(DEFAULTS).then((settings) => {
      if (enabledEl) enabledEl.checked = settings.enabled ?? DEFAULTS.enabled;
      if (hideShortsEl) hideShortsEl.checked = settings.hideShorts ?? DEFAULTS.hideShorts;
      if (fullAmbientEl) fullAmbientEl.checked = settings.fullAmbient ?? DEFAULTS.fullAmbient;

      if (autoPipEl) autoPipEl.checked = settings.autoPip ?? DEFAULTS.autoPip;
      if (pipOnMinimizeEl) pipOnMinimizeEl.checked = settings.pipOnMinimize ?? DEFAULTS.pipOnMinimize;

      // Ensure hideScrollbars is true and stickyPlayer is false by default
      const updates = {};
      if (settings.hideScrollbars === undefined) updates.hideScrollbars = true;
      if (settings.stickyPlayer !== false) updates.stickyPlayer = false;
      if (Object.keys(updates).length > 0) safeSetStorage(updates);

      if (pipOnMinimizeRow && autoPipEl) {
        pipOnMinimizeRow.style.display = autoPipEl.checked ? "flex" : "none";
      }
    }).catch(() => {});
  } catch (_) {}

  /* ── Toggle listeners ─────────────────────────────────────────────── */

  if (enabledEl) {
    enabledEl.addEventListener("change", () => {
      safeSetStorage({ enabled: enabledEl.checked });
    });
  }

  if (hideShortsEl) {
    hideShortsEl.addEventListener("change", () => {
      safeSetStorage({ hideShorts: hideShortsEl.checked });
    });
  }

  if (fullAmbientEl) {
    fullAmbientEl.addEventListener("change", () => {
      safeSetStorage({ fullAmbient: fullAmbientEl.checked });
    });
  }

  if (autoPipEl) {
    autoPipEl.addEventListener("change", () => {
      safeSetStorage({ autoPip: autoPipEl.checked });
      if (pipOnMinimizeRow) {
        pipOnMinimizeRow.style.display = autoPipEl.checked ? "flex" : "none";
      }
    });
  }

  if (pipOnMinimizeEl) {
    pipOnMinimizeEl.addEventListener("change", () => {
      safeSetStorage({ pipOnMinimize: pipOnMinimizeEl.checked });
    });
  }

  /* ── Navigation links with clipboard fallback ─────────────────────── */

  if (openFlagLink) {
    openFlagLink.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.tabs.create({ url: FLAG_URL }, () => {
          if (chrome.runtime.lastError) {
            copyToClipboard(FLAG_URL, "Copied flags URL to clipboard! Enable Auto-PiP flags.");
          }
        });
      } catch (_) {
        copyToClipboard(FLAG_URL, "Copied flags URL to clipboard! Enable Auto-PiP flags.");
      }
    });
  }

  if (openPermLink) {
    openPermLink.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.tabs.create({ url: PERM_URL }, () => {
          if (chrome.runtime.lastError) {
            copyToClipboard(PERM_URL, "Open address bar (Tune 🎚️) -> Site settings -> Allow Automatic PiP.");
          } else {
            showBanner("In Settings: Set 'Automatic picture-in-picture' to Allow!");
          }
        });
      } catch (_) {
        copyToClipboard(PERM_URL, "Open address bar (Tune 🎚️) -> Site settings -> Allow Automatic PiP.");
      }
    });
  }

  if (openShortcutsLink) {
    openShortcutsLink.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.tabs.create({ url: SHORTCUTS_URL }, () => {
          if (chrome.runtime.lastError) {
            copyToClipboard(SHORTCUTS_URL, "Copied chrome://extensions/shortcuts to clipboard!");
          }
        });
      } catch (_) {
        copyToClipboard(SHORTCUTS_URL, "Copied chrome://extensions/shortcuts to clipboard!");
      }
    });
  }

  function copyToClipboard(url, message) {
    try {
      navigator.clipboard.writeText(url);
      showBanner(message);
    } catch (_) {
      showBanner(`Open ${url} in your browser.`);
    }
  }
})();
