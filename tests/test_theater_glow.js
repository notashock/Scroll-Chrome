// Theater mode with the ambient toggle on: TubeDeck's glow (content.js #yt-deck-theater-glow) must match the
// default-view ambient glow (full window, 1.25x scale, edge fade, 0.85 opacity) in both themes, with the
// player fitted to the video. Headless Chrome: `node tests/test_theater_glow.js`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(workspaceRoot, 'style.css'), 'utf8');
const contentJs = fs.readFileSync(path.join(workspaceRoot, 'content.js'), 'utf8');
const failures = [];

if (!contentJs.includes('yt-deck-theater-glow') || !contentJs.includes('requestVideoFrameCallback')) {
  failures.push('FAIL: content.js does not create the frame-driven #yt-deck-theater-glow canvas.');
}
// Default view: YouTube positions #player-container absolute inside a padded aspect box, so forcing a
// position on it (outside theater, where it is pinned back to absolute) collapses the video to 0px.
for (const [, selectors, body] of styleCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const repositioned = selectors.split(',').some((sel) => /#player-container(?!-)/.test(sel) && !sel.includes('[theater]'));
  if (repositioned && /(^|;|\s)position\s*:/.test(body)) {
    failures.push('FAIL: a rule forces position on #player-container in default view; the video collapses to 0px.');
  }
}
// Every sample reads the full video frame back from the GPU; more than ~1/s stutters 1080p/4K playback
const interval = Number((contentJs.match(/GLOW_INTERVAL_MS = (\d+)/) || [])[1]);
if (!(interval >= 1000)) failures.push(`FAIL: theater glow samples every ${interval}ms; GPU readbacks that often stutter playback.`);
// Ambient toggle off = no glow anywhere, including YouTube's own
if (!/html\.yt-split-scroll:not\(\.yt-split-scroll-full-ambient\) ytd-watch-flexy #cinematics\s*\{[^}]*display:\s*none/.test(styleCss)) {
  failures.push('FAIL: YouTube own ambient glow still shows with the ambient toggle off.');
}
if (!/GLOW_W = 8;/.test(contentJs)) {
  failures.push('FAIL: theater glow samples more than an 8x5 grid; it reads as a second video instead of ambient colour.');
}
if (/yt-deck-theater-glow[^{]*\{[^}]*(filter:\s*blur|mask-image)/.test(styleCss)) {
  failures.push('FAIL: theater glow uses blur/mask; the 32x18 upscale is the blur, extra passes drop frames.');
}

const GLOW = '<div id="yt-deck-theater-glow"><canvas width="32" height="18"></canvas></div>';

function render(dark, ambient = true) {
  const html = `<!DOCTYPE html>
<html class="yt-split-scroll ${ambient ? 'yt-split-scroll-full-ambient' : ''} yt-deck-watch" ${dark ? 'dark' : ''}>
<head><meta charset="utf-8"><style>
  #full-bleed-container { position: relative; height: 600px; background: #000; overflow: clip; }
  #cinematics { position: absolute; inset: 0; }
  #player-full-bleed-container { position: relative; height: 100%; }
  #player-container { position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; }
  html { --yt-deck-video-ar: 1.3333; }
  ${styleCss}
  /* Measure the settled layout, not the first frame of the entry animation */
  *, *::after { animation: none !important; }
</style></head>
<body>
  <ytd-watch-flexy theater>
    ${GLOW}
    <div id="full-bleed-container">
      <div id="player-full-bleed-container"><div id="cinematics-full-bleed-container"><div id="cinematics"></div></div>
        <div id="player-container"><div id="movie_player"></div></div></div>
    </div>
    <div id="columns"><div id="primary"><ytd-watch-metadata>t</ytd-watch-metadata></div><div id="secondary"></div></div>
  </ytd-watch-flexy>
  <pre id="output"></pre>
  <script>
    const host = document.querySelector('#full-bleed-container');
    const glow = document.querySelector('#yt-deck-theater-glow');
    const g = getComputedStyle(glow), h = host.getBoundingClientRect(), r = glow.getBoundingClientRect();
    document.getElementById('output').textContent = JSON.stringify({
      hostBg: getComputedStyle(host).backgroundColor,
      cinematicsDisplay: getComputedStyle(document.querySelector('#cinematics')).display,
      glowPosition: g.position,
      glowDisplay: g.display,
      glowOpacity: g.opacity,
      fillsBox: r.width === h.width && r.height === h.height,
      fillsWindow: r.top === 0 && r.left === 0 && r.width === innerWidth && r.height === innerHeight,
      vignette: getComputedStyle(glow, '::after').backgroundImage.includes('radial-gradient'),
      columnsZ: getComputedStyle(document.querySelector('#columns')).zIndex,
      canvasTransform: getComputedStyle(glow.querySelector('canvas')).transform,
      player: (() => { const p = document.querySelector('#player-container'), b = p.getBoundingClientRect();
        return { top: Math.round(b.top - h.top), bottom: Math.round(h.bottom - b.bottom), w: Math.round(b.width), h: Math.round(b.height),
          centered: Math.abs((b.left - h.left) - (h.right - b.right)) < 1, radius: getComputedStyle(p).borderTopLeftRadius }; })(),
      columnsRadius: getComputedStyle(document.querySelector('#columns')).borderTopLeftRadius,
      columnsBg: getComputedStyle(document.querySelector('#columns')).backgroundColor
    });
  </script>
</body></html>`;
  const file = path.join(workspaceRoot, 'tests', `temp_theater_${dark ? 'dark' : 'light'}_${ambient ? 'amb' : 'off'}.html`);
  fs.writeFileSync(file, html);
  try {
    const stdout = execFileSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1920,1080', '--dump-dom',
      'file:///' + file.replace(/\\/g, '/')
    ], { encoding: 'utf8' });
    const m = stdout.match(/<pre id="output">([\s\S]*?)<\/pre>/);
    return m ? JSON.parse(m[1]) : null;
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// Both themes: the same full-window glow as the default view, behind a see-through theater box
for (const dark of [true, false]) {
  const theme = dark ? 'dark' : 'light';
  try {
    const d = render(dark);
    console.log(theme, JSON.stringify(d));
    if (!d) { failures.push(`FAIL (${theme}): no output from headless Chrome.`); continue; }
    if (d.hostBg !== 'rgba(0, 0, 0, 0)') failures.push(`FAIL (${theme}): theater box background ${d.hostBg} hides the glow.`);
    if (d.cinematicsDisplay !== 'none') failures.push(`FAIL (${theme}): YouTube #cinematics still paints over the theater bars.`);
    if (d.glowPosition !== 'fixed' || !d.fillsWindow) failures.push(`FAIL (${theme}): glow does not cover the whole window.`);
    if (!d.vignette) failures.push(`FAIL (${theme}): glow has no edge-fade vignette.`);
    if (d.columnsZ !== '1') failures.push(`FAIL (${theme}): title/suggestions panel is not layered above the glow (z ${d.columnsZ}).`);
    // Same 1.25x spread as the default-view #cinematics canvas
    if (!d.canvasTransform.startsWith('matrix(1.25, 0, 0, 1.25,')) failures.push(`FAIL (${theme}): glow scale ${d.canvasTransform} differs from the default view.`);
    // 600px box, 10px gaps -> 580px tall player at 4:3 = 773px wide, centred, rounded
    const p = d.player;
    if (p.top !== 10 || p.bottom !== 10 || p.h !== 580 || Math.abs(p.w - 773) > 1 || !p.centered) {
      failures.push(`FAIL (${theme}): theater player is not fitted to the video with 10px gaps: ${JSON.stringify(p)}.`);
    }
    if (p.radius !== '12px') failures.push(`FAIL (${theme}): theater player corners are not rounded (${p.radius}).`);
    // Title, description, comments and suggestions share one rounded, tinted panel
    if (d.columnsRadius !== '16px') failures.push(`FAIL (${theme}): #columns panel is not rounded (${d.columnsRadius}).`);
    if (d.columnsBg === 'rgba(0, 0, 0, 0)') failures.push(`FAIL (${theme}): #columns panel has no tint, so its rounding is invisible.`);
    if (d.glowOpacity !== '0.85') failures.push(`FAIL (${theme}): glow opacity ${d.glowOpacity}, expected the default-view 0.85.`);
  } catch (e) {
    failures.push(`Headless Chrome execution error (${theme}): ${e.message}`);
  }
}

// Ambient toggle off: theater keeps the fitted, rounded, bar-free layout but shows no glow
try {
  const d = render(true, false);
  console.log('ambient off', JSON.stringify(d));
  if (d.hostBg !== 'rgba(0, 0, 0, 0)') failures.push(`FAIL (ambient off): theater box shows a ${d.hostBg} background (black bars).`);
  if (d.glowDisplay !== 'none') failures.push('FAIL (ambient off): the glow shows although the ambient toggle is off.');
  if (d.cinematicsDisplay !== 'none') failures.push('FAIL (ambient off): YouTube own glow shows although the ambient toggle is off.');
  if (d.player.radius !== '12px' || d.player.h !== 580) failures.push('FAIL (ambient off): theater player is not fitted and rounded.');
} catch (e) {
  failures.push('Headless Chrome execution error (ambient off): ' + e.message);
}

if (failures.length) {
  console.error('\n[RED] FAILURES DETECTED:');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n[GREEN] Theater mode uses the default-view ambient glow in dark and light themes!');
