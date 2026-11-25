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

  /* ── Ambient Glow (one engine for default and theater view) ─────── */

  // A full-window wash of the video's colours, drawn by TubeDeck in every view and both themes
  // (YouTube's own ambient layer is hidden: it is boxed in theater and freezes in the light theme).
  // GPU budget, since the video itself can saturate weak GPUs at 4K:
  // - The video is averaged down to an 8x5 colour grid in WebGL (texture mipmaps). A 2D-canvas
  //   drawImage forces a GPU->CPU readback of the frame instead (~40% dropped frames at 4K60).
  // - Every change to the glow makes the compositor redraw the whole window under the video, so it
  //   changes rarely: one sample every 2s, eased in with 8 steps (~4 redraws/s, not one per frame).
  // - The final pass bakes opacity, the 1.25x spread and the edge fade into one opaque canvas, so the
  //   glow is a single opaque layer: no translucent canvas and no separate vignette layer to blend.
  const GLOW_W = 8;
  const GLOW_H = 5;
  const GLOW_OUT_W = 64; // visible canvas: enough texels for a smooth edge fade once CSS stretches it
  const GLOW_OUT_H = 36;
  const GLOW_INTERVAL_MS = 2000;
  const GLOW_STEP_MS = 100;
  const GLOW_STEPS = 8;
  const GLOW_STEP_K = 0.3; // 8 steps of 30% reach ~94% of the new colours in 0.8s

  const GLOW_VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  // mode 0: a sampled at mip level lod (flipped for the top-down video) and graded into an ambient
  //         tint (saturated, then dimmed on dark / lifted towards white on light), blended with b by k.
  // mode 1: present: spread (zoom), mix over the page colour at the ambient opacity, then the edge
  //         fade that used to be a CSS radial-gradient (ellipse 100% 90% at 50% 35%).
  const GLOW_FS = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D a; uniform sampler2D b;
uniform float k; uniform float lod; uniform float flip; uniform float light; uniform float mode;
uniform float zoom; uniform float opacity; uniform vec3 bg;
out vec4 o;
void main() {
  if (mode > 0.5) {
    vec3 g = texture(a, (uv - 0.5) / zoom + 0.5).rgb;
    vec3 c = mix(bg, g, opacity);
    float t = length((uv - vec2(0.5, 0.65)) / vec2(1.0, 0.9));
    float v = t < 0.75 ? smoothstep(0.45, 0.75, t) * 0.25 : 0.25 + 0.75 * clamp((t - 0.75) / 0.25, 0.0, 1.0);
    o = vec4(mix(c, bg, v), 1.0);
    return;
  }
  vec4 ca = textureLod(a, flip > 0.5 ? vec2(uv.x, 1.0 - uv.y) : uv, lod);
  if (flip > 0.5) {
    float l = dot(ca.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 c = clamp(mix(vec3(l), ca.rgb, 1.35), 0.0, 1.0);
    ca.rgb = light > 0.5 ? mix(c, vec3(1.0), 0.45) : c * 0.55;
  }
  o = mix(ca, texture(b, uv), k);
}`;

  let ambientGlow = null;
  let glowAttrObs = null;

  function stopAmbientGlow() {
    if (!ambientGlow) return;
    const { video, handle, timer, stepTimer, el, gl } = ambientGlow;
    clearTimeout(timer);
    clearTimeout(stepTimer);
    try { video.cancelVideoFrameCallback(handle); } catch (_) {}
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (_) {} // free the video texture now
    el.remove();
    ambientGlow = null;
  }

  // Page colour, spread and opacity come from CSS so the glow follows the theme and chat/playlist
  function readGlowStyle() {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const rgb = (cs.backgroundColor.match(/[\d.]+/g) || []).slice(0, 3).map((n) => Number(n) / 255);
    const dark = root.hasAttribute("dark");
    return {
      light: dark ? 0 : 1,
      bg: rgb.length === 3 ? rgb : dark ? [15 / 255, 15 / 255, 15 / 255] : [1, 1, 1],
      zoom: parseFloat(cs.getPropertyValue("--yt-deck-glow-zoom")) || 1.25,
      opacity: parseFloat(cs.getPropertyValue("--yt-deck-ambient-opacity")) || 0.85,
    };
  }

  function createGlowRenderer(canvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power",
    });
    if (!gl) return null;
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, GLOW_VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, GLOW_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u = (name) => gl.getUniformLocation(prog, name);
    const uK = u("k"), uLod = u("lod"), uFlip = u("flip"), uLight = u("light"), uMode = u("mode");
    const uZoom = u("zoom"), uOpacity = u("opacity"), uBg = u("bg");
    gl.uniform1i(u("a"), 0);
    gl.uniform1i(u("b"), 1);

    const texture = (minFilter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    // 8x5 render targets: the newest sample, and a ping-pong pair for the eased, displayed colours
    const target = () => {
      const t = texture(gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GLOW_W, GLOW_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { t, fb };
    };
    const videoTex = texture(gl.LINEAR_MIPMAP_LINEAR);
    const latest = target();
    const shown = [target(), target()];
    let cur = 0;
    let primed = false;

    const pass = (fb, a, b, k, lod, flip) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, GLOW_W, GLOW_H);
      gl.uniform1f(uMode, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, b);
      gl.uniform1f(uK, k);
      gl.uniform1f(uLod, lod);
      gl.uniform1f(uFlip, flip);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    // Draw the eased colours to the visible (opaque) canvas with spread, opacity and edge fade
    const present = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, GLOW_OUT_W, GLOW_OUT_H);
      gl.uniform1f(uMode, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shown[cur].t);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, shown[cur].t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    return {
      gl,
      // Upload the current frame and average it down to 8x5 on the GPU (never read back)
      sample(video) {
        const style = readGlowStyle();
        gl.uniform1f(uLight, style.light);
        gl.uniform3f(uBg, style.bg[0], style.bg[1], style.bg[2]);
        gl.uniform1f(uZoom, style.zoom);
        gl.uniform1f(uOpacity, style.opacity);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, videoTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.generateMipmap(gl.TEXTURE_2D);
        const lod = Math.log2(Math.max(video.videoWidth / GLOW_W, video.videoHeight / GLOW_H, 1));
        // b is unused at k=0 but must not be latest.t: sampling the texture being rendered into is a
        // feedback loop that WebGL rejects (INVALID_OPERATION, black glow)
        pass(latest.fb, videoTex, videoTex, 0, lod, 1);
        if (!primed) {
          primed = true;
          pass(shown[cur].fb, latest.t, latest.t, 0, 0, 0);
          present();
        }
      },
      // One easing step towards the newest sample, then draw it to the visible canvas
      step() {
        pass(shown[1 - cur].fb, shown[cur].t, latest.t, GLOW_STEP_K, 0, 0);
        cur = 1 - cur;
        present();
      },
    };
  }

  function syncAmbientGlow() {
    const flexy = document.querySelector("ytd-watch-flexy");
    const video = findVideoElement();
    const wanted = Boolean(
      currentSettings.enabled && currentSettings.fullAmbient && isWatchPage() &&
      flexy && video && typeof video.requestVideoFrameCallback === "function" &&
      !flexy.hasAttribute("fullscreen")
    );
    if (!wanted) return stopAmbientGlow();
    if (ambientGlow && ambientGlow.video === video && ambientGlow.el.parentNode === flexy) return;

    stopAmbientGlow();
    // Lives in the flexy, not the theater box, whose size containment would trap a position: fixed child
    const el = document.createElement("div");
    el.id = "yt-deck-glow";
    const canvas = document.createElement("canvas");
    canvas.width = GLOW_OUT_W;
    canvas.height = GLOW_OUT_H;
    const renderer = createGlowRenderer(canvas);
    if (!renderer) return; // no WebGL2: no glow rather than the stuttering 2D readback path
    el.append(canvas);
    flexy.prepend(el);

    const glow = { el, video, gl: renderer.gl, handle: 0, timer: 0, stepTimer: 0, steps: 0 };
    const ease = () => {
      glow.stepTimer = 0;
      if (ambientGlow !== glow) return;
      renderer.step();
      if (--glow.steps > 0) glow.stepTimer = setTimeout(ease, GLOW_STEP_MS);
    };
    // Wait for the next presented frame (a paused video presents none, so nothing runs), then sample
    const sample = () => {
      if (ambientGlow !== glow) return;
      try {
        renderer.sample(video);
        glow.steps = GLOW_STEPS;
        if (!glow.stepTimer) glow.stepTimer = setTimeout(ease, GLOW_STEP_MS);
      } catch (_) {} // e.g. a non-CORS video source
      glow.timer = setTimeout(queue, GLOW_INTERVAL_MS);
    };
    const queue = () => {
      if (ambientGlow === glow) glow.handle = video.requestVideoFrameCallback(sample);
    };
    canvas.addEventListener("webglcontextlost", () => { if (ambientGlow === glow) stopAmbientGlow(); });
    ambientGlow = glow;
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

  function setupAmbientGlowObserver() {
    setupVideoAspect();
    const flexy = document.querySelector("ytd-watch-flexy");
    if (glowAttrObs) glowAttrObs.disconnect();
    if (flexy) {
      glowAttrObs = new MutationObserver(syncAmbientGlow);
      glowAttrObs.observe(flexy, { attributes: true, attributeFilter: ["fullscreen"] });
    }
    syncAmbientGlow();
  }

  /* ── Cleanup on Navigation Away ───────────────────────────────────── */

  function cleanupWatchPage() {
    stopAmbientGlow();
    if (glowAttrObs) {
      glowAttrObs.disconnect();
      glowAttrObs = null;
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
    setupAmbientGlowObserver();
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
