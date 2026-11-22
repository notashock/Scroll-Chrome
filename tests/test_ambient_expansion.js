const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(workspaceRoot, 'style.css'), 'utf8');

const failures = [];

console.log('Testing Ambient Expansion to Header and Full Page Layout...\n');

// Check 1: Header (masthead) transparency in style.css
const hasMastheadTransparency = (
  styleCss.includes('#masthead-container') || styleCss.includes('ytd-masthead')
) && (
  styleCss.match(/ytd-masthead[^{]*\{[^}]*background:\s*transparent/i) ||
  styleCss.match(/#masthead-container[^{]*\{[^}]*background:\s*(?:transparent|linear-gradient)/i) ||
  styleCss.match(/ytd-masthead[^{]*\{[^}]*background:\s*rgba/i) ||
  styleCss.match(/#masthead-container[^{]*\{[^}]*background:\s*rgba/i)
);

if (!hasMastheadTransparency) {
  failures.push('FAIL: #masthead-container / ytd-masthead is not styled with transparent/translucent background, blocking ambient light from expanding behind the header.');
}

// Check 2: #cinematics viewport-wide fixed coverage (not trapped in #player-container)
const cinematicsFixedRule = styleCss.match(/html\.yt-split-scroll[^{]*#cinematics(?:,[^{]*)?\s*\{([^}]+)\}/);
const isCinematicsFixed = styleCss.includes('position: fixed') && styleCss.includes('width: 100vw') && styleCss.includes('height: 100vh');

// Specifically check if default ambient mode keeps #cinematics trapped without position: fixed
const defaultCinematicsTrap = styleCss.match(/html\.yt-split-scroll\.yt-split-scroll-full-ambient ytd-watch-flexy:not\(\[fullscreen\]\) #cinematics(?:,[^{]*)?\s*\{([^}]+)\}/);
if (!defaultCinematicsTrap || !defaultCinematicsTrap[1].includes('position: fixed')) {
  failures.push('FAIL: Default ambient mode traps #cinematics inside #player-container (lacks position: fixed), reserving ambient light strictly to the video player area.');
}

// Check 3: Headless Chrome Layout & Stacking Context
const tempHtmlPath = path.join(workspaceRoot, 'tests', 'temp_expansion_fixture.html');
const fixtureHtml = `<!DOCTYPE html>
<html class="yt-split-scroll yt-split-scroll-full-ambient yt-deck-watch" dark>
<head>
  <meta charset="utf-8">
  <style>
    /* Native YouTube masthead base */
    #masthead-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 56px;
      z-index: 2020;
      background: #0f0f0f;
    }
    ytd-masthead {
      display: block;
      height: 100%;
      background: #0f0f0f;
    }
    /* Extension style */
    ${styleCss}
  </style>
</head>
<body>
  <div id="masthead-container">
    <ytd-masthead id="masthead">
      <div id="background"></div>
      <div id="container"></div>
    </ytd-masthead>
  </div>
  <ytd-watch-flexy>
    <!-- Real YouTube nesting: #cinematics lives inside #primary, the left scroll column -->
    <div id="columns">
      <div id="primary">
        <div id="primary-inner">
          <div id="player">
            <div id="cinematics">
              <div id="cinematics-container">
                <canvas id="ambient-canvas"></canvas>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="secondary"></div>
    </div>
  </ytd-watch-flexy>
  <pre id="output"></pre>
  <script>
    const mastheadBox = document.querySelector('#masthead-container');
    const masthead = document.querySelector('ytd-masthead');
    const cinematics = document.querySelector('#cinematics');
    
    const csMastheadBox = window.getComputedStyle(mastheadBox);
    const csMasthead = window.getComputedStyle(masthead);
    const csCinematics = window.getComputedStyle(cinematics);

    document.getElementById('output').textContent = JSON.stringify({
      mastheadBoxBg: csMastheadBox.backgroundColor,
      mastheadBg: csMasthead.backgroundColor,
      cinematicsPosition: csCinematics.position,
      cinematicsTop: csCinematics.top,
      cinematicsHeight: csCinematics.height,
      cinematicsZIndex: csCinematics.zIndex,
      cinematicsRect: cinematics.getBoundingClientRect().toJSON()
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
    console.log('COMPUTED LAYOUT DATA:');
    console.log(JSON.stringify(data, null, 2));

    if (data.mastheadBoxBg === 'rgb(15, 15, 15)' || data.mastheadBg === 'rgb(15, 15, 15)') {
      failures.push('FAIL: Header masthead background is opaque rgb(15, 15, 15), completely blocking ambient light.');
    }
    if (data.cinematicsPosition !== 'fixed') {
      failures.push('FAIL: #cinematics is position: ' + data.cinematicsPosition + ' (expected fixed), trapping ambient light inside the video section.');
    }
    // An ancestor with contain/transform becomes the containing block and pins the glow below the header
    const r = data.cinematicsRect;
    if (r.top !== 0 || r.left !== 0 || r.width < 1900) {
      failures.push('FAIL: #cinematics is clipped to an ancestor box (top ' + r.top + ', left ' + r.left + ', width ' + r.width + ') instead of covering the viewport.');
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
  console.log('\n[GREEN] Ambient light expands across the header and full viewport!');
  process.exit(0);
}
