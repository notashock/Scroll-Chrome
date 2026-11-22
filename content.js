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
    hideShorts: true,
    autoPip: true,
    pipOnMinimize: true,
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

  /* ── Adaptive UI State Sync (Live Chat, Playlists & Queues) ───────── */

  function syncAdaptiveUIState() {
    try {
      const root = document.documentElement;
      if (!root) return;

      if (!currentSettings.enabled || !isWatchPage()) {
        root.removeAttribute("data-yt-deck-chat");
        root.removeAttribute("data-yt-deck-playlist");
        root.removeAttribute("data-yt-deck-queue");
        return;
      }

      // 1. Live Chat detection (active when chat is uncollapsed and present in DOM)
      const chatEl = document.querySelector("#chat:not([collapsed]), ytd-live-chat-frame:not([collapsed])");
      const isChatActive = Boolean(chatEl && chatEl.offsetHeight > 0);
      root.setAttribute("data-yt-deck-chat", isChatActive ? "active" : "inactive");

      // 2. Playlist & Queue detection
      const playlistEl = document.querySelector("ytd-playlist-panel-renderer, #playlist");
      const isPlaylistActive = Boolean(playlistEl && playlistEl.offsetHeight > 0);
      root.setAttribute("data-yt-deck-playlist", isPlaylistActive ? "active" : "inactive");

      const isQueue = Boolean(
        isPlaylistActive && (
          playlistEl.getAttribute("playlist-type") === "queue" ||
          playlistEl.hasAttribute("queue") ||
          playlistEl.querySelector("#header-description")?.textContent?.toLowerCase()?.includes("queue") ||
          playlistEl.querySelector(".header-description")?.textContent?.toLowerCase()?.includes("queue")
        )
      );
      root.setAttribute("data-yt-deck-queue", isQueue ? "active" : "inactive");
    } catch (_) {}
  }

  function applyClasses() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("yt-split-scroll", currentSettings.enabled);
    root.classList.toggle("yt-deck-watch", Boolean(currentSettings.enabled && isWatchPage()));
    root.classList.toggle(
      "yt-split-scroll-hide-shorts",
      Boolean(currentSettings.enabled && currentSettings.hideShorts)
    );
    root.classList.toggle(
      "yt-split-scroll-auto-pip",
      Boolean(currentSettings.enabled && currentSettings.autoPip)
    );
    root.classList.toggle(
      "yt-split-scroll-full-ambient",
      Boolean(currentSettings.enabled && currentSettings.fullAmbient)
    );

    syncAutoPipState();
    syncAmbientState();
    syncAdaptiveUIState();
  }

  // Instant zero-flicker application at document_start
  applyClasses();

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

  function isVideoPlaying() {
    try {
      const v = findVideoElement();
      return Boolean(v && !v.paused && !v.ended && v.readyState >= 2);
    } catch (_) {
      return false;
    }
  }

  /* ── Infinite Scroll Sentinel Watcher (Prioritizes Video Playback) ── */

  function triggerLoad(entry) {
    if (!entry.isIntersecting) return;

    const now = Date.now();
    // Throttle more conservatively when video is actively playing (1.8s vs 1.2s)
    const minInterval = isVideoPlaying() ? 1800 : 1200;
    if (now - lastSentinelTriggerTime < minInterval) return;
    lastSentinelTriggerTime = now;

    const el = entry.target;
    // Defer suggestion loading strictly to browser idle periods so video gets 100% GPU priority
    const scheduleTask = typeof window.requestIdleCallback === "function"
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 100);

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

  /* ── Mutation Watcher (Debounced via requestIdleCallback during playback) ── */

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

        const updateSentinels = () => {
          mutationThrottleTimer = null;
          syncAdaptiveUIState();
          if (!continuationObserver || !secondary) return;
          try {
            const sentinels = secondary.querySelectorAll("ytd-continuation-item-renderer");
            sentinels.forEach((el) => continuationObserver.observe(el));
          } catch (_) {}
        };

        // When video is playing, defer DOM querying to browser idle time to avoid 60fps render drops
        if (isVideoPlaying() && typeof window.requestIdleCallback === "function") {
          mutationThrottleTimer = window.requestIdleCallback(updateSentinels, { timeout: 1200 });
        } else {
          mutationThrottleTimer = requestAnimationFrame(updateSentinels);
        }
      });

      mutationObs.observe(secondary, { childList: true, subtree: true });
    } catch (_) {}
  }

  function unlockVideoPip(video) {
    if (!video) return;
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;

      if (currentSettings.enabled && currentSettings.autoPip) {
        video.autoPictureInPicture = true;
        if (!video.hasAttribute("autopictureinpicture")) {
          video.setAttribute("autopictureinpicture", "");
        }
      } else {
        video.autoPictureInPicture = false;
        video.removeAttribute("autopictureinpicture");
      }
      // PiP enter/leave events bubble, so the document-level listeners below handle every video
    } catch (_) {}
  }

  // Observer that strips disablepictureinpicture and guarantees autopictureinpicture
  const pipAttributeObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.attributeName === "disablepictureinpicture") {
          if (m.target instanceof HTMLVideoElement && m.target.hasAttribute("disablepictureinpicture")) {
            m.target.removeAttribute("disablepictureinpicture");
            m.target.disablePictureInPicture = false;
          }
        } else if (m.attributeName === "autopictureinpicture") {
          if (m.target instanceof HTMLVideoElement && currentSettings.enabled && currentSettings.autoPip) {
            if (!m.target.hasAttribute("autopictureinpicture")) {
              m.target.setAttribute("autopictureinpicture", "");
              m.target.autoPictureInPicture = true;
            }
          }
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
          attributeFilter: ["disablepictureinpicture", "autopictureinpicture"],
        });
      } catch (_) {}
    }
  }

  /* ── Debounced Auto-Exit PiP on Window / Tab Return ───────────────── */

  function handleTabReturn() {
    if (!currentSettings.enabled || !currentSettings.autoPip) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;

    if (returnDebounceTimer) {
      clearTimeout(returnDebounceTimer);
      returnDebounceTimer = null;
    }

    // Delay 250ms so Windows DWM unminimize animation finishes and DirectX surface is composited
    returnDebounceTimer = setTimeout(async () => {
      returnDebounceTimer = null;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;

      if (document.pictureInPictureElement) {
        try {
          await document.exitPictureInPicture();
        } catch (_) {}
      }

      setupAutoPip();
      window.dispatchEvent(new CustomEvent("yt-deck-rearm-pip"));
    }, 250);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (document.hasFocus()) {
        handleTabReturn();
      }
    } else if (document.visibilityState === "hidden") {
      if (returnDebounceTimer) {
        clearTimeout(returnDebounceTimer);
        returnDebounceTimer = null;
      }
      if (currentSettings.enabled && currentSettings.autoPip && currentSettings.pipOnMinimize !== false) {
        window.dispatchEvent(new CustomEvent("yt-deck-trigger-pip"));
        if (!document.pictureInPictureElement) {
          const video = findVideoElement();
          if (video && !video.paused && !video.ended) {
            unlockVideoPip(video);
            video.requestPictureInPicture().catch(() => {});
          }
        }
      }
    }
  });

  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      handleTabReturn();
    }
  });

  window.addEventListener("blur", () => {
    if (returnDebounceTimer) {
      clearTimeout(returnDebounceTimer);
      returnDebounceTimer = null;
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
      if (returnDebounceTimer) {
        clearTimeout(returnDebounceTimer);
        returnDebounceTimer = null;
      }
      safeSendMessage({ action: "pip-started" });
    },
    true
  );

  document.addEventListener(
    "leavepictureinpicture",
    () => {
      if (returnDebounceTimer) {
        clearTimeout(returnDebounceTimer);
        returnDebounceTimer = null;
      }
      safeSendMessage({ action: "pip-stopped" });
      setTimeout(() => {
        setupAutoPip();
        window.dispatchEvent(new CustomEvent("yt-deck-rearm-pip"));
      }, 50);
    },
    true
  );

  /* ── Native Command & Message Dispatcher ─────────────────────────── */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.action === "exit-pip") {
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
      if (document.visibilityState === "visible" && document.hasFocus()) {
        handleTabReturn();
      }
      sendResponse({ received: true });
      return;
    }

    if (message.action === "enter-pip") {
      if (currentSettings.enabled && currentSettings.autoPip) {
        if (returnDebounceTimer) {
          clearTimeout(returnDebounceTimer);
          returnDebounceTimer = null;
        }
        window.dispatchEvent(new CustomEvent("yt-deck-trigger-pip"));
        if (!document.pictureInPictureElement) {
          const video = findVideoElement();
          if (video && !video.paused && !video.ended) {
            unlockVideoPip(video);
            video.requestPictureInPicture().catch(() => {});
          }
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

  /* ── Theater Glow (full-window ambient glow in theater mode) ──────── */

  // YouTube's theater glow is boxed in and freezes in the light theme, so sample the video into an 8x5
  // grid of averaged colours and let CSS stretch it. That few cells carries the scene's colours but no
  // recognisable picture (a bigger grid read as a second video); bilinear upscaling is the blur.
  // Each sample reads the whole video frame back from the GPU (1-2ms, with 30ms+ spikes on 1080p/4K),
  // which stuttered playback at 8 samples/s. Like YouTube's own ambient, sample once per ~1.2s into
  // one of two canvases and let the shared CSS opacity transition crossfade between them.
  const GLOW_W = 8;
  const GLOW_H = 5;
  const GLOW_INTERVAL_MS = 1200;
  let theaterGlow = null;
  let theaterAttrObs = null;

  function stopTheaterGlow() {
    if (!theaterGlow) return;
    const { video, handle, timer, el } = theaterGlow;
    clearTimeout(timer);
    try { video.cancelVideoFrameCallback(handle); } catch (_) {}
    el.remove();
    theaterGlow = null;
  }

  function syncTheaterGlow() {
    const flexy = document.querySelector("ytd-watch-flexy");
    // Full-window glow in both themes, like the default view. It lives in the flexy, not the theater
    // box, because the box's size containment would trap a position: fixed child.
    const host = flexy;
    const video = findVideoElement();
    const wanted = Boolean(
      currentSettings.enabled && currentSettings.fullAmbient && isWatchPage() &&
      host && video && typeof video.requestVideoFrameCallback === "function" &&
      flexy.hasAttribute("theater") && !flexy.hasAttribute("fullscreen")
    );
    if (!wanted) return stopTheaterGlow();
    if (theaterGlow && theaterGlow.video === video && theaterGlow.el.parentNode === host) return;

    stopTheaterGlow();
    // Wrapper carries the edge-fade ::after (a canvas can't have pseudo-elements)
    const el = document.createElement("div");
    el.id = "yt-deck-theater-glow";
    const layers = [];
    for (let i = 0; i < 2; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = GLOW_W;
      canvas.height = GLOW_H;
      canvas.style.opacity = "0";
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      // Average the frame down (mipmapped) instead of point-sampling a few pixels, which flickers
      ctx.imageSmoothingQuality = "high";
      layers.push({ canvas, ctx });
      el.append(canvas);
    }
    host.prepend(el);

    const glow = { el, video, handle: 0, timer: 0, front: 0 };
    // Wait for the next presented frame (paused video: none, so no wasted samples), then sample it
    const sample = () => {
      if (theaterGlow !== glow) return;
      const next = layers[1 - glow.front];
      try {
        next.ctx.drawImage(video, 0, 0, GLOW_W, GLOW_H);
        next.canvas.style.opacity = "1";
        layers[glow.front].canvas.style.opacity = "0";
        glow.front = 1 - glow.front;
      } catch (_) {}
      glow.timer = setTimeout(queue, GLOW_INTERVAL_MS);
    };
    const queue = () => {
      if (theaterGlow === glow) glow.handle = video.requestVideoFrameCallback(sample);
    };
    theaterGlow = glow;
    // Sample the current frame now so a paused video doesn't start without a glow
    if (video.readyState >= 2) sample();
    else queue();
  }

  // Theater CSS sizes the player box to the video's aspect ratio so controls and rounded corners sit on the video
  let aspectVideo = null;

  function syncVideoAspect() {
    const v = aspectVideo;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const ar = (v.videoWidth / v.videoHeight).toFixed(4);
    const root = document.documentElement;
    if (root.style.getPropertyValue("--yt-deck-video-ar") === ar) return;
    root.style.setProperty("--yt-deck-video-ar", ar);
    // Nudge YouTube's player to re-layout its controls for the new box size
    window.dispatchEvent(new Event("resize"));
  }

  function setupVideoAspect() {
    const video = findVideoElement();
    if (video === aspectVideo) return syncVideoAspect();
    if (aspectVideo) {
      aspectVideo.removeEventListener("loadedmetadata", syncVideoAspect);
      aspectVideo.removeEventListener("resize", syncVideoAspect);
    }
    aspectVideo = video;
    if (!video) return;
    video.addEventListener("loadedmetadata", syncVideoAspect);
    video.addEventListener("resize", syncVideoAspect);
    syncVideoAspect();
  }

  function setupTheaterGlowObserver() {
    setupVideoAspect();
    const flexy = document.querySelector("ytd-watch-flexy");
    if (theaterAttrObs) theaterAttrObs.disconnect();
    if (flexy) {
      theaterAttrObs = new MutationObserver(syncTheaterGlow);
      theaterAttrObs.observe(flexy, { attributes: true, attributeFilter: ["theater", "fullscreen"] });
    }
    syncTheaterGlow();
  }

  /* ── Cleanup on Navigation Away ───────────────────────────────────── */

  function cleanupWatchPage() {
    stopTheaterGlow();
    if (theaterAttrObs) {
      theaterAttrObs.disconnect();
      theaterAttrObs = null;
    }
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
    try {
      document.documentElement.removeAttribute("data-yt-deck-chat");
      document.documentElement.removeAttribute("data-yt-deck-playlist");
      document.documentElement.removeAttribute("data-yt-deck-queue");
    } catch (_) {}
  }

  /* ── YouTube Logo Click to Miniplayer ────────────────────────────── */

  function handleLogoClick(e) {
    if (!currentSettings.enabled) return;

    // Check if clicked target is or is inside YouTube's topbar logo
    const logoLink = e.target.closest("a#logo, ytd-topbar-logo-renderer, a.ytd-topbar-logo-renderer");
    if (!logoLink) return;

    // Let Ctrl/Cmd/Shift-click open Home in a new tab or window as usual
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;

    // Only intercept when watching a video on the watch page
    if (!isWatchPage()) return;

    const video = findVideoElement();
    if (!video || video.ended) return;

    // Prevent default navigation to Home so video is not destroyed
    e.preventDefault();
    e.stopPropagation();

    // main_world.js clicks the miniplayer button (or presses "i"); clicking here too would toggle it twice
    try {
      window.dispatchEvent(new CustomEvent("yt-deck-toggle-miniplayer"));
    } catch (_) {}
  }

  document.addEventListener("click", handleLogoClick, true);

  /* ── Dedicated In-Player PiP Button ───────────────────────────────── */

  function setupPlayerPipButton() {
    try {
      if (!isWatchPage()) return;
      const rightControls = document.querySelector(".ytp-right-controls");
      if (!rightControls) return;

      if (rightControls.querySelector(".ytp-deck-pip-button")) return;

      const pipBtn = document.createElement("button");
      pipBtn.className = "ytp-button ytp-deck-pip-button";
      pipBtn.setAttribute("aria-label", "Picture-in-Picture (Alt+P or Ctrl+Shift+8)");
      pipBtn.setAttribute("title", "Picture-in-Picture (Alt+P / Ctrl+Shift+8)");
      pipBtn.setAttribute("data-tooltip-target-id", "ytp-deck-pip-button");
      pipBtn.style.verticalAlign = "top";
      pipBtn.innerHTML = `
        <svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%" style="pointer-events:none; padding: 6px;">
          <path d="M25,17 L17,17 L17,23 L25,23 L25,17 Z M29,25 L29,11 C29,9.9 28.1,9 27,9 L9,9 C7.9,9 7,9.9 7,11 L7,25 C7,26.1 7.9,27 9,27 L27,27 C28.1,27 29,26.1 29,25 Z M27,25 L9,25 L9,11 L27,11 L27,25 Z" fill="#fff"></path>
        </svg>
      `;

      pipBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePictureInPicture();
      });

      const targetRef =
        rightControls.querySelector(".ytp-miniplayer-button") ||
        rightControls.querySelector(".ytp-size-button") ||
        rightControls.firstElementChild;

      if (targetRef && targetRef.parentElement === rightControls) {
        rightControls.insertBefore(pipBtn, targetRef);
      } else if (targetRef && targetRef.parentElement) {
        targetRef.parentElement.insertBefore(pipBtn, targetRef);
      } else {
        rightControls.appendChild(pipBtn);
      }
    } catch (_) {}
  }

  /* ── Initialization ───────────────────────────────────────────────── */

  let initRaf = null;

  function init() {
    applyClasses();

    if (!isWatchPage()) {
      cleanupWatchPage();
      return;
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }

    setupAutoPip();
    setupPlayerPipButton();
    setupContinuationObserver();
    setupMutationWatcher();
    setupTheaterGlowObserver();
  }

  function scheduleInit() {
    if (initRaf) cancelAnimationFrame(initRaf);
    initRaf = requestAnimationFrame(() => {
      initRaf = null;
      init();
    });
  }

  // Load initial settings and update classes immediately
  try {
    chrome.storage.local
      .get(DEFAULTS)
      .then((result) => {
        currentSettings = { ...DEFAULTS, ...result };
        applyClasses();
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

  document.addEventListener("yt-navigate-finish", scheduleInit);
  document.addEventListener("yt-page-data-updated", scheduleInit);

  /* ── Real-Time Storage Listener ──────────────────────────────────── */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes.enabled !== undefined) {
        currentSettings.enabled = changes.enabled.newValue ?? DEFAULTS.enabled;
      }
      if (changes.hideShorts !== undefined) {
        currentSettings.hideShorts = changes.hideShorts.newValue ?? DEFAULTS.hideShorts;
      }
      if (changes.autoPip !== undefined) {
        currentSettings.autoPip = changes.autoPip.newValue ?? DEFAULTS.autoPip;
      }
      if (changes.pipOnMinimize !== undefined) {
        currentSettings.pipOnMinimize = changes.pipOnMinimize.newValue ?? DEFAULTS.pipOnMinimize;
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
