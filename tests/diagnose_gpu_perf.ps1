# GPU & Performance Regression Test Suite for TubeDeck
# Tests multi-tier GPU-safe blur scaling, hardware detection, and resource safety

$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$stylePath = Join-Path $workspaceRoot "style.css"
$contentPath = Join-Path $workspaceRoot "content.js"
$mainWorldPath = Join-Path $workspaceRoot "main_world.js"
$manifestPath = Join-Path $workspaceRoot "manifest.json"
$popupJsPath = Join-Path $workspaceRoot "popup\popup.js"

$failures = @()

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " TubeDeck Multi-Tier GPU-Safe Blur & Resource Test Suite  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Check 1: DirectComposition & Hardware Overlay Integrity
Write-Host "`n[Check 1] Verifying video element layer compositing..." -NoNewline
$styleContent = Get-Content -Raw $stylePath
if ($styleContent -match 'ytd-watch-flexy\s+#movie_player\s+video[\s\S]*?transform:\s*translateZ' -or 
    $styleContent -match 'video\.html5-main-video[\s\S]*?transform:\s*translateZ' -or
    $styleContent -match 'contain:\s*layout\s+paint[\s\S]*?translateZ') {
    $failures += "FAIL: Hardware video overlay broken! translateZ(0) or contain:layout paint forced on video hierarchy."
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 2: No leftover performance-tier plumbing (every tier had identical values; the feature was removed)
Write-Host "[Check 2] Verifying no dead tier attributes or unused blur variables..." -NoNewline
if ($styleContent -match 'data-yt-perf-tier' -or $styleContent -match '--yt-deck-blur-') {
    $failures += "FAIL: Dead tier selectors (data-yt-perf-tier) or unused --yt-deck-blur-* variables in style.css!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 3: Full ambient glow is a real mode: own stronger variables, theater-mode glow only when enabled
# Window-sized glow layers under the video stutter playback on weak GPUs, so they must be opt-in
Write-Host "[Check 3] Verifying full-window glow applies ONLY with Full ambient glow enabled..." -NoNewline
$hasUnscopedGlow = ($styleContent -match '(?m)^\s*html\.yt-split-scroll(?:\[[^\]]*\])? ytd-watch-flexy[^{,]*#yt-deck-glow')
$hasFullAmbientGlow = ($styleContent -match 'html\.yt-split-scroll\.yt-split-scroll-full-ambient ytd-watch-flexy:not\(\[fullscreen\]\) #yt-deck-glow\s*\{[^}]*position:\s*fixed')
# Split scrolling is layout only: the see-through header and glass UI belong to the ambient toggle
$hasUnscopedLook = ($styleContent -match '(?m)^\s*html(?:\[dark\])?\.yt-split-scroll(?:\.yt-deck-watch)?(?:\[[^\]]*\])?\s[^{,]*(?:#masthead-container|ytd-masthead|#comments|ytd-live-chat-frame|ytd-playlist-panel-renderer|ytd-engagement-panel-section-list-renderer|ytd-miniplayer)')
if ($hasFullAmbientGlow -and -not $hasUnscopedGlow -and -not $hasUnscopedLook) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Full-window glow and glass/see-through UI must be scoped to .yt-split-scroll-full-ambient, not split scrolling alone!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 4: No WebGL context created just to guess the GPU (costly, and its result was unused)
Write-Host "[Check 4] Verifying no WebGL GPU probing in content/popup scripts..." -NoNewline
$contentContent = Get-Content -Raw $contentPath
$popupContent = Get-Content -Raw $popupJsPath
if ($contentContent -match 'getContext\("webgl"' -or $popupContent -match 'getContext\("webgl"') {
    $failures += "FAIL: content.js or popup.js creates a WebGL context for hardware detection!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 5: Unbounded MutationObserver on document.body in main_world.js
Write-Host "[Check 5] Checking MutationObserver scope in main_world.js..." -NoNewline
$mainWorldContent = Get-Content -Raw $mainWorldPath
if ($mainWorldContent -match 'domVideoObserver\.observe\(\s*document\.body,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)') {
    $failures += "FAIL: Unbounded MutationObserver observing entire document.body subtree in MAIN world!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 6: Live Watch Page Retention in Miniplayer Mode
Write-Host "[Check 6] Checking watch page retention in miniplayer mode..." -NoNewline
if ($styleContent -match 'yt-split-scroll-miniplayer-active\s+ytd-watch-flexy\s*\{\s*display:\s*block\s*!important') {
    $failures += "FAIL: ytd-watch-flexy forced display:block in miniplayer mode!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 7: Video Attribute Mutation Ping-Pong Loop
Write-Host "[Check 7] Checking video event polling loop..." -NoNewline
if ($mainWorldContent -match 'timeupdate[\s\S]*?unlockVideo\(video\)[\s\S]*?registerMediaSession\(\)') {
    $failures += "FAIL: Polling unlockVideo inside timeupdate event loop!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 8: Transparent Ambient Light Reflection to Suggestion Cards
Write-Host "[Check 8] Verifying ambient light reflection transparency on suggestions..." -NoNewline
if ($styleContent -match '#secondary[\s\S]*?#secondary-inner[\s\S]*?background:\s*transparent\s*!important' -and
    $styleContent -match 'ytd-compact-video-renderer[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)') {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Suggestion column is not transparent/translucent for ambient light reflection!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 9: Lightweight Thumbnail Skeleton Loading Indicator
Write-Host "[Check 9] Verifying lightweight thumbnail loading indicator..." -NoNewline
if ($styleContent -match 'ytd-thumbnail[\s\S]*?background:\s*linear-gradient' -and
    $styleContent -match 'ytd-thumbnail::before' -and
    -not ($styleContent -match 'animation:[^;]*infinite')) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Thumbnail placeholder missing, or an infinite animation repaints every frame!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 10: Search Bar Customization Exclusivity to Ambient Light Mode
Write-Host "[Check 10] Verifying search bar customization applies ONLY when ambient is enabled..." -NoNewline
$backgroundPath = Join-Path $workspaceRoot "background.js"
$searchRules = [regex]::Matches($styleContent, '(?m)^\s*html(?:\[dark\])?\.yt-split-scroll([^{,]+)\s*(?:ytd-searchbox|yt-searchbox|\.ytSearchboxComponentInputBox|#search-form\.ytd-searchbox)')
$unscopedSearchRules = @()
foreach ($sr in $searchRules) {
    $selectorPrefix = $sr.Groups[1].Value
    if ($selectorPrefix -notmatch '\.yt-split-scroll-full-ambient') {
        $unscopedSearchRules += $sr.Value
    }
}
if ($unscopedSearchRules.Count -gt 0) {
    $failures += "FAIL: Search bar customization rules found that are NOT scoped to .yt-split-scroll-full-ambient!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 11: Auto-PiP Window Minimize & Focus Protection
# Also: window "blur" fires on address bar / popup / live-chat iframe clicks, so it must never trigger PiP
Write-Host "[Check 11] Verifying Auto-PiP window minimize detection and focus safety..." -NoNewline
$bgContent = Get-Content -Raw $backgroundPath
if ($bgContent -match 'win\.state === "minimized"' -and
    $bgContent -match 'reason:\s*"window-minimized"' -and
    $contentContent -match 'document\.hasFocus\(\)' -and
    $mainWorldContent -match 'visibilitychange[\s\S]*?triggerSafePiP' -and
    -not ($mainWorldContent -match 'addEventListener\(\s*"blur"')) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Auto-PiP minimize detection or focus safety check missing!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 12: Dynamic Screen Elements Glassmorphism
Write-Host "[Check 12] Verifying dynamic screen elements glassmorphism (chat, playlist, panels)..." -NoNewline
$hasChatGlass = ($styleContent -match 'ytd-watch-flexy\s+#chat[\s\S]*?ytd-live-chat-frame[\s\S]*?--yt-deck-glass-bg')
$hasPlaylistGlass = ($styleContent -match 'ytd-playlist-panel-renderer[\s\S]*?--yt-deck-glass-bg')
$hasPanelGlass = ($styleContent -match 'ytd-engagement-panel-section-list-renderer[\s\S]*?--yt-deck-glass-bg')
if ($hasChatGlass -and $hasPlaylistGlass -and $hasPanelGlass) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Dynamic elements glassmorphism missing for live chat, playlist, or engagement panels!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 13: Dynamic Element Backdrop-Filter Protection
Write-Host "[Check 13] Verifying backdrop-filter elimination on dynamic elements..." -NoNewline
$hasDynamicProtection = ($styleContent -match '#chat[\s\S]*?ytd-playlist-panel-renderer[\s\S]*?backdrop-filter:\s*none')
if ($hasDynamicProtection) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: backdrop-filter is not disabled on dynamic screen elements!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 14: Ambient glow samples and eases on the GPU
# Copying a video frame into a 2D canvas forces a GPU->CPU readback: ~40% dropped frames on 4K60
Write-Host "[Check 14] Verifying ambient glow samples on the GPU (WebGL) and eases colour changes..." -NoNewline
$samplesOnGpu = ($contentContent -match 'getContext\("webgl2"') -and ($contentContent -match 'generateMipmap')
$easesOnGpu = ($contentContent -match 'GLOW_STEP_K')
$readsBackVideo = ($contentContent -match '\.drawImage\(\s*video')
# Opacity is baked into the opaque canvas (read from the CSS variable), not a translucent CSS layer
$hasOpacityVar = ($contentContent -match '--yt-deck-ambient-opacity') -and -not ($styleContent -match '#yt-deck-glow\s*\{[^}]*opacity:')
if ($samplesOnGpu -and $easesOnGpu -and -not $readsBackVideo -and $hasOpacityVar) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Ambient glow must sample the video in WebGL (no 2D drawImage readback) and ease colours on the GPU!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 15: Thumbnail Loading Indicator Exclusivity to Watch Sidebar
Write-Host "[Check 15] Verifying thumbnail loading indicator is strictly scoped to watch sidebar (#secondary)..." -NoNewline
$unscopedThumbRules = @()
$thumbRules = [regex]::Matches($styleContent, '(?m)^\s*html\.yt-split-scroll([^{,]+)\s*(?:ytd-thumbnail|yt-thumbnail-view-model)')
foreach ($tr in $thumbRules) {
    $prefix = $tr.Groups[1].Value
    if ($prefix -notmatch '#secondary') {
        $unscopedThumbRules += $tr.Value.Trim()
    }
}
if ($unscopedThumbRules.Count -gt 0) {
    $failures += "FAIL: Unscoped thumbnail rules found leaking to search/feeds: $($unscopedThumbRules -join ', ')"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 16: Layout Containment on Scroll Columns for Video Isolation
Write-Host "[Check 16] Verifying sidebar-only scroll column (video stays in the page scroll)..." -NoNewline
$hasSecondaryContainment = ($styleContent -match '\)\s*#secondary\s*\{[^}]*overflow-y:\s*auto;[^}]*contain:\s*layout style;')
# contain on #primary clips the ambient #cinematics (which lives inside #primary) to the left column;
# making #primary a scroll container puts the video in a nested scroller and drops the hardware video overlay
$hasPrimaryContainment = ($styleContent -match '#primary[^{]*\{[^}]*contain:\s*layout')
$hasPrimaryScroller = ($styleContent -match '#primary[^{]*\{[^}]*overflow-y:\s*auto')
if ($hasSecondaryContainment -and -not $hasPrimaryContainment -and -not $hasPrimaryScroller) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Only #secondary may be a contained scroll column; #primary (video) must stay in the page scroll!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 17: Zero-GPU Backdrop-Filter Elimination Across UI
Write-Host "[Check 17] Verifying complete elimination of GPU-costly backdrop-filter blurs..." -NoNewline
$hasBackdropFilterBlur = ($styleContent -match 'backdrop-filter:\s*blur\(')
$hasCanvasFilterBlur = ($styleContent -match '#yt-deck-glow canvas[^{]*\{[^}]*filter:\s*blur\(')
if ($hasBackdropFilterBlur -or $hasCanvasFilterBlur) {
    $failures += "FAIL: Active backdrop-filter blur or canvas filter blur detected in style.css!"
    Write-Host " [RED]" -ForegroundColor Red
} else {
    Write-Host " [GREEN]" -ForegroundColor Green
}

# Check 18: Feathered Ambient Lighting Vignette Masks
# Vignette must be a static ::after overlay: mask-image on the full-viewport ambient layer drops video frames
Write-Host "[Check 18] Verifying feathered vignette overlay (no mask-image) on the ambient glow..." -NoNewline
# The edge fade is baked into the glow shader: a separate ::after layer is one more full-window blend
$hasVignette = ($contentContent -match 'smoothstep\(0\.45, 0\.75') -and -not ($styleContent -match '#yt-deck-glow::after')
$hasCostlyMask = ($styleContent -match '#(?:cinematics|yt-deck-glow)[^{]*\{[^}]*mask-image')
if ($hasVignette -and -not $hasCostlyMask) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: the glow edge fade must be baked into the shader (no ::after layer, no mask-image)!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 19: Dynamic UI Adaptability (Live Chat, Playlist & Queue)
Write-Host "[Check 19] Verifying dynamic ambient adaptability for chat, playlist & queue..." -NoNewline
$hasChatStyle = ($styleContent -match 'data-yt-deck-chat="active"')
$hasPlaylistStyle = ($styleContent -match 'data-yt-deck-playlist="active"')
$hasQueueStyle = ($styleContent -match 'data-yt-deck-queue="active"')
$hasContentSync = ($contentContent -match 'syncAdaptiveUIState' -and $contentContent -match 'data-yt-deck-chat')
if ($hasChatStyle -and $hasPlaylistStyle -and $hasQueueStyle -and $hasContentSync) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Dynamic ambient adaptability missing for Live Chat or Playlist/Queue!"
    Write-Host " [RED]" -ForegroundColor Red
}

# Check 20: Ambient Expansion to Header (Masthead) & Viewport Coverage
Write-Host "[Check 20] Verifying ambient lighting expansion to header (masthead) & full viewport..." -NoNewline
$hasMastheadTransparency = ($styleContent -match '#masthead-container[^{]*\{[^}]*background:\s*(?:transparent|linear-gradient)') -and
                           ($styleContent -match 'ytd-masthead[^{]*\{[^}]*background:\s*transparent')
$hasCinematicsFixed = ($styleContent -match '#yt-deck-glow\s*\{[^}]*position:\s*fixed') -and
                      ($styleContent -match '#yt-deck-glow\s*\{[^}]*width:\s*100vw') -and
                      ($styleContent -match '#yt-deck-glow\s*\{[^}]*height:\s*100vh')
if ($hasMastheadTransparency -and $hasCinematicsFixed) {
    Write-Host " [GREEN]" -ForegroundColor Green
} else {
    $failures += "FAIL: Ambient expansion to header or full viewport is missing in style.css!"
    Write-Host " [RED]" -ForegroundColor Red
}

Write-Host "`n----------------------------------------------------------"
if ($failures.Count -gt 0) {
    Write-Host "RESULT: RED ($($failures.Count) issue(s) detected):" -ForegroundColor Red
    foreach ($f in $failures) {
        Write-Host "  - $f" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "RESULT: GREEN (All multi-tier GPU safety & UI checks passed!)" -ForegroundColor Green
    exit 0
}
