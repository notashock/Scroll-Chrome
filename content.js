/**
 * TubeDeck – Content Script
 * =========================
 * Lightweight & optimized for low-spec systems:
 *  - Native browser autoPictureInPicture & MediaSession integration (no gesture drop errors)
 *  - Global Picture-in-Picture dismissals via background service worker and Ctrl+Shift+8
 *  - Dual-layer in-page shortcuts (Ctrl+Shift+8, Alt+Shift+X, Alt+X)
 *  - Debounced auto-exit on tab/window restoration ensuring zero DComp visual drops
 *  - Throttled sentinel & rAF debounced mutation observers (near-zero CPU footprint)
 *  - Safe runtime messaging protecting against extension context invalidation & lastError leaks
 *  - Automatic observer disconnection when navigating away from watch pages
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
    fullAmbient: false,
    pipShortcut: DEFAULT_PIP_SHORTCUT,
  };

  let currentSettings = { ...DEFAULTS };
  let continuationObserver = null;
  let mutationObs = null;
  let mutationThrottleTimer = null;
  let returnDebounceTimer = null;
  let lastSentinelTriggerTime = 0;
  let lastShortcutHandledTime = 0;
  let currentObservedVideo = null;

  /* ── Safe Messaging (Consumes lastError to prevent uncaught logs) ─── */

  function safeSendMessage(msg) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(msg, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (_) {}
  }

  function isWatchPage() {
    return window.location.pathname.startsWith("/watch");
  }

  /* ── State Synchronization for MAIN World Script ─────────────────── */

  function syncAutoPipState() {
    try {
      const active = currentSettings.enabled && currentSettings.autoPip;
      document.documentElement.setAttribute(
        "data-yt-split-scroll-auto-pip",
        active ? "true" : "false"
      );
    } catch (_) {}
  }

  function syncAmbientState() {
    try {
      const active = currentSettings.enabled && currentSettings.fullAmbient;
      document.documentElement.setAttribute(
        "data-yt-split-scroll-full-ambient",
        active ? "true" : "false"
      );
    } catch (_) {}
  }

  /* ── CSS Class Toggling ───────────────────────────────────────────── */

  function applyClasses() {
    const root = document.documentElement;
    root.classList.toggle("yt-split-scroll", currentSettings.enabled);
    root.classList.toggle(
      "yt-split-scroll-sticky-player",
      currentSettings.enabled && currentSettings.stickyPlayer
    );
    root.classList.toggle(
      "yt-split-scroll-hide-scrollbars",
      currentSettings.enabled && currentSettings.hideScrollbars
    );
    root.classList.toggle(
      "yt-split-scroll-hide-shorts",
      currentSettings.enabled && currentSettings.hideShorts
    );
    root.classList.toggle(
      "yt-split-scroll-auto-pip",
      currentSettings.enabled && currentSettings.autoPip
    );
    root.classList.toggle(
      "yt-split-scroll-full-ambient",
      currentSettings.enabled && currentSettings.fullAmbient
    );

    syncAutoPipState();
    syncAmbientState();
  }

  /* ── Infinite Scroll Sentinel Watcher (Prioritizes Video Playback) ── */

  function triggerLoad(entry) {
    if (!entry.isIntersecting) return;

    const now = Date.now();
    if (now - lastSentinelTriggerTime < 1200) return; // Conservative 1.2s throttle to protect video decoding
    lastSentinelTriggerTime = now;

    const el = entry.target;
    // Defer suggestion loading to browser idle periods so video gets 100% GPU priority
    const scheduleTask = typeof window.requestIdleCallback === "function"
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1000 })
      : (cb) => setTimeout(cb, 60);

    scheduleTask(() => {
      const btn = el.querySelector("button, tp-yt-paper-button, yt-button-renderer button");
      if (btn) {
        btn.click();
        return;
      }

      try {
        window.dispatchEvent(new Event("scroll"));
      } catch (_) {}
    });
  }

  function setupContinuationObserver() {
    if (continuationObserver) {
      continuationObserver.disconnect();
      continuationObserver = null;
    }

    if (!currentSettings.enabled || !isWatchPage()) return;

    const secondary = document.querySelector(
      "ytd-watch-flexy:not([theater]):not([fullscreen]) #secondary"
    );
    if (!secondary) return;

    try {
      continuationObserver = new IntersectionObserver(
        (entries) => entries.forEach(triggerLoad),
        {
          root: secondary,
          rootMargin: "0px 0px 120px 0px", // Only request when nearing bottom, not 400px early
          threshold: 0,
        }
      );

      const sentinels = secondary.querySelectorAll("ytd-continuation-item-renderer");
      sentinels.forEach((el) => continuationObserver.observe(el));
    } catch (_) {}
  }

  /* ── Mutation Watcher (Debounced via requestAnimationFrame) ───────── */

  function setupMutationWatcher() {
    if (mutationObs) {
      mutationObs.disconnect();
      mutationObs = null;
    }

    if (!currentSettings.enabled || !isWatchPage()) return;

    const secondary = document.querySelector("#secondary-inner") || document.querySelector("#secondary");
    if (!secondary) return;

    try {
      mutationObs = new MutationObserver(() => {
        if (mutationThrottleTimer) return;
        mutationThrottleTimer = requestAnimationFrame(() => {
          mutationThrottleTimer = null;
          if (!continuationObserver || !secondary) return;
          try {
            const sentinels = secondary.querySelectorAll("ytd-continuation-item-renderer");
            sentinels.forEach((el) => continuationObserver.observe(el));
          } catch (_) {}
        });
      });

      mutationObs.observe(secondary, { childList: true, subtree: true });
    } catch (_) {}
  }

  /* ── Video Detection & Attribute Management ──────────────────────── */

  function findVideoElement() {
    const mainVideo =
      document.querySelector("#movie_player video") ||
      document.querySelector("ytd-watch-flexy video.html5-main-video") ||
      document.querySelector("video.html5-main-video");
    if (mainVideo) return mainVideo;

    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((v) => v.offsetWidth > 0 && v.offsetHeight > 0) || videos[0] || null;
  }

  function unlockVideoPip(video) {
    if (!video) return;
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;

      if (currentSettings.enabled && currentSettings.autoPip) {
        video.autoPictureInPicture = true;
        video.setAttribute("autopictureinpicture", "true");
      } else {
        video.autoPictureInPicture = false;
        video.removeAttribute("autopictureinpicture");
      }

      if (!video._splitScrollTracked) {
        video._splitScrollTracked = true;
        video.addEventListener("enterpictureinpicture", () => {
          safeSendMessage({ action: "pip-started" });
        });
        video.addEventListener("leavepictureinpicture", () => {
          safeSendMessage({ action: "pip-stopped" });
        });
      }
    } catch (_) {}
  }

  // Observer that strips disablepictureinpicture if YouTube dynamically re-applies it
  const pipAttributeObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "disablepictureinpicture") {
        if (m.target instanceof HTMLVideoElement && m.target.hasAttribute("disablepictureinpicture")) {
          m.target.removeAttribute("disablepictureinpicture");
          m.target.disablePictureInPicture = false;
        }
      }
    }
  });

  function setupAutoPip() {
    if (!isWatchPage()) return;
    syncAutoPipState();

    const video = findVideoElement();
    if (!video) return;

    unlockVideoPip(video);

    if (currentObservedVideo !== video) {
      currentObservedVideo = video;
      try {
        pipAttributeObserver.observe(video, {
          attributes: true,
          attributeFilter: ["disablepictureinpicture"],
        });
      } catch (_) {}
    }
  }

  /* ── Debounced Auto-Exit PiP on Window / Tab Return ───────────────── */

  function handleTabReturn() {
    if (!currentSettings.enabled || !currentSettings.autoPip) return;

    if (returnDebounceTimer) {
      clearTimeout(returnDebounceTimer);
    }

    // Delay 250ms so Windows DWM unminimize animation finishes and DirectX surface is composited
    returnDebounceTimer = setTimeout(async () => {
      returnDebounceTimer = null;
      if (document.visibilityState !== "visible") return;

      if (document.pictureInPictureElement) {
        try {
          await document.exitPictureInPicture();
        } catch (_) {}
      }
    }, 250);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      handleTabReturn();
    } else {
      if (returnDebounceTimer) {
        clearTimeout(returnDebounceTimer);
        returnDebounceTimer = null;
      }
    }
  });

  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible") {
      handleTabReturn();
    }
  });

  /* ── Picture-in-Picture Toggle ─────────────────────────────────────── */

  function togglePictureInPicture() {
    lastShortcutHandledTime = Date.now();
    if (returnDebounceTimer) {
      clearTimeout(returnDebounceTimer);
      returnDebounceTimer = null;
    }

    try {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        return;
      }

      const video = findVideoElement();
      if (!video) return;

      unlockVideoPip(video);

      video.requestPictureInPicture().catch((err) => {
        // Silently catch gesture checks if invoked without user activation
        if (err.name !== "NotAllowedError" && err.name !== "InvalidStateError") {
          console.warn("[Split Scroll] PiP toggle:", err.name, err.message);
        }
      });
    } catch (_) {}
  }

  document.addEventListener(
    "enterpictureinpicture",
    () => {
      safeSendMessage({ action: "pip-started" });
    },
    true
  );

  document.addEventListener(
    "leavepictureinpicture",
    () => {
      safeSendMessage({ action: "pip-stopped" });
    },
    true
  );

  /* ── Native Command & Message Dispatcher ─────────────────────────── */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.action === "exit-pip" || message.action === "exit-pip-if-active") {
      if (returnDebounceTimer) {
        clearTimeout(returnDebounceTimer);
        returnDebounceTimer = null;
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        sendResponse({ exited: true, wasActive: true, success: true });
      } else {
        sendResponse({ exited: false, wasActive: false, success: true });
      }
      return;
    }

    if (message.action === "window-focused") {
      handleTabReturn();
      sendResponse({ received: true });
      return;
    }

    if (message.action === "window-defocused") {
      if (currentSettings.enabled && currentSettings.autoPip) {
        const video = findVideoElement();
        if (video && !video.paused && !video.ended && !document.pictureInPictureElement) {
          try {
            unlockVideoPip(video);
            video.requestPictureInPicture().catch(() => {});
          } catch (_) {}
        }
      }
      sendResponse({ received: true });
      return;
    }

    if (message.action === "toggle-pip") {
      // If we just handled this shortcut from in-page keydown, avoid race condition collision
      if (Date.now() - lastShortcutHandledTime < 800) {
        sendResponse({ success: true, ignoredDuplicate: true });
        return;
      }
      togglePictureInPicture();
      sendResponse({ success: true });
    }
  });

  /* ── In-Page Keyboard Shortcut Handler ───────────────────────────── */

  function isEditableElement(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    const tag = element.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function handleKeyDown(e) {
    if (!currentSettings.enabled) return;

    const activeEl = document.activeElement;
    if (isEditableElement(e.target) || isEditableElement(activeEl)) {
      return;
    }

    const key = e.key ? e.key.toLowerCase() : "";
    const code = e.code ? e.code.toLowerCase() : "";

    // 1. Built-in global standard shortcut: Ctrl+Shift+8
    const isCtrlShift8 = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (key === "8" || code === "digit8");

    // 2. Popular alternate shortcuts: Alt+P, Alt+Shift+X, Alt+X
    const isAltP = e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (key === "p" || code === "keyp");
    const isAltShiftX = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (key === "x" || code === "keyx");
    const isAltX = e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (key === "x" || code === "keyx");

    // 3. User customized shortcut (synced from Chrome commands or custom selection)
    const custom = currentSettings.pipShortcut;
    let customMatches = false;
    if (custom) {
      const matchKey = custom.key && key === custom.key.toLowerCase();
      const matchCode = custom.code && code === custom.code.toLowerCase();
      const matchAlt = !!e.altKey === !!custom.altKey;
      const matchCtrl = !!e.ctrlKey === !!custom.ctrlKey;
      const matchShift = !!e.shiftKey === !!custom.shiftKey;
      const matchMeta = !!e.metaKey === !!custom.metaKey;
      customMatches = (matchKey || matchCode) && matchAlt && matchCtrl && matchShift && matchMeta;
    }

    if (isCtrlShift8 || isAltP || isAltShiftX || isAltX || customMatches) {
      e.preventDefault();
      e.stopPropagation();
      togglePictureInPicture();
    }
  }

  window.addEventListener("keydown", handleKeyDown, true);

  /* ── Cleanup on Navigation Away ───────────────────────────────────── */

  function cleanupWatchPage() {
    if (continuationObserver) {
      continuationObserver.disconnect();
      continuationObserver = null;
    }
    if (mutationObs) {
      mutationObs.disconnect();
      mutationObs = null;
    }
    if (pipAttributeObserver) {
      pipAttributeObserver.disconnect();
    }
    if (mutationThrottleTimer) {
      cancelAnimationFrame(mutationThrottleTimer);
      mutationThrottleTimer = null;
    }
    if (returnDebounceTimer) {
      clearTimeout(returnDebounceTimer);
      returnDebounceTimer = null;
    }
    currentObservedVideo = null;
  }

  /* ── YouTube Logo Click to Miniplayer ────────────────────────────── */

  function handleLogoClick(e) {
    if (!currentSettings.enabled) return;

    // Check if clicked target is or is inside YouTube's topbar logo
    const logoLink = e.target.closest("a#logo, ytd-topbar-logo-renderer, a.ytd-topbar-logo-renderer");
    if (!logoLink) return;

    // Only intercept when watching a video on the watch page
    if (!isWatchPage()) return;

    const video = findVideoElement();
    if (!video || video.ended) return;

    // Prevent default navigation to Home so video is not destroyed
    e.preventDefault();
    e.stopPropagation();

    // Trigger native miniplayer via main world event & direct click fallback
    try {
      window.dispatchEvent(new CustomEvent("yt-deck-toggle-miniplayer"));
    } catch (_) {}

    const miniBtn =
      document.querySelector(".ytp-miniplayer-button") ||
      document.querySelector("button[data-tooltip-target-id='ytp-miniplayer-button']") ||
      document.querySelector(".ytp-button.ytp-miniplayer-button");

    if (miniBtn) {
      try {
        miniBtn.click();
      } catch (_) {}
    }
  }

  document.addEventListener("click", handleLogoClick, true);

  /* ── Miniplayer State Sync for Ambient Glow Persistence ─────────── */

  let miniplayerObs = null;

  function syncMiniplayerState() {
    try {
      const miniplayer = document.querySelector("ytd-miniplayer");
      const isActive =
        miniplayer &&
        (miniplayer.hasAttribute("active") ||
          miniplayer.getAttribute("active") === "" ||
          miniplayer.getAttribute("active") === "true");

      document.documentElement.classList.toggle(
        "yt-split-scroll-miniplayer-active",
        Boolean(currentSettings.enabled && isActive)
      );
    } catch (_) {}
  }

  function setupMiniplayerObserver() {
    if (miniplayerObs) return;

    const miniplayer = document.querySelector("ytd-miniplayer");
    if (!miniplayer) return;

    miniplayerObs = new MutationObserver(() => {
      syncMiniplayerState();
    });

    miniplayerObs.observe(miniplayer, {
      attributes: true,
      attributeFilter: ["active"],
    });

    syncMiniplayerState();
  }

  /* ── Initialization ───────────────────────────────────────────────── */

  function init() {
    applyClasses();
    setupMiniplayerObserver();

    if (!isWatchPage()) {
      cleanupWatchPage();
      return;
    }

    setupAutoPip();

    setTimeout(() => {
      if (isWatchPage()) {
        setupContinuationObserver();
        setupMutationWatcher();
        setupAutoPip();
      }
    }, 600);
  }

  // Load initial settings
  try {
    chrome.storage.local
      .get(DEFAULTS)
      .then((result) => {
        currentSettings = { ...DEFAULTS, ...result };
        init();
      })
      .catch(() => {
        init();
      });
  } catch (_) {
    init();
  }

  document.addEventListener("yt-navigate-start", () => {
    if (!isWatchPage()) {
      cleanupWatchPage();
    }
  });

  document.addEventListener("yt-navigate-finish", () => {
    init();
  });

  /* ── Real-Time Storage Listener ──────────────────────────────────── */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes.enabled !== undefined) {
        currentSettings.enabled = changes.enabled.newValue ?? DEFAULTS.enabled;
      }
      if (changes.stickyPlayer !== undefined) {
        currentSettings.stickyPlayer = changes.stickyPlayer.newValue ?? DEFAULTS.stickyPlayer;
      }
      if (changes.hideScrollbars !== undefined) {
        currentSettings.hideScrollbars = changes.hideScrollbars.newValue ?? DEFAULTS.hideScrollbars;
      }
      if (changes.hideShorts !== undefined) {
        currentSettings.hideShorts = changes.hideShorts.newValue ?? DEFAULTS.hideShorts;
      }
      if (changes.autoPip !== undefined) {
        currentSettings.autoPip = changes.autoPip.newValue ?? DEFAULTS.autoPip;
      }
      if (changes.fullAmbient !== undefined) {
        currentSettings.fullAmbient = changes.fullAmbient.newValue ?? DEFAULTS.fullAmbient;
      }
      if (changes.pipShortcut !== undefined) {
        currentSettings.pipShortcut = changes.pipShortcut.newValue ?? DEFAULT_PIP_SHORTCUT;
      }

      init();
    });
  } catch (_) {}
})();
