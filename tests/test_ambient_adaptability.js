const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(workspaceRoot, 'style.css'), 'utf8');
const contentJs = fs.readFileSync(path.join(workspaceRoot, 'content.js'), 'utf8');

const failures = [];

console.log('Testing Ambient Lighting Feathering & UI Adaptability...\n');

// Check 1: Feathered vignette on #cinematics (static ::after overlay, never mask-image)
const vignetteMatch = styleCss.match(/html\.yt-split-scroll\.yt-split-scroll-full-ambient ytd-watch-flexy:not\(\[fullscreen\]\) #cinematics::after(?:,[^{]*)?\s*\{([^}]+)\}/);
if (!vignetteMatch || !vignetteMatch[1].includes('radial-gradient')) {
  failures.push('FAIL: #cinematics lacks the radial-gradient ::after vignette! Causes abrupt, razor-sharp rectangular cuts at the viewport edges.');
}
// A mask on the full-viewport ambient layer costs an extra compositing pass per frame (dropped video frames)
if (/#cinematics[^{]*\{[^}]*mask-image/.test(styleCss)) {
  failures.push('FAIL: mask-image is used on #cinematics; it drops video frames on the full-viewport ambient layer. Use the ::after overlay.');
}

// Check 2: Live chat adaptability in style.css
const hasChatAdaptation = styleCss.includes('data-yt-deck-chat') || (
  styleCss.includes('ytd-watch-flexy') && styleCss.includes('#chat') && styleCss.includes('ytd-live-chat-frame')
);
if (!hasChatAdaptation) {
  failures.push('FAIL: Ambient lighting / UI lacks dynamic adaptability for Live Chat!');
}

// Check 3: Queue & Playlist adaptability in style.css
const hasQueueAdaptation = styleCss.includes('data-yt-deck-queue') && styleCss.includes('data-yt-deck-playlist');
if (!hasQueueAdaptation) {
  failures.push('FAIL: Ambient lighting / UI lacks dedicated adaptability for Queue & Playlists!');
}

// Check 4: Check content.js for dynamic UI state tracking (Chat, Playlist, Queue)
const tracksDynamicUI = contentJs.includes('data-yt-deck-chat') &&
  contentJs.includes('data-yt-deck-playlist') &&
  contentJs.includes('data-yt-deck-queue');
if (!tracksDynamicUI) {
  failures.push('FAIL: content.js does not detect or sync live chat, playlist, and queue state to documentElement!');
}

// Check 5: Chrome Headless Layout & Mask Evaluation
const tempHtmlPath = path.join(workspaceRoot, 'tests', 'temp_ambient_fixture.html');
const fixtureHtml = `<!DOCTYPE html>
<html class="yt-split-scroll yt-split-scroll-full-ambient" data-yt-deck-chat="active" data-yt-deck-playlist="active" data-yt-deck-queue="active">
<head>
  <meta charset="utf-8">
  <style>
    ${styleCss}
  </style>
</head>
<body>
  <ytd-watch-flexy>
    <div id="full-bleed-container">
      <div id="player-container">
        <div id="cinematics">
          <div id="cinematics-container">
            <canvas id="ambient-canvas"></canvas>
          </div>
        </div>
      </div>
    </div>
    <div id="columns">
      <div id="primary"></div>
      <div id="secondary">
        <div id="chat"><ytd-live-chat-frame></ytd-live-chat-frame></div>
        <ytd-playlist-panel-renderer id="playlist" playlist-type="queue">
          <div id="header-contents"></div>
          <div id="items">
            <ytd-playlist-panel-video-renderer selected></ytd-playlist-panel-video-renderer>
          </div>
        </ytd-playlist-panel-renderer>
      </div>
    </div>
  </ytd-watch-flexy>
  <pre id="output"></pre>
  <script>
    const cinematics = document.querySelector('#cinematics');
    const cs = window.getComputedStyle(cinematics);
    const after = window.getComputedStyle(cinematics, '::after');
    const hasMask = after.backgroundImage.includes('radial-gradient') && after.position === 'absolute';

    document.getElementById('output').textContent = JSON.stringify({
      hasMask,
      vignette: after.backgroundImage,
      width: cs.width,
      overflow: cs.overflow
    });
  </script>
</body>
</html>`;

fs.writeFileSync(tempHtmlPath, fixtureHtml);
try {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const stdout = execFileSync(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--dump-dom',
    'file:///' + tempHtmlPath.replace(/\\/g, '/')
  ], { encoding: 'utf8' });

  const match = stdout.match(/<pre id="output">([\s\S]*?)<\/pre>/);
  if (match) {
    const data = JSON.parse(match[1]);
    if (!data.hasMask) {
      failures.push('FAIL: Computed #cinematics::after has no radial-gradient vignette, confirming hard rectangular boundaries in browser rendering.');
    }
  }
} catch (e) {
  failures.push('Headless Chrome execution error: ' + e.message);
} finally {
  try { fs.unlinkSync(tempHtmlPath); } catch (_) {}
}

if (failures.length > 0) {
  console.error('\n[RED] FAILURES DETECTED:');
  failures.forEach(f => console.error('  - ' + f));
  process.exit(1);
} else {
  console.log('\n[GREEN] All ambient adaptability and feathering checks passed!');
  process.exit(0);
}
