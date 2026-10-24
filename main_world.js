/**
 * TubeDeck – Main World Script
 * ============================
 * Runs natively in YouTube's MAIN execution world via manifest.json content_scripts.
 * Connects to the browser's MediaSession API so Chrome and Chromium derivatives (Helium, Brave, etc.)
 * can automatically transition the video into Picture-in-Picture on tab switch / window blur.
 */

(function () {
  "use strict";

  if (window.__tubedeck_main_world_loaded) return;
  window.__tubedeck_main_world_loaded = true;

  function isAutoPipActive() {
    const attr = document.documentElement.getAttribute("data-yt-split-scroll-auto-pip");
    // Default to true before content script sets the attribute
    if (attr === null) return true;
    return attr === "true";
  }

  function findMainVideo() {
    return (
      document.querySelector("#movie_player video") ||
      document.querySelector("ytd-watch-flexy video.html5-main-video") ||
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video")
    );
  }

  function unlockVideo(video) {
    if (!video) return;
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;

      if (isAutoPipActive()) {
        video.autoPictureInPicture = true;
        if (!video.hasAttribute("autopictureinpicture")) {
          video.setAttribute("autopictureinpicture", "");
        }
      }
    } catch (_) {}
  }

  let isPipLockActive = false;

  function triggerSafePiP(source) {
    if (isPipLockActive) return;
    if (!isAutoPipActive()) return;

    const video = findMainVideo();
    if (!video || video.paused || video.ended) return;
    if (document.pictureInPictureElement) return;

    isPipLockActive = true;
    unlockVideo(video);

    video
      .requestPictureInPicture()
      .then(() => {
        console.log("[TubeDeck] PiP entered via " + source);
      })
      .catch((e) => {
        // Silently catch expected gesture or invalid state rejections
      })
      .finally(() => {
        setTimeout(() => {
          isPipLockActive = false;
        }, 500);
      });
  }

  function handleAutoPipEnter(details) {
    if (!isAutoPipActive()) return;
    const video = findMainVideo();
    if (!video || video.paused || video.ended) return;
    if (document.pictureInPictureElement === video) return;

    unlockVideo(video);
    return video.requestPictureInPicture().catch(() => {});
  }

  let originalSetActionHandler = null;
  if ("mediaSession" in navigator && typeof navigator.mediaSession.setActionHandler === "function") {
    originalSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = function (action, handler) {
      if (action === "enterpictureinpicture") {
        if (isAutoPipActive()) {
          // Intercept and preserve our dedicated Picture-in-Picture handler
          return originalSetActionHandler("enterpictureinpicture", handleAutoPipEnter);
        }
      }
      return originalSetActionHandler(action, handler);
    };
  }

  function registerMediaSession() {
    if (!("mediaSession" in navigator) || !originalSetActionHandler) {
      return;
    }

    try {
      if (isAutoPipActive()) {
        originalSetActionHandler("enterpictureinpicture", handleAutoPipEnter);
        const video = findMainVideo();
        if (video) unlockVideo(video);
      } else {
        originalSetActionHandler("enterpictureinpicture", null);
      }
    } catch (_) {}
  }

  function isFullAmbientActive() {
    return document.documentElement.getAttribute("data-yt-split-scroll-full-ambient") === "true";
  }

  function ensureCinematicsEnabled() {
    if (!isFullAmbientActive()) return;

    try {
      const player =
        document.getElementById("movie_player") ||
        document.querySelector(".html5-video-player");

      if (player && typeof player.setOption === "function") {
        player.setOption("cinematics", "enabled", true);
      }
    } catch (_) {}
  }

  let lastHookCheck = 0;

  // Hook playback events on active video to continuously guarantee autoPictureInPicture
  function hookVideoEvents() {
    const video = findMainVideo();
    if (!video) return;

    unlockVideo(video);

    if (!video._deckAutoPipHooked) {
      video._deckAutoPipHooked = true;
      video.addEventListener("play", () => unlockVideo(video), { passive: true });
      video.addEventListener("playing", () => unlockVideo(video), { passive: true });
      video.addEventListener("loadedmetadata", () => unlockVideo(video), { passive: true });
      video.addEventListener("canplay", () => unlockVideo(video), { passive: true });
      video.addEventListener(
        "timeupdate",
        () => {
          const now = Date.now();
          if (now - lastHookCheck > 2500) {
            lastHookCheck = now;
            if (isAutoPipActive()) {
              unlockVideo(video);
              registerMediaSession();
            }
          }
        },
        { passive: true }
      );
    }
  }

  function refreshPipState() {
    registerMediaSession();
    ensureCinematicsEnabled();
    const video = findMainVideo();
    if (video) {
      unlockVideo(video);
      hookVideoEvents();
    }
  }

  // When PiP exits (e.g. user focused back to YouTube window), YouTube's player runs cleanup
  // Re-arm MediaSession and unlock video immediately and with short debounces
  document.addEventListener(
    "leavepictureinpicture",
    () => {
      refreshPipState();
      setTimeout(refreshPipState, 60);
      setTimeout(refreshPipState, 350);
    },
    true
  );

  window.addEventListener("focus", () => {
    refreshPipState();
  });

  window.addEventListener("yt-deck-rearm-pip", () => {
    refreshPipState();
  });

  // Watch for dynamic video element insertion from YouTube's player engine
  const domVideoObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.nodeName === "VIDEO") {
          unlockVideo(node);
          hookVideoEvents();
        } else if (node.firstElementChild) {
          const v = node.querySelector("video");
          if (v) {
            unlockVideo(v);
            hookVideoEvents();
          }
        }
      }
    }
  });

  const attachObserver = () => {
    if (document.body) {
      domVideoObserver.observe(document.body, { childList: true, subtree: true });
    }
  };

  if (document.body) {
    attachObserver();
  } else {
    document.addEventListener("DOMContentLoaded", attachObserver, { once: true });
  }

  // React to attribute changes from content script
  const observer = new MutationObserver(() => {
    registerMediaSession();
    ensureCinematicsEnabled();
    hookVideoEvents();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-yt-split-scroll-auto-pip",
      "data-yt-split-scroll-full-ambient",
    ],
  });

  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(() => {
      registerMediaSession();
      ensureCinematicsEnabled();
      hookVideoEvents();
    }, 400);
  });

  // Handle Alt+Tab / Window Blur safely from main execution context
  window.addEventListener("blur", () => {
    triggerSafePiP("window-blur");
  });

  // Listen for logo click request from content script to trigger native miniplayer
  window.addEventListener("yt-deck-toggle-miniplayer", () => {
    try {
      const miniBtn =
        document.querySelector(".ytp-miniplayer-button") ||
        document.querySelector("button[data-tooltip-target-id='ytp-miniplayer-button']") ||
        document.querySelector(".ytp-button.ytp-miniplayer-button");

      if (miniBtn) {
        miniBtn.click();
        return;
      }

      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          code: "KeyI",
          keyCode: 73,
          which: 73,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch (_) {}
  });

  // Listen for trigger PiP request from content script or background worker
  window.addEventListener("yt-deck-trigger-pip", () => {
    triggerSafePiP("extension-trigger");
  });

  registerMediaSession();
  ensureCinematicsEnabled();
  hookVideoEvents();
})();
