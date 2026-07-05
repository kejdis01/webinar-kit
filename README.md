# Webinar interaction toolkit

Three live widgets (poll, word cloud, wheel) that sit on top of Social Stream Ninja. No backend, no build step. Three files:

- `control-panel.html` — open in a normal browser tab on your second screen
- `overlay.html` — add to OBS as a Browser Source
- `ssn-link.js` — shared connection layer, must sit in the same folder as both pages

## One-time setup

1. **SSN**: Global settings → Mechanics → turn on both **"Enable remote API control of extension"** and **"Send chat messages to API server."** Note your session ID.
2. **Control panel**: open `control-panel.html`, paste the session ID into the bar at the top, hit Connect. It's saved in localStorage after that.
3. **OBS**: add a Browser Source pointing at `overlay.html?session=YOUR_SESSION_ID`. The `?session=` part is required — OBS's browser has its own storage, so it can't see the ID you saved in your regular browser. Set the source to your canvas size (e.g. 1920×1080). Background is transparent.

Both connection dots in the panel header should go green: **chat** (channel 4, incoming messages) and **overlay link** (channel 6, commands).

## Relay channels (how the plumbing works)

SSN's relay uses `/join/SESSION/IN/OUT`: you receive what's sent to your IN channel, and what you send goes to your OUT channel (defaulting to 1 if omitted). The toolkit joins chat as `/join/SESSION/4` (receive only, where SSN broadcasts chat) and control as `/join/SESSION/6/6` (both pages send and receive on 6).

The session ID is not stored in the code. Each browser remembers the last ID you set, so the same files work on any machine without editing. You set it in two places, once each:

- Control panel: type it in the box at the top and hit Connect.
- Overlay: the first time you open it on a machine, it shows a one-time setup card asking for the ID. In OBS you normally avoid that card by opening `overlay.html` once in a regular browser tab on the same machine first, which saves the ID; after that the OBS source just works. Or, put the ID right in the OBS URL as `overlay.html#session=YOUR_ID` (the `#` form survives OBS's file URL handling better than `?`).

## Stream Deck

Two ways, use whichever fits your setup:

**Hotkey actions** (simplest): keep the control panel tab focused and map keys:

| Key | Action |
|---|---|
| 1 / 2 / 3 | Switch tab (Poll / Cloud / Wheel) |
| P | Poll: go live |
| W | Word cloud: go live |
| C | Clear cloud |
| S | Spin the wheel |
| R | Reset wheel |
| H or Esc | Hide overlay |

**Website actions, HTTP method (recommended)**: works even when the panel isn't focused, and needs no extra page. In the control panel footer there's a list of ready-made URLs for your current session. Click any one to copy it, then in the Stream Deck app add a **Website** action, paste the URL, and tick **"GET request in background"**. Do that for each command you want (poll-live, poll-end, cloud-live, cloud-clear, spin, wheel-reset, hide).

These are plain SSN API calls of the form `https://io.socialstream.ninja/SESSION/trigger/null/ACTION?channel=6`. The relay drops the message on channel 6, where your panel picks it up and runs it. The panel (browser tab or OBS dock) has to be open, since it holds all the state (your poll question, wheel names, tallies). Because the URLs are generated from whatever session is set, they're automatically correct on each machine.

**Website actions, page method**: pointing a "Website" action at `control-panel.html?cmd=spin` also works. It opens a small trigger page that relays the command over channel 6 and closes itself. Same supported commands.

## Behavior notes

- **Votes**: a chat message counts as a vote when its first word is a single letter matching an option ("A", "b!", "c option 2" all count; "Anyone else?" doesn't). One vote per person; sending a new letter changes your vote. Identity is `userid || chatname`, so a mid-poll display-name change can double-vote — accepted edge case.
- **Overlay refresh**: if the OBS browser source reloads mid-show, it asks the panel for the current state and gets it back, including the poll tally and word cloud counts. The wheel comes back in its idle position.
- **The panel's tally and the overlay's tally** are counted independently from the same chat stream with the same rule, so they match unless one side missed messages while reconnecting.
- **Reconnects**: both connections retry automatically with backoff (1s → 15s cap) and send keepalive pings. A small pill appears in the overlay's corner only while something is down.
- Poll options: 2–6. Wheel needs at least 2 entries to spin. Word cloud filters ~150 common English stopwords, URLs, and pure numbers, keeps the top 60 words.
- **Message to chat**: the box under the widget tabs posts a message into the actual meeting chat through SSN's sendEncodedChat action. It needs "Enable remote API control of extension" on (which you already have) and the Zoom/Meet tab that SSN is scraping must be open and not minimized, since SSN types the message into that tab. Test it once in a throwaway meeting before relying on it live.
- **Wheel winner**: when the wheel lands, a full-screen confetti burst plays over the overlay for a few seconds, then clears itself. It respects reduced-motion settings.
- **Quiz mode**: click the ✓ next to an option before going live to mark it as the correct answer. The overlay gives nothing away while voting runs. Hit "Reveal answer" (hotkey A, or the poll-reveal Stream Deck URL) to end the poll, light the correct option up in gold, and show who answered right first. First place goes to the first person who votes the correct option and is locked in even if they change their vote afterward. Leave the ✓ off and the poll behaves exactly as before.

## The extra overlays

- **Tug of war**: a two-option poll drawn as a single bar that shifts live as A and B votes come in. "Reveal winner" freezes it, dims the losing side, and names the winner.
- **Meter (speedometer)**: ask a 1 to 10 question, people type a number in chat, the needle points at the live average. One rating per person, changeable.
- **Bullets**: an on-screen agenda on the right side. Type items one per line, show it, then step through with Next/Back (N and B keys, or Stream Deck). Done items dim, the current one glows.
- **World map**: ask people to type their country in chat. Pins with counts appear on a stylized dark map. Around 130 English country names and common short forms (USA, UK, UAE, Korea) are recognized. It's chat-based, not automatic geolocation, because Zoom/Meet don't expose location.
- **Avatars**: everyone who chats pops up as a floating bubble with their name, and their photo when the platform provides one (initials otherwise). Newest 12 stay up. Good as a welcome moment.

All five resync after an OBS refresh like the poll does, and all have Stream Deck URLs (tug-live, tug-reveal, meter-live, bullets-live, bullets-next, bullets-prev, map-live, avatars-live). The full clickable list is generated in the control panel footer.

## Putting it on GitHub

Yes, you can, and it makes the toolkit genuinely portable. Two things to understand first.

**There's no secret in the code anymore.** The session ID isn't stored in any file, so publishing these three files exposes nothing sensitive. Your session ID only lives in each browser's local storage and in the Stream Deck URLs you keep on your own machine. Don't commit a file with your ID in it and you're fine.

**GitHub gives you two ways to use it:**

1. **Just store the files** (private or public repo). You clone or download them to each PC and open them locally, exactly like now. GitHub is only acting as your backup and sync. Simplest option.

2. **GitHub Pages** turns your repo into live web URLs like `https://yourname.github.io/webinar-kit/overlay.html`. This is nicer because your OBS browser source and Stream Deck can point at a URL that's identical on every machine, no local file paths, no `file:///`. You'd add the session per machine the same way (setup card on the overlay, box on the panel, or `#session=YOUR_ID` in the URL).

Steps for the Pages route:

1. Create a repo, e.g. `webinar-kit`. Public is fine since there's no secret; private also works with Pages on current GitHub.
2. Upload `overlay.html`, `control-panel.html`, `ssn-link.js`, and optionally `relay-test.html` and this README.
3. Repo Settings → Pages → set Source to your `main` branch, root folder, Save.
4. Wait a minute, then your files are at `https://YOURNAME.github.io/REPONAME/overlay.html`.
5. In OBS, set the browser source URL to that Pages URL (add `#session=YOUR_ID` the first time, or open it once in a browser to save the ID).
6. In the control panel on each machine, set the session and grab your Stream Deck URLs from the footer.

One caveat with Pages: it can cache aggressively, so if you edit a file and don't see the change, do a hard refresh, or add something like `?v=2` to the URL to bust the cache. Not an issue during a webinar, only when you're making changes.

If you'd rather keep it dead simple, option 1 (store the files, open them locally) already gives you everything you asked for. Pages is just the upgrade that removes local file paths from the picture.
