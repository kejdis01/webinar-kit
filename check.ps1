param(
  [string]$BaseUrl = "https://kejdis01.github.io/webinar-kit",
  [string]$Version = "11"
)

$ErrorActionPreference = "Stop"
$files = @("control-panel.html", "overlay.html", "ssn-link.js")
$bad = @([char]0x00C2, [char]0x00E2, [char]0x00C3, [char]0xFFFD)

foreach ($file in $files) {
  $local = Get-Content -Raw -Encoding UTF8 $file
  foreach ($ch in $bad) {
    if ($local.Contains($ch)) { throw "Encoding artifact U+$([int][char]$ch).ToString('X4') found in $file" }
  }
}

$control = Invoke-WebRequest -UseBasicParsing "$BaseUrl/control-panel.html?v=check-$Version"
$overlay = Invoke-WebRequest -UseBasicParsing "$BaseUrl/overlay.html?v=check-$Version"
$link = Invoke-WebRequest -UseBasicParsing "$BaseUrl/ssn-link.js?v=check-$Version"

if ($control.StatusCode -ne 200 -or $overlay.StatusCode -ne 200 -or $link.StatusCode -ne 200) {
  throw "One or more deployed files did not return HTTP 200."
}
if ($control.Content -notmatch "CP .* v$Version") { throw "Control panel is not v$Version on Pages." }
if ($overlay.Content -notmatch "overlay v$Version") { throw "Overlay is not v$Version on Pages." }
if ($link.Content -notmatch "VERSION: '$Version'") { throw "ssn-link.js is not v$Version on Pages." }

"OK: local encoding clean and GitHub Pages deployed v$Version"
