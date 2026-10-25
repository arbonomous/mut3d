# Features in detail

Everything here runs in the browser unless it says otherwise. Back to the [README](../README.md).

## Feedback

"Send feedback" (home screen and More menu) sends one short note to the builders. The sheet shows the exact text before you tap Send. It contains only: worked / didn't work, your note, and, only if you tick the box, the app version, browser string and screen size. It never includes the room link or key, names, chat, files or anything about a call. Your network address is used only to limit spam (a salted hash kept for under an hour) and is not stored with the feedback. Notes are deleted after 60 days. Storage is a free Cloudflare D1 table written by `_worker.js`.

## Voice disguise

More menu > Voice disguise: Off (default), Deeper, Higher, Robot. It runs in your own browser on your microphone before the audio is sent, so the others hear the changed voice. It is a disguise, not anonymity: people can still recognise you by what you say and how you talk. "Hear myself" is off by default (use headphones, or you get echo). If the browser blocks audio processing, the call carries on with your normal voice. Effects use some battery on phones.

## Connection fallback

`/turn` (a Cloudflare Pages Function) hands the browser short-lived relay credentials (30 minutes). The long-lived secret stays on the server. The endpoint only answers same-site requests and is rate limited. The browser tries a direct path first and uses the relay only if that fails. `tests/relay-test.mjs` forces relay-only and sends data through it.

## Face blur

More menu > Face disguise: Off (default, the untouched camera) or Blur. Blur runs in your own browser on your camera before anything is sent: the picture is shrunk and stretched back up until nothing is sharp, so the others get a heavily blurred video, face included. Nothing is uploaded. Drawing is capped at 15 fps and 480 px wide to save battery.

It is a disguise, not anonymity: your voice can still identify you. If the browser can't capture a canvas, you get a chat note and the call carries on with your normal camera.

Tests: `tests/face-test.mjs`.
## Speaker highlight, enlarge, install

The person who is talking gets a green outline (measured from the audio you already receive, in your browser). Tap a tile to enlarge it, tap again to go back. On phones, "Add to Home Screen" installs mut3d as an app. The service worker (`public/sw.js`) keeps only the app page and icons so it opens offline. It never stores chat, files, feedback, relay credentials or room keys (the key is after the # in the link and is never part of a request).

## Invite, short link, room lock
- **Invite** button: shows a QR code of the link, a Share button (phones that support the share sheet), and Copy. The QR is drawn in the browser with the MIT-licensed `qrcode-generator`; nothing is fetched.
- **Short link** (optional, one tap): the full link is encrypted in your browser with a random 12-letter code. Our server stores only that ciphertext for 24 hours (D1, rate limited). The code lives after the `#` of the short link, so the server never sees the room key or the code. Anyone holding the short link can still join (same trust as the long link). Wrong code or expired: the page says so.
- **Lock room** (host, in More): refuses new knocks and clears the waiting list; guests already in stay. Enforced on the host's device. Unlock to accept knocks again.
- **Waiting list**: each person waiting has Let in / Deny; with two or more, "Let everyone in" and "Deny all" appear.
- Honest limit: lock and the waiting list live in the host's browser. If the host closes the tab, nobody is admitted.

## Theme
- Light/Dark button in More. Default is dark. The only thing stored on your device is the word `dark` or `light`.
