const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const TWITCH_CHANNEL = 'mr_iarbin';
const YOUTUBE_HANDLE = '@TestLive69latrick';
const PORT = 3000;

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let ytRunning = false;
let currentVideoId = null;

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'status',
    youtube: currentVideoId ? 'live' : 'offline',
    videoId: currentVideoId,
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ── YouTube: find live video ID ──────────────────────────────────────────────

async function findYoutubeLiveId() {
  try {
    const res = await fetch(`https://www.youtube.com/${YOUTUBE_HANDLE}/live`, {
      redirect: 'follow',
      headers: YT_HEADERS,
    });
    const finalUrl = res.url;
    const urlMatch = finalUrl.match(/[?&]v=([^&]+)/);
    if (urlMatch) return urlMatch[1];

    // Fallback: parse videoId from HTML
    const html = await res.text();
    const htmlMatch = html.match(/"videoId":"([^"]{11})"/);
    if (htmlMatch) return htmlMatch[1];

    return null;
  } catch (e) {
    console.error('[YouTube] Live detect error:', e.message);
    return null;
  }
}

// ── YouTube: robust JSON extractor ──────────────────────────────────────────

function extractYtJson(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(jsonStart, i + 1));
    }
  }
  return null;
}

// ── YouTube: get initial continuation token ──────────────────────────────────

async function getInitialContinuation(videoId) {
  const res = await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`, {
    headers: YT_HEADERS,
  });
  const html = await res.text();

  const data = extractYtJson(html, 'window["ytInitialData"] = ')
    ?? extractYtJson(html, 'ytInitialData = ');
  if (!data) throw new Error('ytInitialData not found');

  const renderer = data?.contents?.liveChatRenderer;
  if (!renderer) throw new Error('liveChatRenderer not found — stream may not be live');

  const conts = renderer.continuations;
  if (!conts?.length) throw new Error('No continuation tokens found');

  return pickContinuation(conts[0]);
}

function pickContinuation(cont) {
  if (!cont) return null;
  const data = cont.invalidationContinuationData
    || cont.timedContinuationData
    || cont.liveChatReplayContinuationData;
  return data?.continuation || null;
}

// ── YouTube: poll live chat ──────────────────────────────────────────────────

async function pollLiveChat(token, videoId) {
  const res = await fetch(
    'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    {
      method: 'POST',
      headers: {
        ...YT_HEADERS,
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20240101.00.00',
        'Referer': `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
        continuation: token,
      }),
    }
  );
  return res.json();
}

// ── YouTube: parse messages from response ────────────────────────────────────

function parseActions(response) {
  const actions = response?.continuationContents?.liveChatContinuation?.actions ?? [];
  const messages = [];

  for (const action of actions) {
    const item = action?.addChatItemAction?.item;
    if (!item) continue;

    const renderer = item.liveChatTextMessageRenderer
      || item.liveChatPaidMessageRenderer;
    if (!renderer) continue;

    const user = renderer.authorName?.simpleText || 'Unknown';
    const rawRuns = renderer.message?.runs ?? [];

    const runs = [];
    for (const r of rawRuns) {
      if (r.text !== undefined) {
        runs.push({ t: 'text', v: r.text });
      } else if (r.emoji) {
        const thumbs = r.emoji.image?.thumbnails;
        // prefer larger thumbnail for retina, fall back to first
        const url = thumbs?.[1]?.url || thumbs?.[0]?.url;
        const name = r.emoji.shortcuts?.[0] || r.emoji.emojiId || '';
        if (url) {
          runs.push({ t: 'emoji', url, name });
        } else if (name) {
          // unicode emoji without image — render as text
          runs.push({ t: 'text', v: name });
        }
      }
    }

    if (runs.length > 0) messages.push({ user, runs });
  }

  return messages;
}

function nextContinuation(response) {
  const conts = response?.continuationContents?.liveChatContinuation?.continuations;
  if (!conts?.length) return { token: null, timeout: 5000 };
  const entry = conts[0];
  const data = entry.invalidationContinuationData
    || entry.timedContinuationData
    || entry.liveChatReplayContinuationData;
  return {
    token: data?.continuation ?? null,
    timeout: data?.timeoutMs ?? 5000,
  };
}

// ── YouTube: main chat loop ──────────────────────────────────────────────────

async function startYoutubeChat(videoId) {
  if (ytRunning) return;
  ytRunning = true;
  currentVideoId = videoId;
  console.log(`[YouTube] Live stream: https://www.youtube.com/watch?v=${videoId}`);
  broadcast({ type: 'status', youtube: 'live', videoId });

  let token;
  try {
    token = await getInitialContinuation(videoId);
    if (!token) throw new Error('Empty continuation token');
  } catch (e) {
    console.error('[YouTube] Init failed:', e.message);
    ytRunning = false;
    currentVideoId = null;
    broadcast({ type: 'status', youtube: 'offline' });
    return;
  }

  console.log('[YouTube] Chat connected, polling...');

  while (token) {
    try {
      const data = await pollLiveChat(token, videoId);
      const messages = parseActions(data);
      for (const msg of messages) {
        broadcast({ type: 'msg', platform: 'youtube', user: msg.user, runs: msg.runs, timestamp: Date.now() });
      }
      const next = nextContinuation(data);
      token = next.token;
      if (!token) break;
      await sleep(Math.max(next.timeout, 1000));
    } catch (e) {
      console.error('[YouTube] Poll error:', e.message);
      await sleep(5000);
    }
  }

  console.log('[YouTube] Chat ended or stream stopped');
  ytRunning = false;
  currentVideoId = null;
  broadcast({ type: 'status', youtube: 'offline' });
}

// ── Monitor loop: check for live stream every 60s ───────────────────────────

async function monitorYoutube() {
  while (true) {
    if (!ytRunning) {
      const id = await findYoutubeLiveId();
      if (id) {
        startYoutubeChat(id); // intentionally not awaited — runs concurrently
      } else {
        console.log('[YouTube] Not live. Checking again in 60s...');
        broadcast({ type: 'status', youtube: 'offline' });
      }
    }
    await sleep(60000);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`MultiChat running → http://localhost:${PORT}`);
  console.log(`Twitch: #${TWITCH_CHANNEL}  |  YouTube: ${YOUTUBE_HANDLE}`);
  monitorYoutube();
});
