# Security model and honest limits

**The cryptography in mut3d has not been independently audited.** It is a small project, not a replacement for Signal or any audited tool. Do not use it where your safety depends on it.

## What it tries to do
- Keep the room key out of every server: it lives after the `#` of the link.
- Keep call content between the browsers in the call: WebRTC media is DTLS-SRTP encrypted, and chat, names and files are additionally sealed with AES-GCM bound to message type, sender and recipient.
- Make people prove they hold the key before anything flows (fresh random challenge, sealed with the room key).
- Store nothing about calls.

## Limits
- Host approval, the lock, the waiting list and "End room for everyone" are enforced by each person's browser running this code. They protect against people without the link and against honest clients. Someone with the link who runs modified code could ignore them, and anyone can screenshot or record.
- "Verify this call" detects interception between two devices. It does not prove who a person is.
- The host's signing key lives in the host's own address bar (the part after the `#`, not in the invite link). If the host loses that tab's address they lose host rights. Lock and the waiting list live in the host's browser, so if the host closes the tab nobody is admitted.
- Anyone with the full link can knock, and can see and hear the call once let in. Share the link only over a channel you trust. There is no identity beyond the name people type.
- Peers connect directly, so people in a call can see each other's IP addresses. A small free relay (metered.ca TURN, 500 MB trial tier) is used only as a fallback. It sees IP addresses and timing, not content. A strict network may still fail to connect.
- Up to 8 people. Screen share is not available on most phones.
- Face and voice effects are disguises, not anonymity.
- If a device is compromised, no tool can help.
- Face and background-blur model licences were not independently verified; `@mediapipe/tasks-vision` is Apache-2.0.

## Who sees what

| Who | Sees | Does not see |
| --- | --- | --- |
| People in the call | Your video, voice, chat, files, the name you typed, your IP address | Nothing is hidden from them: they hold the room key too |
| PeerJS introduction server (0.peerjs.com, free public service) | Your IP address, a scrambled room name (a one-way hash of the key) and a slot number, who tries to connect to whom, when, and the connection details browsers swap (including network addresses of both sides) | The room key, video, voice, chat, files, names |
| Cloudflare (hosts this page and our small server code) | Every visit to the page, like any web host: IP address, time, browser. Also the feedback you choose to send and the encrypted short links | The room key (it never leaves the browser), call content |
| Cloudflare STUN (address lookup) | Your IP address, when a call starts | Anything else |
| metered.ca relay (only if a direct path fails) | Your IP address, timing and amount of encrypted traffic | Call content |

We keep no call logs and run no analytics. Cloudflare and the other services above keep their own logs under their own rules, which we do not control.

## Why this is not "decentralized"
The call content is peer to peer, but starting a call depends on three outside parties: the PeerJS introduction server (if it is down, new calls cannot start), Cloudflare (hosts the page), and a relay for strict networks. No blockchain, no federation. The honest description is: no accounts and no server that sees call content, but not independent of third parties.

## You are trusting the code you are served
Like every website that does encryption in the browser, the page you load is the code that handles your key. Whoever controls the hosting could serve a changed page. What you can check: `npm run verify` builds the app from this repository and compares it byte for byte with the live page. The in-app "More" panel also shows what was sent to the introduction server and counts how many of those messages contain your room key (should be 0).

## Last checked
Oct 16, 2026: a headless-browser call on the live site made requests only to this site and the introduction server, set no cookies, stored nothing in the browser, and none of the introduction-server messages contained the room key. The live page matched a build from this repository exactly. These checks do not replace an independent audit.
