const TWITCH_CHANNEL = window.TWITCH_CHANNEL;

const TWITCH_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>`;
const YOUTUBE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`;

const chatEl      = document.getElementById('chat-container');
const twitchDot   = document.getElementById('twitch-dot');
const twitchLabel = document.getElementById('twitch-label');
const youtubeDot  = document.getElementById('youtube-dot');
const youtubeLabel = document.getElementById('youtube-label');
const scrollHint  = document.getElementById('scroll-hint');

const raffleBtnEl   = document.getElementById('raffle-btn');
const triggerWordEl = document.getElementById('trigger-word');
const entryCountEl  = document.getElementById('entry-count');
const winnerOverlay = document.getElementById('winner-overlay');
const winnerNameEl  = document.getElementById('winner-name');
const winnerBadgeEl = document.getElementById('winner-badge');
const winnerCloseEl = document.getElementById('winner-close');

// ── Scroll management ────────────────────────────────────────────────────────

let autoScroll = true;

chatEl.addEventListener('mouseenter', () => {
  autoScroll = false;
  scrollHint.classList.remove('hidden');
});
chatEl.addEventListener('mouseleave', () => {
  autoScroll = true;
  scrollHint.classList.add('hidden');
  scrollToBottom();
});

function scrollToBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

function appendRow(el) {
  chatEl.appendChild(el);
  while (chatEl.children.length > 500) chatEl.removeChild(chatEl.firstChild);
  if (autoScroll) scrollToBottom();
}

// ── System / info messages ───────────────────────────────────────────────────

function sysMsg(text) {
  const el = document.createElement('div');
  el.className = 'sys-msg';
  el.textContent = text;
  appendRow(el);
}

// ── Emote helpers ────────────────────────────────────────────────────────────

function buildEmoteSegments(text, emotesTag) {
  if (!emotesTag) return [{ type: 'text', content: text }];

  const positions = [];
  for (const group of emotesTag.split('/')) {
    const [id, ranges] = group.split(':');
    if (!ranges) continue;
    for (const range of ranges.split(',')) {
      const [s, e] = range.split('-').map(Number);
      positions.push({ id, start: s, end: e });
    }
  }
  positions.sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;
  for (const { id, start, end } of positions) {
    if (start > cursor) segments.push({ type: 'text', content: text.slice(cursor, start) });
    segments.push({ type: 'emote', id, name: text.slice(start, end + 1) });
    cursor = end + 1;
  }
  if (cursor < text.length) segments.push({ type: 'text', content: text.slice(cursor) });
  return segments;
}

function renderMessageBody(container, text, emotesTag) {
  if (!emotesTag) {
    container.appendChild(document.createTextNode(text));
    return;
  }
  for (const seg of buildEmoteSegments(text, emotesTag)) {
    if (seg.type === 'text') {
      if (seg.content) container.appendChild(document.createTextNode(seg.content));
    } else {
      const img = document.createElement('img');
      img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${seg.id}/default/dark/1.0`;
      img.srcset = `https://static-cdn.jtvnw.net/emoticons/v2/${seg.id}/default/dark/1.0 1x,`
                 + `https://static-cdn.jtvnw.net/emoticons/v2/${seg.id}/default/dark/2.0 2x`;
      img.alt = seg.name;
      img.title = seg.name;
      img.className = 'emote-img';
      container.appendChild(img);
    }
  }
}

// ── Regular chat message ─────────────────────────────────────────────────────
// ── YouTube emoji runs renderer ──────────────────────────────────────────────

function renderYouTubeRuns(container, runs) {
  for (const run of runs) {
    if (run.t === 'text') {
      if (run.v) container.appendChild(document.createTextNode(run.v));
    } else if (run.t === 'emoji') {
      const img = document.createElement('img');
      img.src = run.url;
      img.alt = run.name;
      img.title = run.name;
      img.className = 'emote-img';
      container.appendChild(img);
    }
  }
}

// opts: { color, emotes, bits, rewardId }

function addMessage(platform, user, textOrRuns, opts = {}) {
  const { color, emotes, bits, rewardId } = opts;

  const row = document.createElement('div');
  row.className = 'msg';
  if (rewardId) row.classList.add('reward-msg');

  // Platform icon
  const icon = document.createElement('span');
  icon.className = `msg-icon ${platform}`;
  icon.innerHTML = platform === 'twitch' ? TWITCH_SVG : YOUTUBE_SVG;

  // Username
  const name = document.createElement('span');
  name.className = 'username';
  name.style.color = color || (platform === 'twitch' ? '#9146ff' : '#ff4444');
  name.textContent = user;

  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.textContent = ':';

  // Message body
  const body = document.createElement('span');
  body.className = 'text';

  // Bits badge before message
  if (bits) {
    const badge = document.createElement('span');
    badge.className = 'bits-badge';
    badge.textContent = `◆ ${bits}`;
    body.appendChild(badge);
    body.appendChild(document.createTextNode(' '));
  }

  // Channel point reward badge
  if (rewardId) {
    const badge = document.createElement('span');
    badge.className = 'reward-badge';
    badge.textContent = '✦';
    body.appendChild(badge);
    body.appendChild(document.createTextNode(' '));
  }

  if (Array.isArray(textOrRuns)) {
    renderYouTubeRuns(body, textOrRuns);
  } else if (platform === 'twitch') {
    renderMessageBody(body, textOrRuns, emotes || '');
  } else {
    body.appendChild(document.createTextNode(textOrRuns));
  }

  row.append(icon, name, sep, body);
  appendRow(row);

  // Raffle entry check
  const rawText = Array.isArray(textOrRuns)
    ? textOrRuns.filter(r => r.t === 'text').map(r => r.v).join('')
    : textOrRuns;
  checkRaffleEntry(platform, user, rawText);
}

// ── Twitch event notifications (subs, raids, bits badges) ───────────────────

const EVENT_ICONS = {
  sub:         '★',
  subgift:     '♦',
  raid:        '→',
  'bits-badge':'◆',
  reward:      '✦',
};

const EVENT_CLASSES = {
  sub:         'event-sub',
  subgift:     'event-sub',
  raid:        'event-raid',
  'bits-badge':'event-bits',
  reward:      'event-reward',
};

function addEvent(type, data) {
  const { user, color, systemMsg, message } = data;

  const row = document.createElement('div');
  row.className = `event-row ${EVENT_CLASSES[type] || ''}`;

  const icon = document.createElement('span');
  icon.className = 'event-icon';
  icon.textContent = EVENT_ICONS[type] || '★';

  const main = document.createElement('span');
  main.className = 'event-main';

  if (user) {
    const nameEl = document.createElement('span');
    nameEl.className = 'event-user';
    nameEl.style.color = color || '#9146ff';
    nameEl.textContent = user;
    main.appendChild(nameEl);
    main.appendChild(document.createTextNode(' '));
  }

  if (systemMsg) {
    // systemMsg already includes the username, so only show the part after it
    // or just show the full system message if no user provided separately
    const sysEl = document.createElement('span');
    sysEl.className = 'event-sys';
    sysEl.textContent = systemMsg;
    main.appendChild(sysEl);
  }

  // Attached message (e.g., resub message)
  if (message) {
    const msgEl = document.createElement('span');
    msgEl.className = 'event-msg';
    msgEl.textContent = ` "${message}"`;
    main.appendChild(msgEl);
  }

  row.append(icon, main);
  appendRow(row);
}

// ── IRC tag unescaping ───────────────────────────────────────────────────────

function unescapeTag(val) {
  return (val || '')
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '')
    .replace(/\\r/g, '');
}

// ── Twitch IRC ───────────────────────────────────────────────────────────────

function connectTwitch() {
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
    ws.send(`JOIN #${TWITCH_CHANNEL}`);
  };

  ws.onmessage = ({ data }) => {
    for (const line of data.split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      handleTwitchLine(line);
    }
  };

  ws.onclose = () => {
    twitchDot.className = 'dot offline';
    twitchLabel.textContent = 'Reconnecting...';
    setTimeout(connectTwitch, 4000);
  };
}

function parseTags(raw) {
  const tags = {};
  for (const kv of raw.split(';')) {
    const eq = kv.indexOf('=');
    if (eq !== -1) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return tags;
}

function handleTwitchLine(line) {
  let tags = {};
  let rest = line;

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }

  if (rest.includes('PRIVMSG'))      handlePrivmsg(tags, rest);
  else if (rest.includes('USERNOTICE')) handleUserNotice(tags, rest);
  else if (rest.includes(' 001 ')) {
    twitchDot.className = 'dot online';
    twitchLabel.textContent = `#${TWITCH_CHANNEL}`;
    sysMsg(`Connected to Twitch #${TWITCH_CHANNEL}`);
  }
}

function handlePrivmsg(tags, rest) {
  const m = rest.match(/^:(\w+)!\S+ PRIVMSG #\S+ :(.+)$/);
  if (!m) return;

  const user   = tags['display-name'] || m[1];
  const text   = m[2];
  const color  = tags['color'] || undefined;
  const emotes = tags['emotes'] || '';
  const bits   = tags['bits'] ? parseInt(tags['bits'], 10) : 0;
  const rewardId = tags['custom-reward-id'] || '';

  addMessage('twitch', user, text, { color, emotes, bits: bits || 0, rewardId });
}

function handleUserNotice(tags, rest) {
  const msgId     = tags['msg-id'];
  const user      = tags['display-name'] || tags['login'] || 'Unknown';
  const color     = tags['color'] || undefined;
  const systemMsg = unescapeTag(tags['system-msg'] || '');
  const msgMatch  = rest.match(/USERNOTICE #\S+ :(.+)$/);
  const message   = msgMatch ? msgMatch[1] : '';

  switch (msgId) {
    case 'sub':
    case 'resub':
      addEvent('sub', { user, color, systemMsg, message });
      break;

    case 'subgift':
    case 'anonsubgift':
      addEvent('subgift', { user, color, systemMsg });
      break;

    case 'submysterygift':
    case 'anonsubmysterygift':
    case 'standardpayforward':
    case 'communitypayforward':
    case 'primepaidupgrade':
    case 'giftpaidupgrade':
      addEvent('subgift', { user, color, systemMsg });
      break;

    case 'raid':
      addEvent('raid', { user, color, systemMsg });
      break;

    case 'bitsbadgetier':
      addEvent('bits-badge', { user, color, systemMsg });
      break;
  }
}

// ── YouTube via server WebSocket ─────────────────────────────────────────────

function connectServer() {
  const ws = new WebSocket(`ws://${location.host}`);

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'status') {
        if (msg.youtube === 'live') {
          youtubeDot.className = 'dot online';
          youtubeLabel.textContent = 'Live';
          sysMsg('Connected to YouTube live chat');
        } else {
          youtubeDot.className = 'dot offline';
          youtubeLabel.textContent = 'Not live';
        }
      } else if (msg.type === 'msg' && msg.platform === 'youtube') {
        addMessage('youtube', msg.user, msg.runs ?? msg.text ?? '');
      } else if (msg.type === 'twitch-reward') {
        addEvent('reward', {
          user:      msg.user,
          systemMsg: `redeemed "${msg.rewardName}" · ${msg.cost.toLocaleString()} pts`,
          message:   msg.input,
        });
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    youtubeDot.className = 'dot offline';
    youtubeLabel.textContent = 'Server offline';
    setTimeout(connectServer, 4000);
  };
}

connectTwitch();
connectServer();

// ── Raffle ───────────────────────────────────────────────────────────────────

let raffleActive = false;
const raffleEntries = new Map(); // key: `${platform}:${user_lower}` → {user, platform}

raffleBtnEl.addEventListener('click', () => {
  if (!raffleActive) {
    raffleEntries.clear();
    raffleActive = true;
    raffleBtnEl.textContent = 'Choisir gagnant';
    raffleBtnEl.classList.add('active');
    entryCountEl.textContent = '0 participants';
    entryCountEl.classList.remove('hidden');
  } else {
    if (raffleEntries.size === 0) return;
    const entries = [...raffleEntries.values()];
    const winner = entries[Math.floor(Math.random() * entries.length)];
    raffleEntries.clear();
    raffleActive = false;
    raffleBtnEl.textContent = 'Tirage au sort';
    raffleBtnEl.classList.remove('active');
    entryCountEl.textContent = '0 participants';
    entryCountEl.classList.add('hidden');
    showWinner(winner);
  }
});

function checkRaffleEntry(platform, user, text) {
  if (!raffleActive) return;
  const trigger = (triggerWordEl.value || '+1').trim();
  if (!trigger) return;
  if (text.trim().toLowerCase() === trigger.toLowerCase()) {
    const key = `${platform}:${user.toLowerCase()}`;
    if (!raffleEntries.has(key)) {
      raffleEntries.set(key, { user, platform });
      entryCountEl.textContent = `${raffleEntries.size} participant${raffleEntries.size > 1 ? 's' : ''}`;
    }
  }
}

function showWinner({ user, platform }) {
  winnerNameEl.textContent = user;
  winnerBadgeEl.textContent = platform === 'twitch' ? 'Twitch' : 'YouTube';
  winnerBadgeEl.className = `winner-platform ${platform}`;
  winnerOverlay.classList.remove('hidden');
}

winnerCloseEl.addEventListener('click', () => winnerOverlay.classList.add('hidden'));
winnerOverlay.addEventListener('click', (e) => {
  if (e.target === winnerOverlay) winnerOverlay.classList.add('hidden');
});
