const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const styleCss = fs.readFileSync(path.join(workspaceRoot, 'style.css'), 'utf8');

const htmlContent = `<!DOCTYPE html>
<html class="yt-split-scroll">
<head>
  <meta charset="utf-8">
  <style>
    /* Modern YouTube Lockup / Thumbnail View Model */
    yt-thumbnail-view-model {
      display: block;
      position: relative;
      width: 360px;
      aspect-ratio: 16 / 9;
    }
    yt-thumbnail-view-model img {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    #dismissible.ytd-video-renderer {
      display: flex;
      flex-direction: row;
    }
    ytd-video-renderer ytd-thumbnail.ytd-video-renderer {
      display: block;
      position: relative;
      flex: none;
      width: 360px;
    }
    ytd-thumbnail::before {
      display: block;
      content: "";
      padding-top: 56.25%;
    }
    ytd-thumbnail a#thumbnail {
      display: block;
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
    }
    yt-image {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
    yt-image img, .yt-core-image {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  </style>
  <style>
    /* Extension stylesheet */
    ${styleCss}
  </style>
</head>
<body>
  <ytd-search>
    <div id="contents">
      <ytd-video-renderer>
        <div id="dismissible" class="style-scope ytd-video-renderer">
          <ytd-thumbnail id="thumbnail" class="style-scope ytd-video-renderer">
            <a id="thumbnail" class="style-scope ytd-thumbnail" href="/watch?v=123">
              <yt-image class="style-scope ytd-thumbnail">
                <img id="test-img" class="yt-core-image" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">
              </yt-image>
            </a>
          </ytd-thumbnail>
          <div class="text-wrapper">
            <h3><a id="video-title">Mr Huzoor boss</a></h3>
          </div>
        </div>
      </ytd-video-renderer>
    </div>
  </ytd-search>
  <pre id="output"></pre>
  <script>
    const thumb = document.querySelector('ytd-thumbnail');
    const link = document.querySelector('a#thumbnail');
    const img = document.querySelector('#test-img');
    const beforeStyle = window.getComputedStyle(thumb, '::before');

    const thumbRect = thumb.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();

    const result = {
      thumbnail: {
        width: thumbRect.width,
        height: thumbRect.height,
        computedHeight: window.getComputedStyle(thumb).height
      },
      link: {
        width: linkRect.width,
        height: linkRect.height
      },
      image: {
        width: imgRect.width,
        height: imgRect.height,
        position: window.getComputedStyle(img).position
      },
      before: {
        position: beforeStyle.position,
        width: beforeStyle.width,
        height: beforeStyle.height,
        paddingTop: beforeStyle.paddingTop
      }
    };
    document.getElementById('output').textContent = JSON.stringify(result, null, 2);
  </script>
</body>
</html>`;

const tempHtmlPath = path.join(workspaceRoot, 'tests', 'temp_search_fixture.html');
fs.writeFileSync(tempHtmlPath, htmlContent);

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let stdout = '';
try {
  stdout = execFileSync(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--window-size=1920,1080',
    '--dump-dom',
    'file:///' + tempHtmlPath.replace(/\\/g, '/')
  ], { encoding: 'utf8' });
} finally {
  try { fs.unlinkSync(tempHtmlPath); } catch (_) {}
}

const match = stdout.match(/<pre id="output">([\s\S]*?)<\/pre>/);
if (match) {
  const result = JSON.parse(match[1]);
  console.log('MEASURED SEARCH THUMBNAIL LAYOUT:');
  console.log(JSON.stringify(result, null, 2));

  // Assertions for healthy search thumbnail:
  // 1. Thumbnail height should be approximately 360 * 0.5625 = 202.5px
  // 2. Link height should match thumbnail height (> 150px)
  // 3. Image height should match thumbnail height (> 150px)
  // 4. Before pseudo-element should NOT override intrinsic padding-top
  const failures = [];
  if (result.thumbnail.height < 100) {
    failures.push(`Thumbnail collapsed! Height is ${result.thumbnail.height}px (expected ~202.5px)`);
  }
  if (result.link.height < 100) {
    failures.push(`Clickable link collapsed! Height is ${result.link.height}px (expected ~202.5px)`);
  }
  if (result.image.height < 100) {
    failures.push(`Image collapsed! Height is ${result.image.height}px (expected ~202.5px)`);
  }
  if (result.before.position === 'absolute') {
    failures.push(`::before pseudo-element forced to absolute, destroying YouTube aspect ratio!`);
  }

  if (failures.length > 0) {
    console.error('\n[RED] FAILURES DETECTED:');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  } else {
    console.log('\n[GREEN] Search thumbnail layout is intact!');
    process.exit(0);
  }
} else {
  console.error('Could not parse output from Chrome headless');
  process.exit(1);
}
