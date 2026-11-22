// Unit checks for background.js helpers: parseShortcutString (feeds the in-page PiP shortcut)
// and isYouTubeUrl (decides which tabs get Auto-PiP messages). Runs background.js in a sandbox
// with a stub `chrome` object, so no browser is needed: `node tests/test_shortcut_parser.js`.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Any chrome.* property chain resolves to a no-op callable (addListener, query, ...)
const stub = new Proxy(function () {}, {
  get: (_, key) => (key === 'then' ? undefined : stub),
  apply: () => stub,
});

const sandbox = { chrome: stub, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), sandbox);
const { parseShortcutString, isYouTubeUrl } = sandbox;

const pick = (o) => ({ key: o.key, code: o.code, altKey: o.altKey, ctrlKey: o.ctrlKey, shiftKey: o.shiftKey, metaKey: o.metaKey });

assert.deepStrictEqual(pick(parseShortcutString('Ctrl+Shift+8')),
  { key: '8', code: 'Digit8', altKey: false, ctrlKey: true, shiftKey: true, metaKey: false });
assert.deepStrictEqual(pick(parseShortcutString('Alt+P')),
  { key: 'p', code: 'KeyP', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false });
assert.deepStrictEqual(pick(parseShortcutString('Command+Shift+Up')),
  { key: 'up', code: 'ArrowUp', altKey: false, ctrlKey: false, shiftKey: true, metaKey: true });
assert.strictEqual(parseShortcutString('MacCtrl+F12').code, 'F12');
assert.strictEqual(parseShortcutString('MacCtrl+F12').ctrlKey, true);
assert.strictEqual(parseShortcutString(''), null);
assert.strictEqual(parseShortcutString(undefined), null);

assert.strictEqual(isYouTubeUrl('https://www.youtube.com/watch?v=abc'), true);
assert.strictEqual(isYouTubeUrl('https://m.youtube.com/'), true);
assert.strictEqual(isYouTubeUrl('https://www.google.com/search?q=youtube.com'), false);
assert.strictEqual(isYouTubeUrl('https://notyoutube.com/'), false);
assert.strictEqual(isYouTubeUrl(undefined), false);

console.log('[GREEN] Shortcut parser and YouTube URL checks passed!');
