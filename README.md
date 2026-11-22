# TubeDeck for YouTube

A power-user Chrome & Firefox extension that elevates your YouTube experience with dual-column independent scrolling, YouTube Shorts suppression, invisible scrollbars, and seamless Auto Picture-in-Picture.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)

---

## Features

- **Independent sidebar scrolling** — the suggestions sidebar (right) becomes its own sticky scroll column, while the video and comments (left) scroll with the page. Keeping the video in the page scroll lets the browser use hardware video overlay, so playback stays smooth.
- **Hide Shorts everywhere** (optional, enabled by default) — eliminates YouTube Shorts shelves, feed items, watch recommendations, and navigation drawer links for a distraction-free experience.
- **Hidden scrollbars** (enabled by default) — keep column scrolling completely invisible for a clean, minimalist UI without visual distraction.
- **Picture-in-Picture (PiP) shortcut** — toggle floating PiP mode with an ergonomic shortcut (`Ctrl+Shift+8` global default that works even when the floating PiP window is focused; also supports `Alt+P`, `Alt+Shift+X`, and `Alt+X`).
- **Auto PiP & Minimize PiP** — automatically enters floating PiP mode when switching tabs, minimizing the browser, or switching applications via Alt+Tab. The popup dynamically adapts: on native browsers like Helium, it provides a clean setup card with direct Flag & Site Permission links; on non-native browsers like Brave, it presents interactive toggles.
- **Silky Ambient Lighting Blend & Full Ambilight** (optional, "Ambient glow & glass UI" toggle) — gently morphs YouTube's ambient lighting with smooth 1.2s transitions between scene changes, preventing jarring color flashes.
- **Instant Lightweight Startup** — runs at `document_start` with cached settings for zero-flicker styling and near-zero CPU footprint.
- **Polished theater mode** — no black letterbox bars: the player shrinks to the video with rounded corners and the controls on the video, and the title, description, comments and suggestions sit in one rounded panel. Switching from default view eases the player in.
- **One ambient switch** — the "Ambient glow & glass UI" toggle controls every glow in every mode, including YouTube's own. In theater mode the glow matches the default view in both themes, sampled as an 8×5 colour grid about once a second and crossfaded, so it stays light on the GPU.
- **Logo click to miniplayer** — clicking the YouTube logo while watching a video docks it into YouTube's native miniplayer while taking you to the Home feed, seamlessly preserving playback and ambient glow.
- **Translucent search capsule & button-style glassmorphism** (with the "Ambient glow & glass UI" toggle) — sleek, low-spec hardware optimized translucency matching YouTube's action buttons across the search bar, comments, and sidebar with zero GPU blur penalty.
- **Ultra-compact minimalist popup** — redesigned with instant 0ms opening performance, sleek micro-switches, and zero visual clutter.
- **Theater & fullscreen safe** — the split scroll is automatically disabled in theater mode and fullscreen.
- **Responsive** — narrow viewports (< 1016 px) keep YouTube's default single-column layout.
- **Toolbar toggle** — click the extension icon to configure features instantly with real-time sync across all open YouTube tabs.
- **Infinite scroll preserved** — a content script ensures YouTube's "load more suggestions" still triggers when you scroll inside the sidebar.

---

## Installation (Chrome, Helium, Brave, Edge)

1. Open your browser's extension manager:
   - **Chrome**: `chrome://extensions`
   - **Helium**: `helium://extensions`
   - **Brave**: `brave://extensions`
   - **Edge**: `edge://extensions`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select this directory (`Scroll-Chrome`).
5. TubeDeck is now loaded and active!

---

## Auto Picture-in-Picture Setup (Tab Switch & Alt+Tab)

Chromium enforces two native browser requirements for videos to automatically float into Picture-in-Picture when switching tabs:

### 1. Enable Browser Flag
1. Navigate to: `chrome://flags/#auto-picture-in-picture-for-video-playback` (or `helium://flags` / `brave://flags`).
2. Set **Automatic Picture-in-Picture for video playback** to **Enabled**.
3. Relaunch your browser.

### 2. Allow Site Permission for YouTube (Mandatory for Tab Switch)
1. Open YouTube (`https://www.youtube.com`).
2. Click the **Tune / Site information icon** (sliders or lock icon on the left of the address bar next to the URL).
3. Click **Site settings**.
4. Find **Automatic picture-in-picture** and change it from *Ask* to **Allow**.
   *(Alternatively, visit `chrome://settings/content/autoPictureInPicture` or `helium://settings/content/autoPictureInPicture` and add `https://www.youtube.com` under Allowed).*

Once granted, playback automatically transitions into a floating PiP window on tab switch, window minimize, or Alt+Tab, and returns to the webpage seamlessly when you refocus.

---

## Keyboard Shortcuts & PiP Controls

- **Toggle Picture-in-Picture (Global):** `Ctrl+Shift+8` (works anywhere in the OS, even when the floating PiP window is focused).
- **In-Page Alternate Shortcuts:** `Alt+P`, `Alt+Shift+X`, or `Alt+X`.
- **In-Player Dedicated Button:** Click the custom PiP icon directly inside YouTube's right control bar next to the miniplayer.
- **Dock to Miniplayer:** Click the YouTube logo in the top-left while watching a video to dock playback to the bottom-right miniplayer without losing playback.

---

## Usage

1. Go to any YouTube video page (e.g. `https://www.youtube.com/watch?v=...`).
2. The suggestions sidebar now scrolls independently of the page (video + comments).
3. Click the extension icon in the toolbar to toggle split scrolling, Shorts hiding, full ambient glow and Auto-PiP.

---

## Updating selectors when YouTube changes its DOM

YouTube updates its DOM periodically. All YouTube-specific selectors are documented in two places:

| File | What to update |
|------|----------------|
| [`style.css`](style.css) | CSS selectors in the table at the top of the file |
| [`content.js`](content.js) | JS selectors in the table comment at the top of the file |

### Key selectors to check

| Selector | What it targets |
|----------|-----------------|
| `ytd-watch-flexy` | Main watch-page custom element |
| `ytd-watch-flexy[theater]` | Theater mode attribute |
| `ytd-watch-flexy[fullscreen]` | Fullscreen attribute |
| `#columns` | Flex container holding left and right columns |
| `#primary` | Left column (player, title, description, comments) |
| `#secondary` | Right column (suggested videos, playlists) |
| `ytd-continuation-item-renderer` | Infinite-scroll sentinel in sidebar |
| `--ytd-masthead-height` | CSS variable for header height (default 56px) |

### How to check

1. Open YouTube in Firefox, press `F12` to open DevTools.
2. Use the Inspector to verify the selectors above still exist.
3. If a selector has changed, update it in both `style.css` and `content.js`.

---

## Project structure

```
Scroll/
├── manifest.json          # Extension manifest (MV3, Firefox)
├── style.css              # Core CSS for split scrolling
├── content.js             # Content script: toggle, infinite scroll fix, SPA nav
├── popup/
│   ├── popup.html         # Toolbar popup UI
│   ├── popup.css          # Popup styling
│   └── popup.js           # Popup logic (read/write settings)
├── icons/
│   ├── icon-48.png        # Toolbar icon (48×48)
│   └── icon-96.png        # Toolbar icon (96×96)
└── README.md              # This file
```

---

## Known limitations

- **Infinite scroll**: The fix uses `IntersectionObserver` rooted at `#secondary` plus `MutationObserver` to detect new sentinels. If YouTube changes how it triggers lazy loading (e.g., moves to a scroll-event-based approach), this may need updating.
- **Banners / promos**: The masthead offset uses YouTube's own `--ytd-masthead-height` CSS variable, which should handle promotional banners. If YouTube stops using this variable, the 56px fallback may leave a small gap.
- **Live chat**: On live streams, the chat panel replaces `#secondary`. The extension's CSS still applies, but the chat's own scroll container may interact unexpectedly.

---

## License

MIT
