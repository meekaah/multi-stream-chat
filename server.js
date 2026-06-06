require('dotenv').config();
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const fs   = require('fs');

const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL  || '';
const YOUTUBE_HANDLE = process.env.YOUTUBE_HANDLE  || '';
const PORT = 3000;

// ── Twitch PubSub config — set in .env (see .env.example) ───────────────────
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID     || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Expose config to the browser — client.js reads window.TWITCH_CHANNEL from here
app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.TWITCH_CHANNEL = ${JSON.stringify(TWITCH_CHANNEL)};`);
});

// OAuth callback — Twitch redirects here after user authorizes
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    res.send(`<p>Auth failed: ${error || 'no code received'}</p>`);
    return;
  }
  try {
    const data = await exchangeCode(code);
    saveToken(data);
    res.send('<html><body style="font-family:sans-serif;padding:2rem;background:#0e0e10;color:#efeff1"><h2>✅ Authorized!</h2><p>MultiChat will connect to PubSub now.</p><a href="/" style="display:inline-block;margin-top:1rem;padding:0.6rem 1.4rem;background:#9146ff;color:#fff;text-decoration:none;border-radius:6px;font-weight:700">Go to chat!</a></body></html>');
    if (_pendingAuthResolve) { _pendingAuthResolve(data.access_token); _pendingAuthResolve = null; }
  } catch (e) {
    res.send(`<p>Error: ${e.message}</p>`);
  }
});

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

// YouTube's own public web client key — not a secret, embedded in youtube.com itself
const YT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

async function pollLiveChat(token, videoId) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${YT_API_KEY}`,
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

  broadcast({ type: 'status', youtube: 'live', videoId });
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

// ── Twitch PubSub — token management ────────────────────────────────────────

const TOKEN_FILE = path.join(__dirname, '.twitch-token.json');
let _pendingAuthResolve = null;

function loadStoredToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

function saveToken(data) {
  const record = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in ?? 14400) * 1000,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(record, null, 2));
  return record;
}

async function exchangeCode(code) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:    TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      code,
      grant_type:   'authorization_code',
      redirect_uri: `http://localhost:${PORT}/auth/callback`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(json.message || 'Code exchange failed');
  return json;
}

async function refreshToken(storedRefresh) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      refresh_token: storedRefresh,
      grant_type:    'refresh_token',
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(json.message || 'Refresh failed');
  return json;
}

async function getValidToken() {
  const stored = loadStoredToken();

  if (stored?.refresh_token) {
    // If access token still valid (5-min buffer), use it directly
    if (stored.expires_at && Date.now() < stored.expires_at - 300_000) {
      return stored.access_token;
    }
    // Try refresh
    try {
      console.log('[PubSub] Refreshing access token...');
      const data = await refreshToken(stored.refresh_token);
      return saveToken({ ...data, refresh_token: data.refresh_token || stored.refresh_token }).access_token;
    } catch (e) {
      console.error('[PubSub] Refresh failed:', e.message, '— re-auth required');
    }
  }

  // No stored token or refresh failed — need user to authorize once
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(`http://localhost:${PORT}/auth/callback`)}`
    + `&response_type=code&scope=channel:read:redemptions`;
  console.log('\n[PubSub] Authorization required. Open this URL in your browser:');
  console.log(`  ${authUrl}\n`);

  return new Promise(resolve => { _pendingAuthResolve = resolve; });
}

// ── Twitch PubSub — connection ───────────────────────────────────────────────

async function getTwitchUserId(login, token) {
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
  });
  const json = await res.json();
  if (json.error) throw new Error(`Helix error: ${json.message}`);
  return json?.data?.[0]?.id ?? null;
}

function connectPubSub(channelId, token) {
  const ws = new WebSocket('wss://pubsub-edge.twitch.tv');
  let pingTimer;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'LISTEN',
      nonce: 'mc-rewards',
      data: { topics: [`channel-points-channel-v1.${channelId}`], auth_token: token },
    }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
    }, 240_000);
    console.log('[PubSub] Connected');
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'PONG') return;
      if (msg.type === 'RECONNECT') { ws.close(); return; }
      if (msg.type === 'RESPONSE') {
        if (msg.error) console.error('[PubSub] LISTEN error:', msg.error);
        else console.log('[PubSub] Listening for channel point redemptions');
        return;
      }
      if (msg.type !== 'MESSAGE') return;

      const inner = JSON.parse(msg.data.message);
      if (inner.type !== 'reward-redeemed') return;

      const r = inner.data.redemption;
      broadcast({
        type: 'twitch-reward',
        user:       r.user.display_name,
        rewardName: r.reward.title,
        cost:       r.reward.cost,
        input:      r.user_input || '',
        timestamp:  Date.now(),
      });
    } catch (e) {
      console.error('[PubSub] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
    console.log('[PubSub] Disconnected — reconnecting in 5s...');
    // Get a fresh token on reconnect in case the old one expired
    setTimeout(() => initPubSub(), 5000);
  });

  ws.on('error', (e) => console.error('[PubSub] Error:', e.message));
}

async function initPubSub() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.log('[PubSub] Not configured — add TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET to enable rewards');
    return;
  }
  try {
    const token = await getValidToken();
    const id = await getTwitchUserId(TWITCH_CHANNEL, token);
    if (!id) throw new Error('Channel not found');
    console.log(`[PubSub] Resolved ${TWITCH_CHANNEL} → channel ID ${id}`);
    connectPubSub(id, token);
  } catch (e) {
    console.error('[PubSub] Init failed:', e.message);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`MultiChat running → http://localhost:${PORT}`);
  console.log(`Twitch: #${TWITCH_CHANNEL}  |  YouTube: ${YOUTUBE_HANDLE}`);
  monitorYoutube();
  initPubSub();
});
