# multi-stream-chat

Unified live chat viewer that merges Twitch and YouTube chat into a single real-time feed.

![Dark themed chat UI showing messages from both Twitch and YouTube with platform badges]

## Features

- **Unified feed** — Twitch and YouTube messages in one scrolling view with platform icons
- **Twitch emotes** — native emotes rendered as images
- **YouTube emojis** — rendered as images from YouTube's CDN
- **Subs & resubs** — highlighted event rows with subscriber messages
- **Gift subs** — single and mystery gift notifications
- **Raids** — raid alerts with viewer count
- **Bits / cheers** — bit count badge on cheer messages
- **Channel point redemptions** — highlighted with purple border
- **Auto-scroll** — pauses on hover, resumes on mouse leave
- **Auto-reconnect** — both connections recover automatically

## How it works

```
Browser
  ├── Twitch IRC WebSocket ──────────────────► Twitch servers  (direct, no auth)
  └── WebSocket (localhost) ◄──► server.js ──► YouTube internal chat API  (proxied)
```

- **Twitch**: the browser connects directly to Twitch's IRC WebSocket as an anonymous read-only user. No account or API key needed.
- **YouTube**: a Node.js server scrapes YouTube's internal live chat continuation API (the same one their own web client uses — no quota limits). It polls for new messages and pushes them to the browser via WebSocket.

## Requirements

- [Node.js](https://nodejs.org/) v18 or higher

## Setup

```bash
git clone https://github.com/meekaah/multi-stream-chat.git
cd multi-stream-chat
npm install
```

## Configuration

Edit the top of `server.js`:

```js
const TWITCH_CHANNEL  = 'mr_iarbin';        // your Twitch channel name
const YOUTUBE_HANDLE  = '@TestLive69latrick'; // your YouTube handle
const PORT            = 3000;                // port to serve on
```

## Usage

```bash
node server.js
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

- The server checks for an active YouTube live stream every 60 seconds.
- Twitch chat connects immediately on page load.
- Both connections reconnect automatically if dropped.

## Project structure

```
├── server.js          Node.js server — YouTube proxy + WebSocket broadcaster
├── public/
│   ├── index.html     Page shell + status bar
│   ├── style.css      Dark theme styles
│   └── client.js      Twitch IRC client + YouTube message renderer
└── package.json
```

## Notes

- YouTube detection works by fetching `youtube.com/@handle/live` — if the channel isn't live the server logs a message and retries in 60 seconds.
- Third-party Twitch emotes (BTTV / FFZ / 7TV) are not supported — only native Twitch emotes from the IRC `emotes` tag are rendered as images.
- Requires Node 18+ for the native `fetch` API.
