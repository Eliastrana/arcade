import { BRAWL, BRAWL_WORLDS, BRAWL_TEAMS, BRAWL_ROLL, BRAWL_EMOTE, BRAWL_EMOTE_LINES, FIGHTERS, ATTACKS, CAPE, EGG_LAY, MIC_WAVE, SLIME, CONFUNDO, ARROW_TRAP, WEB_PAD, isBrawlRollInvulnerable, makeFighter, knockback } from '/shared/brawl.js';
import { BrawlTimeline, BrawlPredictor } from '/shared/brawl-client.js';
import { music } from '/music.js';

const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const worldCanvas = document.querySelector('#worldBackground');
const worldContext = worldCanvas.getContext('2d');
worldContext.imageSmoothingEnabled = false;
const backdropCanvas = document.createElement('canvas');
backdropCanvas.width = canvas.width; backdropCanvas.height = canvas.height;
const backdropContext = backdropCanvas.getContext('2d');
backdropContext.imageSmoothingEnabled = false;
let backdropImage = new Image();
let backdropReady = false;
backdropImage.onload = () => {
  const height = backdropImage.naturalHeight * canvas.width / backdropImage.naturalWidth;
  backdropContext.drawImage(backdropImage, 0, canvas.height - height, canvas.width, height);
  backdropReady = true;
  backdropImage.onload = null;
  backdropImage = null;
  drawWorldPreviews();
};
backdropImage.src = '/brawl-mountains.png';
// make sure the pixel fonts are ready before text is drawn on the canvas
document.fonts?.load('19px "PixelText"').catch(() => {});
const TEAM_NAMES = { red: 'Rød', blue: 'Blå' };
const lobby = document.querySelector('#lobby');
const splashScreen = document.querySelector('#splash');
const roomsScreen = document.querySelector('#rooms');
const howto = document.querySelector('#howto');
const howtoButton = document.querySelector('#howtoButton');
const howtoClose = document.querySelector('#howtoClose');
const mascot = document.querySelector('#mascot');
const mascotCaption = document.querySelector('#mascotCaption');
const roomList = document.querySelector('#roomList');
const roomsHint = document.querySelector('#roomsHint');
const quickPlayButton = document.querySelector('#quickPlay');
const newRoomButton = document.querySelector('#newRoom');
const leaveRoomButton = document.querySelector('#leaveRoom');
const countdownEl = document.querySelector('#countdown');
const muteButton = document.querySelector('#muteButton');
const volumeSlider = document.querySelector('#volume');
const playButton = document.querySelector('#play');
const readyButton = document.querySelector('#ready');
const nameInput = document.querySelector('#name');
const roster = document.querySelector('#roster');
const card = document.querySelector('#lobby .card');
const podium = document.querySelector('#podium');
const grid = document.querySelector('#characterGrid');
const worldGrid = document.querySelector('#worldGrid');
const worldStatus = document.querySelector('#worldStatus');
const matchRule = document.querySelector('#matchRule');
const matchSetup = document.querySelector('#matchSetup');
const modeFfa = document.querySelector('#modeFfa');
const modeTeams = document.querySelector('#modeTeams');
const friendlyFireButton = document.querySelector('#friendlyFire');
const teamGrid = document.querySelector('#teamGrid');
const teamButtons = [...teamGrid.querySelectorAll('.teamChoice')];
const modeHint = document.querySelector('#modeHint');
const hint = document.querySelector('#lobbyHint');
const scores = document.querySelector('#scores');
const status = document.querySelector('#status');
const netStats = document.querySelector('#netStats');
const flash = document.querySelector('#flash');
const confundoNotice = document.querySelector('#confundoNotice');
const confundoFill = document.querySelector('#confundoFill');
const extraControls = document.querySelector('#extraControls');
const throwHint = document.querySelector('#throwHint');
const throwPad = document.querySelector('#throwPad');
const emoteButton = document.querySelector('#emoteButton');
const extraTouch = ['tg', 'tshield', 'tu'].map(id => document.getElementById(id));
const keys = new Set();
let socket, myId = null, state = null, receivedAt = 0, selected = 'mario', pendingRestart = false;
let selectedWorld = Object.hasOwn(BRAWL_WORLDS, localStorage.getItem('brawl-world'))
  ? localStorage.getItem('brawl-world') : 'dolomittene';
let combatFeatures = false, throwsEnabled = false, teamsEnabled = false, emotesEnabled = false;
const timeline = new BrawlTimeline(), predictor = new BrawlPredictor();
let inputVersion = 1, inputSeq = 0, queuedJump = false, queuedUpair = false, simAccumulator = 0;
let pingTimer = null, pingId = 0, probeCount = 0, probeMode = 'ws', httpProbe = null;
const pendingPings = new Map(), pingTimes = [], probeResults = [];
let audio = null, shake = 0, particles = [], waftEffects = [], dinEffects = [], micEffects = [], spellEffects = [], previousPhase = null;
let speakingPlayerId = null, activeUtterance = null;
let visibleFlash = '', flashUntil = 0;
let browsing = false;       // after the title screen: choosing a room (no connection to a room yet)
let wantRoom = 'auto';      // 'auto', 'new' or a room number; only the first connection uses it, reconnects go back to 'auto'
let leaving = false;        // the person chose to leave the room, so the closing socket must not reconnect
let welcomed = false;
let splash = true;          // the title screen shows first; its background is a scripted fight (see "attract mode" below)
let lastUiSignature = '';
nameInput.value = localStorage.getItem('brawl-name') || '';

function send(t, values = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t, ...values }));
}

function showNetStats() {
  if (socket?.readyState !== WebSocket.OPEN || document.hidden) {
    netStats.textContent = 'Ping — · Tap —';
    netStats.className = '';
    return;
  }
  const averagePing = pingTimes.length ? pingTimes.reduce((sum, ms) => sum + ms, 0) / pingTimes.length : null;
  const ping = averagePing === null ? '—' : `${Math.round(averagePing)} ms`;
  const loss = probeResults.length ? Math.round(100 * probeResults.filter(ok => !ok).length / probeResults.length) : null;
  netStats.textContent = `${probeMode === 'http' ? 'Web-ping' : 'Ping'} ${ping} · Tap ${loss === null ? '—' : `${loss}%`}`;
  netStats.title = probeMode === 'http'
    ? 'Web-ping måler en HTTPS-forespørsel, ikke spillforbindelsen. Tap teller forespørsler som feilet eller tok over 2,5 sekunder.'
    : 'Tap teller WebSocket-målinger som ikke ble besvart innen 2,5 sekunder. Det er ikke ekte IP-pakketap.';
  netStats.className = loss >= 10 || averagePing >= 180 ? 'bad'
    : loss >= 3 || averagePing >= 100 ? 'warn' : '';
}

function recordProbe(ok) {
  probeResults.push(ok);
  if (probeResults.length > 30) probeResults.shift();
}

function probeWeb() {
  if (httpProbe || document.hidden) return;
  const controller = new AbortController();
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), 2500);
  httpProbe = controller;
  fetch(`/brawl.html?net-probe=${Date.now()}`, {
    method: 'HEAD', cache: 'no-store', signal: controller.signal,
  }).then(response => {
    if (probeMode !== 'http') return;
    recordProbe(response.ok);
    if (response.ok) {
      pingTimes.push(performance.now() - started);
      if (pingTimes.length > 5) pingTimes.shift();
    }
  }).catch(() => {
    if (probeMode === 'http') recordProbe(false);
  }).finally(() => {
    clearTimeout(timeout);
    if (httpProbe === controller) httpProbe = null;
    showNetStats();
  });
}

function probeConnection() {
  if (socket?.readyState !== WebSocket.OPEN || document.hidden) return;
  const now = performance.now();
  for (const [id, sentAt] of pendingPings) {
    if (now - sentAt < 2500) continue;
    pendingPings.delete(id);
    if (probeMode === 'ws') recordProbe(false);
  }
  if (probeMode === 'ws' && !pingTimes.length && probeResults.filter(ok => !ok).length >= 3) {
    probeMode = 'http';
    pendingPings.clear(); probeResults.length = 0;
  }
  if (probeMode === 'http') {
    // Keep checking for an upgraded server, then switch back to game-socket RTT.
    if (++probeCount % 10 === 0) {
      const id = ++pingId;
      pendingPings.set(id, now);
      send('net-ping', { id });
    }
    probeWeb();
    showNetStats();
    return;
  }
  const id = ++pingId;
  pendingPings.set(id, now);
  send('net-ping', { id });
  showNetStats();
}

function recordPong(id) {
  const sentAt = pendingPings.get(id);
  if (sentAt === undefined) return;
  pendingPings.delete(id);
  if (probeMode === 'http') {
    probeMode = 'ws';
    httpProbe?.abort();
    pingTimes.length = 0; probeResults.length = 0;
  }
  recordProbe(true);
  pingTimes.push(performance.now() - sentAt);
  if (pingTimes.length > 5) pingTimes.shift();
  showNetStats();
}

document.addEventListener('visibilitychange', () => {
  pendingPings.clear();
  if (document.hidden) { httpProbe?.abort(); showNetStats(); return; }
  pingTimes.length = 0; probeResults.length = 0;
  probeConnection();
});

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  welcomed = false;
  socket = new WebSocket(`${protocol}//${location.host}/?game=brawl&room=${encodeURIComponent(wantRoom)}`);
  socket.onopen = () => {
    status.textContent = 'Tilkoblet';
    timeline.clear(); predictor.reset(); inputVersion = 1; inputSeq = 0; queuedJump = false; queuedUpair = false;
    combatFeatures = false; throwsEnabled = false; teamsEnabled = false; emotesEnabled = false;
    stopEmoteSpeech();
    emoteButton.hidden = true;
    matchSetup.hidden = true; extraControls.hidden = true; throwHint.hidden = true;
    throwPad.hidden = true; extraTouch.forEach(button => { button.hidden = true; });
    probeMode = 'ws'; probeCount = 0; httpProbe?.abort();
    pendingPings.clear(); pingTimes.length = 0; probeResults.length = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(probeConnection, 1000);
    probeConnection();
  };
  socket.onmessage = ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'net-pong') {
      recordPong(m.id);
    } else if (m.t === 'brawl-welcome') {
      welcomed = true; wantRoom = 'auto';
      pendingRestart = false;
      myId = m.id;
      inputVersion = m.inputVersion || 1;
      combatFeatures = ['shield', 'grab', 'upair'].every(feature => m.features?.includes(feature));
      throwsEnabled = combatFeatures && !!m.features?.includes('throws');
      teamsEnabled = !!m.features?.includes('teams');
      emotesEnabled = !!m.features?.includes('emotes');
      matchSetup.hidden = !teamsEnabled;
      const available = m.roster || ['mario', 'yoshi', 'pikachu'];
      initialCards.forEach((card, index) => { card.disabled = !available.includes(Object.keys(FIGHTERS)[index]); });
      if (!available.includes(selected)) {
        selected = available[0] || 'mario';
        initialCards.forEach((card, index) => card.classList.toggle('selected', Object.keys(FIGHTERS)[index] === selected));
      }
      const availableWorlds = Object.keys(m.worlds || {});
      worldGrid.hidden = availableWorlds.length === 0;
      worldCards.forEach(card => { card.button.disabled = !availableWorlds.includes(card.key); });
      if (availableWorlds.length && !availableWorlds.includes(selectedWorld)) selectedWorld = availableWorlds[0];
      updateWorldSelection();
      extraControls.hidden = !combatFeatures;
      throwHint.hidden = !throwsEnabled;
      extraTouch.forEach(button => { button.hidden = !combatFeatures; });
      send('brawl-character', { character: selected });
      if (availableWorlds.length) send('brawl-world', { world: selectedWorld });
      if (nameInput.value.trim()) send('brawl-name', { name: nameInput.value.trim() });
    } else if (m.t === 'welcome') {
      status.textContent = 'Spillserveren starter snart på nytt';
      hint.textContent = 'De nye spillfilene er lagt ut. Venter på at spilltjenesten på trashcan starter på nytt.';
      readyButton.disabled = true;
      readyButton.textContent = 'Serveroppdatering venter';
      pendingRestart = true;
      socket.close();
    } else if (m.t === 'brawl-state') {
      state = m; receivedAt = performance.now();
      timeline.push(m, receivedAt);
      const mine = m.players.find(player => player.id === myId);
      if (m.phase === 'playing' && mine && !mine.spectator && !mine.rush && !mine.swing) {
        const meanPing = pingTimes.length
          ? pingTimes.reduce((sum, ms) => sum + ms, 0) / pingTimes.length : 70;
        predictor.reconcile(mine, receivedAt, meanPing / 2);
      } else predictor.reset(mine || null);
      onState(m);
    }
  };
  socket.onclose = (event) => {
    clearInterval(pingTimer); pingTimer = null;
    httpProbe?.abort();
    pendingPings.clear(); showNetStats();
    timeline.clear(); predictor.reset(); queuedJump = false; queuedUpair = false;
    throwPad.hidden = true;
    emoteButton.hidden = true;
    stopEmoteSpeech();
    myId = null; state = null; lobby.hidden = splash || browsing;
    if (leaving) { leaving = false; return; }                       // went back to the room list on purpose
    if (!welcomed && event.code === 1013) { showRooms('Rommet er ikke lenger åpent. Velg et annet.'); return; }   // the chosen room closed or was full
    status.textContent = pendingRestart ? 'Spillserveren starter snart på nytt' : 'Kobler til igjen …';
    readyButton.disabled = true;
    readyButton.textContent = pendingRestart ? 'Serveroppdatering venter' : 'Kobler til igjen …';
    setTimeout(connect, pendingRestart ? 10000 : 1500);
  };
}

function setFlash(text, duration = 800) {
  visibleFlash = text; flashUntil = performance.now() + duration;
}

function sound(kind, amount = 1) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const now = audio.currentTime;
    const tone = (type, start, end, length, gain) => {
      const osc = audio.createOscillator(), vol = audio.createGain();
      osc.type = type; osc.frequency.setValueAtTime(start, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, end), now + length);
      vol.gain.setValueAtTime(gain, now);
      vol.gain.exponentialRampToValueAtTime(0.001, now + length);
      osc.connect(vol).connect(audio.destination); osc.start(now); osc.stop(now + length);
    };
    if (kind === 'hit') {
      tone('sawtooth', 190 + amount * 0.16, 58, 0.16, 0.17);
      tone('square', 780 + amount * 0.3, 180, 0.11, 0.10);
    } else if (kind === 'ko') {
      tone('sawtooth', 650, 110, 0.42, 0.20);
      tone('triangle', 900, 235, 0.5, 0.12);
    } else if (kind === 'block') {
      tone('triangle', 480, 155, 0.16, 0.10);
      tone('square', 900, 360, 0.08, 0.03);
    } else if (kind === 'shieldbreak') {
      tone('sawtooth', 760, 85, 0.44, 0.17);
      tone('triangle', 1100, 210, 0.48, 0.10);
    } else if (kind === 'grab') tone('sawtooth', 300, 105, 0.18, 0.11);
    else if (kind === 'throw') {
      tone('triangle', 260, 640, 0.15, 0.12);
      tone('sawtooth', 540, 100, 0.24, 0.10);
    }
    else if (kind === 'recovery') tone('triangle', 210, 850, 0.26, 0.11);
    else if (kind === 'hook') {
      tone('triangle', 950, 310, 0.21, 0.12);
      tone('sine', 430, 190, 0.28, 0.08);
    } else if (kind === 'waft') {
      tone('sawtooth', 155, 55, 0.29, 0.15);
      tone('triangle', 330, 75, 0.4, 0.10);
    } else if (kind === 'dinblast') {
      tone('triangle', 980, 180, 0.34, 0.15);
      tone('sine', 490, 90, 0.42, 0.13);
    } else if (kind === 'cape') {
      tone('triangle', 700, 240, 0.2, 0.11);
      tone('sine', 380, 160, 0.24, 0.07);
    } else if (kind === 'thunder') {
      tone('sawtooth', 95, 440, 0.38, 0.045);
      tone('triangle', 570, 160, 0.44, 0.05);
    } else if (kind === 'thunderimpact') {
      tone('sawtooth', 1050, 70, 0.31, 0.18);
      tone('square', 570, 100, 0.23, 0.09);
    } else if (kind === 'egg') {
      tone('triangle', 450, 145, 0.22, 0.12);
      tone('sine', 230, 120, 0.3, 0.07);
    } else if (kind === 'eggpop') {
      tone('triangle', 170, 710, 0.17, 0.1);
    } else if (kind === 'roll') {
      tone('triangle', 540, 125, 0.24, 0.11);
      tone('sawtooth', 210, 80, 0.19, 0.045);
    } else if (kind === 'emote') {
      tone('sine', 440, 660, 0.2, 0.075);
      tone('triangle', 660, 880, 0.24, 0.065);
    }
    else if (kind === 'swing') tone('triangle', 430, 120, 0.09, 0.055);
    else if (kind === 'jump') tone('square', 180, 370, 0.12, 0.035);
    else if (kind === 'go') {
      tone('square', 400, 600, 0.18, 0.08);
      tone('triangle', 600, 850, 0.22, 0.06);
    }
  } catch { /* Audio is optional; gameplay still works if unavailable. */ }
}

function stopEmoteSpeech() {
  if (activeUtterance) {
    try { window.speechSynthesis?.cancel(); } catch { /* Speech is optional. */ }
  }
  activeUtterance = null;
  speakingPlayerId = null;
}

function speakEmote(event) {
  const line = BRAWL_EMOTE_LINES[event.character];
  if (!line || document.hidden || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
  try {
    stopEmoteSpeech(); // Don't queue stale lines when several fighters dance together.
    const utterance = new SpeechSynthesisUtterance(line.speech);
    utterance.lang = line.lang || 'nb-NO';
    utterance.pitch = line.pitch;
    utterance.rate = line.rate;
    utterance.volume = 0.85;
    activeUtterance = utterance;
    speakingPlayerId = event.p;
    const clear = () => {
      if (activeUtterance === utterance) { activeUtterance = null; speakingPlayerId = null; }
    };
    utterance.onend = clear;
    utterance.onerror = clear;
    window.speechSynthesis.speak(utterance);
  } catch { stopEmoteSpeech(); }
}

function burst(x, y, color, count = 12, speed = 190) {
  for (let i = 0; i < count; i++) {
    const a = Math.PI * 2 * i / count + Math.random() * 0.3;
    const s = speed * (0.45 + Math.random() * 0.75);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.45, color, size: 3 + Math.random() * 5 });
  }
}

function onState(s) {
  if (speakingPlayerId !== null && !s.players.some(p => p.id === speakingPlayerId && p.emoteTime > 0))
    stopEmoteSpeech();
  const self = s.players.find(p => p.id === myId);
  const confounded = s.phase === 'playing' && self && !self.spectator && self.stocks > 0 &&
    self.respawn <= 0 && self.confuseTime > 0;
  confundoNotice.hidden = !confounded;
  if (confounded) confundoFill.style.width = `${Math.max(0, Math.min(100, self.confuseTime / CONFUNDO.duration * 100))}%`;
  emoteButton.hidden = !emotesEnabled || s.phase !== 'playing' || !self || self.spectator || self.stocks <= 0;
  emoteButton.disabled = !self || self.respawn > 0 || !self.grounded || self.emoteCooldown > 0;
  emoteButton.textContent = self?.emoteCooldown > 0 ? `Dans ${self.emoteCooldown.toFixed(1)} s` : 'Dans · E';
  const matchWorld = Object.hasOwn(BRAWL_WORLDS, s.world) ? s.world : 'dolomittene';
  const shownWorld = s.phase === 'playing' || s.phase === 'countdown' ? matchWorld : selectedWorld;
  document.body.dataset.world = shownWorld;
  worldStatus.textContent = s.phase === 'playing' || s.phase === 'countdown'
    ? BRAWL_WORLDS[matchWorld] : `Verdensvalg · ${BRAWL_WORLDS[selectedWorld]}`;
  for (const card of worldCards) {
    const votes = s.players.filter(p => !p.spectator && p.worldVote === card.key).length;
    card.count.textContent = `${votes} ${votes === 1 ? 'stemme' : 'stemmer'}`;
  }
  const uiSignature = JSON.stringify([myId, s.phase, s.winner, s.winnerTeam, s.mode, s.friendlyFire,
    s.hostId, Math.floor(s.elapsed),
    s.players.map(p => [p.id, p.name, p.character, p.team, p.ready, p.spectator, p.percent, p.stocks])]);
  if (uiSignature !== lastUiSignature) {
  lastUiSignature = uiSignature;
  const me = s.players.find(p => p.id === myId);
  lobby.hidden = splash || browsing || s.phase === 'playing' || s.phase === 'countdown';
  status.textContent = me?.spectator && (s.phase === 'playing' || s.phase === 'countdown') ? 'Ser på · neste kamp' :
    s.phase === 'playing' ? `Direkte · ${formatTime(s.elapsed)}` :
    s.phase === 'countdown' ? 'Kampen starter' :
    s.phase === 'results' ? 'Kampen er over' : `Lobby · rom ${s.room ?? 1} · venter på spillere`;
  const sorted = [...s.players].sort((a, b) => a.id - b.id);
  const active = sorted.filter(p => !p.spectator);
  const teamMode = s.mode === 'teams';
  const teamCounts = { red: active.filter(p => p.team === 'red').length,
    blue: active.filter(p => p.team === 'blue').length };
  const bothTeams = teamCounts.red > 0 && teamCounts.blue > 0;
  const canConfigure = myId === s.hostId && s.phase === 'lobby';
  matchRule.textContent = teamMode ? `Lagkamp · lagskade ${s.friendlyFire ? 'på' : 'av'} · 3 liv`
    : 'Siste mann står · 3 liv';
  modeFfa.classList.toggle('selected', !teamMode);
  modeTeams.classList.toggle('selected', teamMode);
  modeFfa.setAttribute('aria-pressed', String(!teamMode));
  modeTeams.setAttribute('aria-pressed', String(teamMode));
  modeFfa.disabled = modeTeams.disabled = !canConfigure;
  friendlyFireButton.hidden = !teamMode;
  friendlyFireButton.disabled = !canConfigure;
  friendlyFireButton.classList.toggle('selected', !!s.friendlyFire);
  friendlyFireButton.setAttribute('aria-pressed', String(!!s.friendlyFire));
  friendlyFireButton.textContent = `Lagskade: ${s.friendlyFire ? 'på' : 'av'}`;
  teamGrid.hidden = !teamMode;
  for (const button of teamButtons) {
    const team = button.dataset.team;
    button.textContent = `${TEAM_NAMES[team]} ${teamCounts[team]}/2`;
    button.classList.toggle('selected', me?.team === team);
    button.setAttribute('aria-pressed', String(me?.team === team));
    button.disabled = !me || me.spectator || s.phase !== 'lobby' ||
      (me.team !== team && teamCounts[team] >= 2);
  }
  modeHint.textContent = canConfigure ? 'Du er romvert · velg kampregler'
    : 'Romverten velger kampmodus og lagskade';
  roster.replaceChildren(...sorted.map(p => {
    const div = document.createElement('div');
    div.className = `rosterName${p.ready ? ' ready' : ''}${p.id === myId ? ' mine' : ''}${teamMode && !p.spectator ? ` ${p.team}` : ''}`;
    div.textContent = `${p.spectator ? 'Ser på · ' : p.ready ? '✓ ' : '○ '}${teamMode && !p.spectator ? `${TEAM_NAMES[p.team]} · ` : ''}${p.name} · ${FIGHTERS[p.character]?.label || 'Mario'}`;
    return div;
  }));
  card.classList.toggle('results', s.phase === 'results');
  updatePodium(sorted.filter(p => !p.spectator), teamMode);
  if (!sorted.length) hint.textContent = 'Venter på spillere …';
  else if (me?.spectator) hint.textContent = 'Rommet er fullt. Du blir med i en senere kamp når det blir en ledig plass.';
  else if (s.phase === 'results') {
    const victor = sorted.find(p => p.id === s.winner);
    hint.textContent = teamMode && s.winnerTeam ? `${TEAM_NAMES[s.winnerTeam]} lag vinner! Trykk start for en ny runde.`
      : victor ? `${victor.name} vinner! Trykk start for en ny runde.` : 'Runden er over. Trykk start for å spille igjen.';
  } else hint.textContent = `${active.filter(p => p.ready).length}/${active.length} klare · ${teamMode && !bothTeams ? 'trenger ett rødt og ett blått lag' : 'minst to spillere · opptil fire kan slåss'}`;
  readyButton.disabled = !me || me.spectator;
  readyButton.textContent = me?.spectator ? 'Venter på plass' :
    s.phase === 'results' ? 'Start neste kamp' : me?.ready ? 'Avbryt klar' : 'Start / klar';
  if (s.phase === 'results') {
    const victor = sorted.find(p => p.id === s.winner);
    document.querySelector('.card h1').textContent = teamMode && s.winnerTeam ? `${TEAM_NAMES[s.winnerTeam]} lag vinner!`
      : victor ? `${victor.name} vinner!` : 'Uavgjort!';
  } else document.querySelector('.card h1').textContent = 'Slagbrødre';
  scores.replaceChildren(...active.map(p => {
    const div = document.createElement('div');
    div.className = `score${p.id === myId ? ' me' : ''}${p.stocks <= 0 ? ' out' : ''}`;
    div.dataset.playerId = p.id;
    div.style.setProperty('--color', teamMode ? BRAWL_TEAMS[p.team] : FIGHTERS[p.character]?.color || '#fff');
    const who = document.createElement('div'); who.className = 'who';
    who.textContent = `${teamMode ? `${TEAM_NAMES[p.team]} · ` : ''}${p.name}${p.id === myId ? ' · deg' : ''}`;
    const damage = document.createElement('div'); damage.className = 'damage';
    damage.style.color = p.percent >= 120 ? '#ff695c' : p.percent >= 65 ? '#ffc868' : '#fff7ec';
    damage.textContent = `${p.percent}%`;
    const stocks = document.createElement('span'); stocks.className = 'stock';
    stocks.textContent = '●'.repeat(Math.max(0, p.stocks)) + '○'.repeat(Math.max(0, 3 - p.stocks));
    const shieldTrack = document.createElement('div'); shieldTrack.className = 'shieldTrack';
    const shieldFill = document.createElement('div'); shieldFill.className = 'shieldFill';
    shieldTrack.append(shieldFill);
    damage.append(stocks); div.append(who, damage, shieldTrack);
    if (p.character === 'wario') {
      const meter = document.createElement('div'); meter.className = 'waftMeter';
      const label = document.createElement('span'); label.textContent = 'Fis';
      const track = document.createElement('div'); track.className = 'waftTrack';
      const fill = document.createElement('div'); fill.className = 'waftFill';
      track.append(fill); meter.append(label, track); div.append(meter);
    }
    return div;
  }));
  }
  for (const card of scores.children) {
    const fighter = s.players.find(p => String(p.id) === card.dataset.playerId);
    if (!fighter) continue;
    card.querySelector('.shieldFill').style.width = `${Math.max(0, Math.min(100, fighter.shield ?? 100))}%`;
    card.classList.toggle('guarding', !!fighter.shielding);
    const waftFill = card.querySelector('.waftFill');
    if (waftFill) waftFill.style.width = `${Math.round((fighter.waftCharge ?? 0) * 100)}%`;
  }
  throwPad.hidden = !throwsEnabled || !s.players.some(p => p.id === myId && p.grabTarget);
  if (previousPhase !== s.phase) {
    if (s.phase === 'playing') { setFlash('Kjør!', 850); sound('go'); }
    previousPhase = s.phase;
  }
  for (const event of s.events) {
    if (event.type === 'hit') {
      burst(event.x, event.y, event.power > 800 ? '#fff1a3' : '#f3d59a', event.power > 800 ? 22 : 13, Math.min(350, event.power * 0.34));
      shake = Math.max(shake, Math.min(10, event.power / 130));
      sound('hit', event.power);
    } else if (event.type === 'ko') {
      burst(event.x, Math.max(35, Math.min(470, event.y)), '#fff3bf', 30, 360);
      setFlash(event.stocks > 0 ? 'Liv tapt!' : 'K.O.!', 900);
      shake = 13; sound('ko');
    } else if (event.type === 'swing') sound('swing');
    else if (event.type === 'block') { burst(event.x, event.y - 38, '#9be7ff', 8, 140); sound('block'); }
    else if (event.type === 'shieldbreak') { burst(event.x, event.y - 38, '#fff5b7', 24, 260); setFlash('Skjoldet knust!', 750); sound('shieldbreak'); }
    else if (event.type === 'grab') { burst(event.x, event.y, '#ffd3a6', 10, 160); sound('grab'); }
    else if (event.type === 'throw') { burst(event.x, event.y, '#ffe0a1', 15, 225); sound('throw'); }
    else if (event.type === 'recovery') { burst(event.x, event.y, '#b2eaff', 12, 170); sound('recovery'); }
    else if (event.type === 'hook') { burst(event.x, event.y, '#e8f7d0', 11, 130); sound('hook'); }
    else if (event.type === 'waft') {
      waftEffects.push({ x: event.x, y: event.y, radius: event.radius, life: 0.38 });
      burst(event.x, event.y, '#d6ed96', 16 + Math.round(event.charge * 14), 130 + event.charge * 190);
      sound('waft');
    } else if (event.type === 'dinblast') {
      dinEffects.push({ x: event.x, y: event.y, radius: event.radius, life: 0.32 });
      burst(event.x, event.y, '#e4a7ff', 22, 250);
      shake = Math.max(shake, 4);
      sound('dinblast');
    } else if (event.type === 'micwave') {
      micEffects.push({ x: event.x, y: event.y, radius: event.radius || MIC_WAVE.radius, life: 0.38 });
      burst(event.x, event.y, '#d8bd78', 22, 230);
      shake = Math.max(shake, 5); sound('hit', 550);
    } else if (event.type === 'leviosacast') {
      spellEffects.push({ x: event.x, y: event.y, x2: event.x2, y2: event.y2, life: 0.32 });
      burst(event.x2, event.y2, '#d6e8ff', 10, 105); sound('recovery');
    } else if (event.type === 'confundo' || event.type === 'ferrethex') {
      const ferret = event.type === 'ferrethex';
      spellEffects.push({ x: event.x, y: event.y, x2: event.x2, y2: event.y2,
        color: ferret ? '#bce88b' : '#c8a9ed', life: 0.32 });
      burst(event.x2, event.y2, ferret ? '#bce88b' : '#c8a9ed', 14, 135); sound('recovery');
    } else if (event.type === 'ward') {
      burst(event.x, event.y, '#a9ddff', 14, 100); sound('block');
    } else if (event.type === 'protego') {
      burst(event.x, event.y, '#d4f3ff', 24, 210); sound('shieldbreak');
    } else if (event.type === 'serpent') {
      burst(event.x, event.y, '#a9df92', 13, 115); sound('egg');
    } else if (event.type === 'snakebite') {
      burst(event.x, event.y, '#d5ef94', 12, 150); sound('hit', 240);
    } else if (event.type === 'puddle') {
      burst(event.x, event.y, '#a9c46d', 18, 115); sound('waft');
    } else if (event.type === 'webpad') {
      burst(event.x, event.y, '#d8efff', 16, 125); sound('recovery');
    } else if (event.type === 'webbounce') {
      burst(event.x, event.y, '#e3f7ff', 12, 165); sound('jump');
    } else if (event.type === 'webswing') {
      burst(event.x2, event.y2, '#f2faff', 10, 90); sound('hook');
    } else if (event.type === 'webrelease') {
      burst(event.x, event.y, '#e3f7ff', 8, 110); sound('jump');
    } else if (event.type === 'arrowtrap') {
      burst(event.x, event.y - 4, '#d4ba7d', 10, 80); sound('egg');
    } else if (event.type === 'traptrigger') {
      burst(event.x, event.y - 10, '#f6dfa6', 22, 200); sound('hit', 240);
    } else if (event.type === 'cape') sound('cape');
    else if (event.type === 'capeturn') burst(event.x, event.y, '#fff0b1', 13, 170);
    else if (event.type === 'tongue') sound('swing');
    else if (event.type === 'special2') sound('swing');
    else if (event.type === 'rush') { burst(event.x, event.y - 20, event.kind === 'quick' ? '#fff4a1' : event.kind === 'shoulder' ? '#dcc999' : '#f6f0cf', 9, 170); sound('swing'); }
    else if (event.type === 'farore') {
      burst(event.x, event.y - 38, '#e4a7ff', 16, 200); burst(event.x2, event.y2 - 38, '#f1d68f', 16, 200); sound('recovery');
    }
    else if (event.type === 'egg') { burst(event.x, event.y, '#f6f0cf', 15, 180); sound('egg'); }
    else if (event.type === 'eggpop') { burst(event.x, event.y, '#fff7dc', 18, 190); sound('eggpop'); }
    else if (event.type === 'thunder') sound('thunder');
    else if (event.type === 'thunderimpact') {
      burst(event.x, event.y, '#fff7ba', 23, 285);
      shake = Math.max(shake, 6);
      sound('thunderimpact');
    } else if (event.type === 'roll') {
      burst(event.x - event.dir * 12, event.y - 8, '#e1debd', 9, 95);
      sound('roll');
    } else if (event.type === 'emote') {
      burst(event.x, event.y - 66, FIGHTERS[event.character]?.accent || '#fff3bf', 7, 65);
      sound('emote');
      speakEmote(event);
    }
    else if (event.type === 'jump' || event.type === 'doublejump') sound('jump');
    else if (event.type === 'go') setFlash('Kjør!', 850);
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const initialCards = Object.entries(FIGHTERS).map(([key, fighter]) => {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'fighterChoice';
  button.title = fighter.special;
  button.setAttribute('aria-label', `${fighter.label}: ${fighter.special}`);
  const portrait = document.createElement('canvas'); portrait.width = 88; portrait.height = 105;
  const context = portrait.getContext('2d'); context.imageSmoothingEnabled = false;
  context.fillStyle = '#173b4b'; context.fillRect(0, 0, 88, 105);
  drawFighter(context, key, 44, 94, 2.55, 1, null, 0, false);
  const label = document.createElement('strong'); label.textContent = fighter.label;
  button.append(portrait, label);
  button.addEventListener('click', () => {
    selected = key; initialCards.forEach((card, i) => card.classList.toggle('selected', Object.keys(FIGHTERS)[i] === key));
    send('brawl-character', { character: key });
  });
  grid.append(button);
  return button;
});
initialCards[0].classList.add('selected');

const worldCards = Object.entries(BRAWL_WORLDS).map(([key, label]) => {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'worldChoice';
  const preview = document.createElement('canvas'); preview.width = 240; preview.height = 135;
  const details = document.createElement('span');
  const title = document.createElement('strong'); title.textContent = label;
  const count = document.createElement('small'); count.textContent = '0 stemmer';
  details.append(title, count); button.append(preview, details);
  button.addEventListener('click', () => {
    selectedWorld = key;
    localStorage.setItem('brawl-world', key);
    updateWorldSelection();
    send('brawl-world', { world: key });
  });
  worldGrid.append(button);
  return { key, button, preview, count };
});

function updateWorldSelection() {
  for (const card of worldCards) card.button.classList.toggle('selected', card.key === selectedWorld);
  if (state?.phase !== 'playing' && state?.phase !== 'countdown') {
    document.body.dataset.world = selectedWorld;
    worldStatus.textContent = `Verdensvalg · ${BRAWL_WORLDS[selectedWorld]}`;
  }
}
updateWorldSelection();

modeFfa.addEventListener('click', () => send('brawl-mode', { mode: 'ffa' }));
modeTeams.addEventListener('click', () => send('brawl-mode', { mode: 'teams' }));
friendlyFireButton.addEventListener('click', () =>
  send('brawl-friendly-fire', { enabled: !state?.friendlyFire }));
for (const button of teamButtons) button.addEventListener('click', () =>
  send('brawl-team', { team: button.dataset.team }));

nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim();
  localStorage.setItem('brawl-name', name);
  send('brawl-name', { name });
});
readyButton.addEventListener('click', () => {
  const me = state?.players.find(p => p.id === myId);
  if (!me) return;
  const name = nameInput.value.trim();
  if (name) { localStorage.setItem('brawl-name', name); send('brawl-name', { name }); }
  send('brawl-ready', { ready: state.phase === 'results' ? true : !me.ready });
  sound('go');
});

function inputMove() {
  return (keys.has('d') || keys.has('arrowright') || keys.has('touchright') ? 1 : 0) -
    (keys.has('a') || keys.has('arrowleft') || keys.has('touchleft') ? 1 : 0);
}
function throwDirection() {
  return {
    dirX: inputMove(),
    dirY: (keys.has('s') || keys.has('arrowdown') ? 1 : 0) -
      (keys.has('w') || keys.has('arrowup') ? 1 : 0),
  };
}
function action(name) {
  if (['grab', 'upair'].includes(name) && !combatFeatures) return;
  if (name === 'emote' && !emotesEnabled) return;
  if (name === 'upair') { queuedUpair = true; return; }
  if (name === 'jump') {
    if (state?.players.some(p => p.id === myId && p.grabTarget)) return;
    queuedJump = true;
    // The older server still expects a separate action message.
    if (inputVersion < 2) send('brawl-action', { action: name });
    return;
  }
  if (name === 'grab' && throwsEnabled) {
    if (state?.players.some(p => p.id === myId && p.grabTarget)) queuedJump = false;
    send('brawl-action', { action: name, ...throwDirection() });
  } else send('brawl-action', { action: name });
}
window.addEventListener('keydown', event => {
  if (!howto.hidden) { if (event.key === 'Escape') closeHowto(); return; }     // the how-to pop-up is open: keys only close it
  if (splash) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); leaveSplash(); }
    return;
  }
  if (browsing) return;
  if (event.target === nameInput) return;
  const key = event.key.toLowerCase();
  if ([' ', 'arrowleft', 'arrowright', 'arrowdown', 'arrowup'].includes(key)) event.preventDefault();
  if (keys.has(key)) return;
  keys.add(key);
  if (key === ' ' || key === 'w' || key === 'arrowup') action('jump');
  else if (key === 'j') action('jab');
  else if (key === 'k') action('smash');
  else if (key === 'l') action('special');
  else if (key === 'u') action('special2');
  else if (key === 'h') action('grab');
  else if (key === 'i') action('upair');
  else if (key === 'e') action('emote');
});
emoteButton.addEventListener('click', () => action('emote'));
window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
for (const [id, key, actionName] of [
  ['tl', 'touchleft'], ['tr', 'touchright'], ['tj', null, 'jump'],
  ['ta', null, 'jab'], ['ts', null, 'smash'], ['tp', null, 'special'], ['tq', null, 'special2'],
  ['tg', null, 'grab'], ['tshield', 'touchshield'], ['tu', null, 'upair'],
]) {
  const button = document.getElementById(id);
  button.addEventListener('pointerdown', event => {
    event.preventDefault(); button.setPointerCapture(event.pointerId);
    if (key) keys.add(key); else action(actionName);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    button.addEventListener(type, () => { if (key) keys.delete(key); });
}
for (const button of throwPad.querySelectorAll('button')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    send('brawl-action', { action: 'throw', dirX: Number(button.dataset.x), dirY: Number(button.dataset.y) });
  });
}
function tickLocal(now) {
  const me = state?.players.find(player => player.id === myId);
  if (state?.phase !== 'playing' || !me || me.spectator) {
    queuedJump = false; queuedUpair = false;
    return;
  }
  const input = {
    seq: ++inputSeq,
    move: inputMove(),
    down: keys.has('s') || keys.has('arrowdown'),
    shield: combatFeatures && (keys.has('shift') || keys.has('touchshield')),
    jump: queuedJump,
    upair: queuedUpair,
  };
  queuedJump = false; queuedUpair = false;
  predictor.step(input, now);
  send('brawl-input', input);
}

function drawFighter(g, character, x, feet, scale, face, attackKind, attackTime, invuln) {
  g.save();
  g.translate(Math.round(x), Math.round(feet));
  g.scale(scale * face, scale);
  g.translate(-12, -34);
  const r = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
  const o = '#203743';
  if (invuln) g.globalAlpha = 0.62 + Math.sin(performance.now() / 50) * 0.25;
  const attacking = attackKind && attackTime > (ATTACKS[attackKind]?.startup || 0);
  if (character === 'mario') {
    r(5, 27, 7, 5, o); r(4, 30, 8, 3, '#70433b'); r(14, 27, 7, 5, o); r(14, 30, 8, 3, '#70433b');
    r(5, 17, 16, 12, o); r(7, 18, 12, 11, '#3988dd');
    r(8, 17, 4, 8, '#ee4a4d'); r(15, 17, 4, 8, '#ee4a4d');
    r(9, 22, 2, 2, '#ffdb7b'); r(17, 22, 2, 2, '#ffdb7b');
    r(attacking ? 19 : 2, attacking ? 12 : 19, 6, 6, o);
    r(attacking ? 20 : 3, attacking ? 13 : 20, 5, 5, '#fff2d7');
    r(6, 7, 16, 11, o); r(7, 8, 14, 9, '#f3b47f');
    r(17, 10, 7, 5, '#f3b47f'); r(11, 13, 10, 3, '#3e2c36');
    r(15, 8, 2, 4, '#171824');
    r(4, 3, 18, 6, o); r(5, 2, 16, 6, '#ee4a4d'); r(2, 8, 20, 3, '#d93943');
    r(11, 4, 4, 3, '#fff4dd'); r(12, 5, 2, 1, '#e2505c');
  } else if (character === 'yoshi') {
    r(4, 28, 8, 5, o); r(4, 29, 8, 4, '#ed6766'); r(15, 28, 8, 5, o); r(15, 29, 8, 4, '#ed6766');
    r(7, 16, 15, 14, o); r(8, 17, 13, 12, '#67ce70'); r(10, 18, 9, 10, '#f4edcf');
    r(17, 15, 4, 3, '#e86852'); r(21, 18, 3, 4, '#68d171');
    r(attacking ? 20 : 2, attacking ? 12 : 20, 6, 5, '#6bd776');
    r(7, 6, 14, 12, o); r(8, 5, 13, 13, '#70d765');
    r(14, 2, 4, 6, '#79dd7b'); r(19, 3, 4, 6, '#7be37e');
    r(13, 5, 4, 6, '#fffefa'); r(18, 6, 3, 5, '#fffefa');
    r(15, 7, 2, 3, o); r(19, 7, 2, 3, o);
    r(4, 11, 18, 8, o); r(3, 10, 18, 8, '#79de78'); r(4, 15, 14, 3, '#f1eee2');
    r(4, 12, 2, 2, '#2c6c44'); r(9, 12, 2, 2, '#2c6c44');
    r(21, 10, 3, 3, '#ee6b4d'); r(22, 14, 3, 3, '#ee6b4d');
  } else if (character === 'pikachu') {
    r(3, 24, 6, 7, o); r(4, 25, 5, 6, '#e3b546'); r(16, 24, 6, 7, o); r(17, 25, 5, 6, '#e3b546');
    r(6, 14, 14, 13, o); r(7, 15, 12, 12, '#f8d74d');
    r(2, 2, 5, 14, o); r(3, 6, 4, 10, '#f8d74d'); r(3, 2, 4, 5, '#333048');
    r(17, 1, 5, 14, o); r(17, 5, 4, 10, '#f8d74d'); r(18, 1, 4, 5, '#333048');
    r(5, 9, 16, 11, o); r(6, 9, 14, 11, '#f8d74d');
    r(8, 12, 2, 4, o); r(17, 12, 2, 4, o); r(11, 16, 5, 2, '#a36f42');
    r(4, 17, 5, 4, '#ed6860'); r(18, 17, 5, 4, '#ed6860');
    r(attacking ? 20 : 1, attacking ? 11 : 20, 5, 5, '#f8d74d');
    r(20, 22, 4, 4, '#9e5f36'); r(23, 19, 3, 4, '#f8d74d');
    r(20, 15, 3, 4, '#f8d74d');
  } else if (character === 'isabelle') {
    r(4, 27, 8, 5, o); r(5, 28, 7, 4, '#704b39');
    r(16, 27, 8, 5, o); r(17, 28, 6, 4, '#704b39');
    r(5, 17, 17, 12, o); r(6, 18, 15, 10, '#a9cc7d');
    r(7, 25, 14, 4, '#344f57'); r(13, 18, 3, 8, '#f6edcf');
    r(attacking ? 20 : 2, attacking ? 13 : 19, 5, 6, '#f5d58a');
    r(1, 9, 6, 10, o); r(2, 10, 5, 8, '#e8b865');
    r(20, 8, 6, 11, o); r(21, 9, 4, 9, '#e8b865');
    r(5, 5, 18, 14, o); r(6, 6, 16, 12, '#f7d88b');
    r(11, 0, 6, 7, '#f2d383'); r(12, 1, 4, 4, '#dcac5b');
    r(8, 11, 2, 3, o); r(18, 11, 2, 3, o);
    r(11, 14, 6, 4, '#f8eed9'); r(13, 14, 3, 2, '#534044');
    r(11, 4, 6, 3, '#d8514e'); r(13, 2, 3, 7, '#e55d58');
  } else if (character === 'wario') {
    r(2, 27, 9, 5, o); r(3, 28, 8, 4, '#5d7ea8');
    r(16, 27, 9, 5, o); r(17, 28, 7, 4, '#5d7ea8');
    r(3, 16, 20, 13, o); r(4, 17, 18, 11, '#8655aa');
    r(8, 17, 11, 7, '#f5d34d'); r(9, 22, 2, 2, '#f6f0c3');
    r(18, 22, 2, 2, '#f6f0c3');
    r(attacking ? 21 : 0, attacking ? 10 : 19, 5, 7, '#f3eace');
    r(5, 6, 18, 12, o); r(6, 7, 16, 10, '#efb77f');
    r(18, 10, 7, 5, '#ecad77'); r(20, 11, 6, 4, '#e49b80');
    r(9, 13, 12, 3, '#34323b'); r(10, 15, 4, 2, '#34323b');
    r(16, 15, 4, 2, '#34323b'); r(15, 8, 3, 3, o);
    r(5, 2, 18, 6, o); r(6, 1, 16, 6, '#f5d34d');
    r(3, 7, 21, 3, '#e4b932'); r(12, 3, 4, 3, '#9162b6');
  } else if (character === 'zelda') {
    r(4, 28, 8, 5, o); r(5, 29, 7, 3, '#744f73');
    r(16, 28, 8, 5, o); r(17, 29, 6, 3, '#744f73');
    r(3, 20, 22, 10, o); r(4, 21, 20, 8, '#a96fc5');
    r(8, 23, 12, 6, '#e8cbe8'); r(11, 23, 6, 7, '#f4e2ca');
    r(6, 15, 17, 10, o); r(7, 16, 15, 8, '#ba83cf');
    r(12, 18, 5, 6, '#f0d490'); r(14, 19, 2, 3, '#8f5eaa');
    r(1, 16, 6, 8, o); r(2, 17, 5, 6, '#f4d5af');
    r(attacking ? 22 : 20, attacking ? 10 : 17, 6, 7, o);
    r(attacking ? 23 : 21, attacking ? 11 : 18, 5, 5, '#f4d5af');
    r(4, 5, 20, 15, o); r(5, 5, 18, 15, '#efcf73');
    r(7, 7, 15, 12, '#f5dcae');
    r(4, 10, 4, 11, '#dfb961'); r(21, 9, 3, 13, '#dfb961');
    r(6, 12, 2, 3, '#f4d5af'); r(22, 12, 3, 3, '#f4d5af');
    r(11, 11, 2, 3, o); r(18, 11, 2, 3, o);
    r(13, 16, 5, 2, '#bf827e');
    r(8, 5, 13, 4, '#efd67c'); r(10, 7, 7, 2, '#e8c970');
    r(8, 2, 14, 4, '#edcd69'); r(13, 0, 5, 5, '#f3d988');
    r(14, 2, 3, 3, '#a967c5');
  } else if (character === 'marx') {
    // Dark coat, white beard and a small red book.
    r(4, 28, 8, 5, o); r(5, 29, 7, 3, '#493c3c'); r(16, 28, 8, 5, o); r(17, 29, 6, 3, '#493c3c');
    r(4, 16, 20, 14, o); r(5, 17, 18, 12, '#5d4545'); r(11, 17, 6, 10, '#e6dbc4');
    r(3, 18, 5, 10, '#53413e'); r(attacking ? 21 : 20, attacking ? 11 : 18, 6, 9, '#d6ad86');
    r(4, 3, 20, 16, o); r(6, 5, 16, 12, '#d7ae8b');
    r(4, 2, 20, 7, '#39383b'); r(3, 6, 5, 8, '#39383b'); r(21, 6, 4, 8, '#39383b');
    r(8, 12, 15, 9, '#e8e4d8'); r(10, 15, 11, 6, '#faf1d9');
    r(10, 10, 3, 2, o); r(18, 10, 3, 2, o); r(13, 13, 6, 2, '#44383a');
    r(1, 19, 6, 8, '#a73f45'); r(2, 20, 4, 6, '#d57d72');
  } else if (character === 'doom') {
    // Green hood and angular metal mask.
    r(4, 28, 8, 5, o); r(5, 29, 7, 3, '#596c61'); r(16, 28, 8, 5, o); r(17, 29, 6, 3, '#596c61');
    r(4, 15, 20, 15, o); r(5, 16, 18, 13, '#53715d'); r(10, 18, 8, 8, '#809184');
    r(2, 18, 5, 8, '#597462'); r(attacking ? 22 : 20, attacking ? 11 : 17, 6, 10, '#819080');
    r(5, 2, 19, 17, o); r(6, 3, 17, 16, '#4d6858');
    r(8, 5, 14, 13, '#aab2a8'); r(9, 9, 12, 7, '#738077');
    r(9, 8, 5, 3, o); r(17, 8, 5, 3, o); r(12, 12, 7, 4, '#c2c6b6');
    r(13, 14, 2, 3, o); r(17, 14, 2, 3, o); r(4, 2, 7, 5, '#5f7a62');
    r(23, 17, 2, 8, '#d8bd78'); r(21, 15, 6, 4, '#c4c5b5');
  } else if (character === 'ron') {
    // Ginger hair, school robe, tie and wand.
    r(4, 28, 8, 5, o); r(5, 29, 7, 3, '#403b42'); r(16, 28, 8, 5, o); r(17, 29, 6, 3, '#403b42');
    r(4, 16, 20, 14, o); r(5, 17, 18, 12, '#403d4f'); r(10, 17, 8, 10, '#e8dcca');
    r(13, 18, 3, 7, '#ae5949'); r(3, 18, 5, 9, '#464253');
    r(attacking ? 21 : 20, attacking ? 10 : 18, 6, 8, '#edc4a0');
    r(6, 5, 17, 13, o); r(7, 6, 15, 11, '#ecc6a4');
    r(4, 2, 20, 7, '#ba653d'); r(3, 6, 5, 6, '#ba653d'); r(20, 5, 5, 6, '#ba653d');
    r(10, 10, 2, 3, o); r(18, 10, 2, 3, o); r(13, 14, 5, 2, '#9d7767');
    r(24, 9, 2, 15, '#644630');
  } else if (character === 'shrek') {
    // Broad ogre with tube ears, cream shirt and brown vest.
    r(2, 27, 10, 6, o); r(3, 28, 9, 4, '#654c39'); r(15, 27, 10, 6, o); r(16, 28, 8, 4, '#654c39');
    r(2, 15, 23, 15, o); r(3, 16, 21, 13, '#806145'); r(8, 16, 11, 11, '#e5d4a9');
    r(3, 18, 4, 8, '#85af51'); r(attacking ? 22 : 21, attacking ? 10 : 18, 6, 9, '#87b552');
    r(5, 4, 19, 15, o); r(6, 5, 17, 13, '#89bb5b');
    r(1, 4, 8, 5, o); r(2, 5, 7, 3, '#91c363'); r(21, 4, 8, 5, o); r(22, 5, 6, 3, '#91c363');
    r(10, 10, 3, 2, o); r(18, 10, 3, 2, o); r(13, 13, 8, 4, '#7fa94f');
    r(14, 15, 5, 2, '#5d753e');
  } else if (character === 'snape') {
    // Black robes, curtain-like hair, pale face and raised wand.
    r(4, 28, 8, 5, o); r(16, 28, 8, 5, o);
    r(3, 15, 22, 15, o); r(4, 16, 20, 13, '#303044');
    r(9, 18, 10, 10, '#45445b'); r(11, 18, 6, 8, '#b9b4bd');
    r(1, 18, 6, 10, '#343349'); r(attacking ? 21 : 20, attacking ? 10 : 18, 6, 8, '#d2b7a7');
    r(4, 3, 20, 16, o); r(7, 6, 15, 12, '#d7bbad');
    r(3, 2, 21, 7, '#202432'); r(3, 6, 5, 14, '#242835'); r(21, 5, 5, 15, '#242835');
    r(10, 11, 3, 2, o); r(18, 11, 3, 2, o); r(16, 12, 3, 5, '#c6a697');
    r(12, 17, 7, 2, '#705c65'); r(24, 7, 2, 18, '#8d6851');
  } else if (character === 'draco') {
    // Pale blond hair, Slytherin tie and dark school robe.
    r(4, 28, 8, 5, o); r(16, 28, 8, 5, o);
    r(4, 16, 20, 14, o); r(5, 17, 18, 12, '#303d40');
    r(10, 18, 8, 9, '#e7e4d8'); r(13, 18, 3, 8, '#65906e');
    r(2, 18, 6, 10, '#37464a'); r(attacking ? 21 : 20, attacking ? 10 : 18, 6, 8, '#ebd5be');
    r(5, 5, 19, 14, o); r(7, 7, 15, 11, '#ecd8c4');
    r(4, 2, 20, 7, '#e7d78d'); r(5, 5, 19, 3, '#d6c77f'); r(3, 7, 5, 6, '#dacd8d');
    r(10, 11, 2, 3, o); r(18, 11, 2, 3, o); r(13, 15, 6, 2, '#957b73');
    r(24, 8, 2, 17, '#624f46');
  } else if (character === 'katniss') {
    // Braid, hunting jacket, quiver and a curved bow in her forward hand.
    r(3, 28, 9, 5, o); r(4, 29, 7, 4, '#4a3b35');
    r(16, 28, 9, 5, o); r(17, 29, 7, 4, '#4a3b35');
    r(4, 15, 20, 15, o); r(5, 16, 18, 13, '#4d624c');
    r(10, 17, 8, 11, '#716a4d'); r(12, 17, 3, 8, '#b79867');
    r(1, 13, 5, 14, '#624936'); r(2, 12, 3, 8, '#c9a86c');
    r(2, 19, 3, 3, '#d4c395'); r(2, 23, 3, 3, '#d4c395');
    r(2, 18, 6, 10, '#536951');
    r(attacking ? 22 : 20, attacking ? 12 : 18, 6, 8, '#d8ad86');
    r(5, 4, 18, 14, o); r(6, 5, 16, 12, '#d9b08b');
    r(5, 1, 18, 8, '#3b302e'); r(4, 5, 5, 12, '#3b302e');
    r(21, 5, 4, 15, '#3b302e'); r(23, 13, 3, 13, '#4d3932');
    r(10, 10, 2, 3, o); r(18, 10, 2, 3, o); r(13, 14, 5, 2, '#9d7864');
    r(26, 6, 3, 22, '#7a543e'); r(29, 9, 2, 16, '#d4ad73');
    r(27, 5, 5, 4, '#a47b4f'); r(27, 26, 5, 4, '#a47b4f');
    r(31, 9, 1, 17, '#ead9ae');
  } else if (character === 'spiderman') {
    // Red mask, white eye lenses and the blue sides of the suit.
    r(3, 28, 9, 5, o); r(4, 29, 8, 4, '#b73846');
    r(16, 28, 9, 5, o); r(17, 29, 7, 4, '#b73846');
    r(4, 15, 20, 15, o); r(5, 16, 18, 13, '#4c7cbe');
    r(9, 16, 10, 10, '#c53b45'); r(12, 18, 4, 5, '#253849');
    r(10, 20, 8, 2, '#253849'); r(6, 26, 17, 3, '#b73846');
    r(1, 17, 6, 11, '#c53b45');
    r(attacking ? 22 : 20, attacking ? 10 : 17, 7, 10, '#c53b45');
    r(5, 3, 19, 15, o); r(6, 4, 17, 13, '#c53b45');
    r(7, 8, 7, 5, '#f5f4e8'); r(16, 8, 7, 5, '#f5f4e8');
    r(8, 11, 5, 2, '#c8dce6'); r(17, 11, 5, 2, '#c8dce6');
    r(14, 4, 2, 11, '#763d46'); r(6, 7, 18, 1, '#763d46');
    r(8, 14, 13, 1, '#763d46'); r(3, 20, 4, 2, '#793e4a');
    r(21, 21, 5, 2, '#793e4a');
  }
  g.restore();
}

function drawNightCity(g, time) {
  const sky = g.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, '#30336d'); sky.addColorStop(0.58, '#7161a2'); sky.addColorStop(1, '#c6799e');
  g.fillStyle = sky; g.fillRect(0, 0, 960, 540);
  g.fillStyle = '#ffe6a5'; g.beginPath(); g.arc(740, 105, 63, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f6acd0'; g.beginPath(); g.arc(740, 105, 49, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 8; i++) {
    const x = (i * 173 + Math.sin(time * 0.00013 + i) * 12) % 1050 - 45;
    const y = 70 + (i * 71) % 180;
    g.fillStyle = i % 2 ? '#9d81b7b0' : '#aa93c9a8';
    g.fillRect(x, y, 76, 15); g.fillRect(x + 12, y - 12, 53, 13); g.fillRect(x + 25, y - 19, 25, 10);
  }
  g.fillStyle = '#49406f';
  for (let i = 0; i < 14; i++) {
    const x = i * 76 - 15, height = 65 + ((i * 43) % 90);
    g.fillRect(x, 370 - height, 56, height + 170);
    g.fillStyle = '#69618d'; g.fillRect(x + 9, 379 - height, 8, 5); g.fillRect(x + 35, 397 - height, 8, 5);
    g.fillStyle = '#49406f';
  }
  g.fillStyle = '#3b345d'; g.fillRect(0, 417, 960, 123);
  for (let i = 0; i < 28; i++) {
    g.fillStyle = i % 3 ? '#544a74' : '#65557f';
    g.fillRect(i * 37, 458 + (i * 17) % 45, 25, 90);
  }
  for (let i = 0; i < 24; i++) {
    const x = (i * 137 + 29) % 960, y = (i * 79 + 41) % 270;
    g.fillStyle = i % 3 ? '#e3d4e9aa' : '#fce6a9aa';
    g.fillRect(x, y, 3, 3);
  }
}

function drawHogwarts(g, time) {
  const sky = g.createLinearGradient(0, 0, 0, 540);
  sky.addColorStop(0, '#101a32'); sky.addColorStop(0.68, '#4c526c'); sky.addColorStop(1, '#777080');
  g.fillStyle = sky; g.fillRect(0, 0, 960, 540);

  const moonlight = g.createRadialGradient(148, 102, 24, 148, 102, 145);
  moonlight.addColorStop(0, '#d4d0c479'); moonlight.addColorStop(1, '#d4d0c400');
  g.fillStyle = moonlight; g.fillRect(0, 0, 310, 260);
  g.fillStyle = '#e8dfc6'; g.beginPath(); g.arc(148, 102, 42, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c5c5bd'; g.fillRect(130, 89, 8, 5); g.fillRect(160, 112, 11, 5);
  for (let i = 0; i < 48; i++) {
    const x = (i * 167 + 29) % 958, y = (i * 73 + 17) % 247;
    g.fillStyle = Math.sin(time * 0.002 + i * 3) > 0.65 ? '#fff0ba' : '#aaaac3';
    g.fillRect(x, y, i % 7 === 0 ? 3 : 2, i % 7 === 0 ? 3 : 2);
  }
  for (let i = 0; i < 5; i++) {
    const x = ((i * 239 + time * (i % 2 ? -0.004 : 0.006)) % 1200 + 1200) % 1200 - 120;
    const y = 99 + i * 41;
    g.fillStyle = i % 2 ? '#9c9bb234' : '#c0bdc13b';
    g.fillRect(x, y, 135, 20); g.fillRect(x + 24, y - 12, 91, 15);
  }

  g.fillStyle = '#30394f';
  g.beginPath(); g.moveTo(0, 358); g.lineTo(106, 277); g.lineTo(227, 355);
  g.lineTo(326, 290); g.lineTo(451, 360); g.lineTo(664, 268);
  g.lineTo(790, 344); g.lineTo(911, 272); g.lineTo(960, 318); g.lineTo(960, 540); g.lineTo(0, 540); g.fill();
  g.fillStyle = '#1c2b3c';
  for (let i = 0; i < 68; i++) {
    const x = i * 17 - 10, h = 20 + (i * 37 % 47);
    g.fillRect(x, 389 - h, 13, h + 50);
    g.beginPath(); g.moveTo(x - 5, 389 - h + 3); g.lineTo(x + 6, 389 - h - 20);
    g.lineTo(x + 18, 389 - h + 3); g.fill();
  }

  const stone = (x, y, w, h, color = '#55576a') => {
    g.fillStyle = '#282c42'; g.fillRect(x - 4, y - 4, w + 8, h + 8);
    g.fillStyle = color; g.fillRect(x, y, w, h);
    g.fillStyle = '#6e6e7a'; g.fillRect(x, y, 5, h); g.fillRect(x, y, w, 5);
    g.fillStyle = '#414557';
    for (let row = y + 15, n = 0; row < y + h; row += 18, n++) {
      g.fillRect(x + 6, row, w - 11, 2);
      for (let bx = x + (n % 2 ? 9 : 24); bx < x + w - 6; bx += 33)
        g.fillRect(bx, row - 14, 2, 13);
    }
  };
  const roof = (x, y, w, peak) => {
    g.fillStyle = '#1d233b';
    g.beginPath(); g.moveTo(x - 9, y); g.lineTo(x + w / 2, peak - 8);
    g.lineTo(x + w + 9, y); g.closePath(); g.fill();
    g.fillStyle = '#4d5168';
    g.beginPath(); g.moveTo(x - 2, y - 4); g.lineTo(x + w / 2, peak);
    g.lineTo(x + w + 2, y - 4); g.closePath(); g.fill();
    g.fillStyle = '#8e8190'; g.fillRect(x + w / 2 - 3, peak - 4, 6, 11);
  };
  const window = (x, y, w = 10, h = 22) => {
    g.fillStyle = '#272b42'; g.fillRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle = '#d9ab65'; g.fillRect(x, y + 4, w, h - 4);
    g.fillStyle = '#f1d99a'; g.fillRect(x + 2, y + 7, Math.max(2, w - 5), h - 10);
    g.fillStyle = '#5a4c53'; g.fillRect(x + Math.floor(w / 2), y + 4, 2, h - 4);
  };

  // The castle sits behind the battleground; roofs and lit windows stay visible above the platforms.
  stone(320, 260, 320, 178, '#5b5c6d'); roof(310, 260, 340, 178);
  stone(226, 225, 99, 213); roof(220, 225, 111, 143);
  stone(632, 231, 108, 207); roof(626, 231, 120, 146);
  stone(369, 193, 75, 245, '#5e5d6a'); roof(363, 193, 87, 91);
  stone(560, 204, 74, 234, '#5a5a69'); roof(554, 204, 86, 103);
  stone(465, 139, 70, 299, '#62606e'); roof(458, 139, 84, 42);
  g.fillStyle = '#d8bd85'; g.fillRect(497, 34, 5, 19); g.fillRect(491, 39, 17, 4);
  g.fillStyle = '#3b3b51'; g.fillRect(337, 264, 285, 9);
  for (let x = 350; x < 620; x += 35) { window(x, 289, 15, 32); window(x, 354, 15, 32); }
  for (const [x, y] of [[259, 265], [259, 326], [291, 265], [291, 326],
    [663, 269], [701, 269], [663, 333], [701, 333], [395, 233], [582, 242],
    [487, 166], [487, 223], [487, 281], [487, 340]]) window(x, y, 11, 25);
  g.fillStyle = '#292c42'; g.fillRect(466, 408, 69, 31);
  g.fillStyle = '#bc995e'; g.fillRect(478, 411, 45, 27);
  g.fillStyle = '#392f3c'; g.fillRect(501, 411, 3, 27);
  g.fillStyle = '#a69a93';
  for (let x = 317; x < 650; x += 27) g.fillRect(x, 255, 14, 9);

  g.fillStyle = '#202d43'; g.fillRect(0, 438, 960, 102);
  for (let i = 0; i < 33; i++) {
    const x = (i * 97 + 13) % 960, y = 448 + (i * 43) % 81;
    g.fillStyle = i % 3 ? '#68708658' : '#c7a87a67';
    g.fillRect(x, y, 31 + i % 4 * 7, 2);
  }
  for (let i = 0; i < 14; i++) {
    const x = (i * 163 + 70) % 940, y = 205 + (i * 47) % 183;
    const glow = Math.sin(time * 0.003 + i) > -0.3;
    g.fillStyle = glow ? '#ffe8a2' : '#aa9c8b';
    g.fillRect(x, y + Math.sin(time * 0.0015 + i) * 3, 4, 4);
  }
}

function drawBackdrop(g, world, time) {
  if (world === 'nightcity') { drawNightCity(g, time); return; }
  if (world === 'hogwarts') { drawHogwarts(g, time); return; }
  if (backdropReady) {
    g.drawImage(backdropCanvas, 0, 0);
    return;
  }
  g.fillStyle = '#a8d9f6'; g.fillRect(0, 0, 960, 540);
  g.fillStyle = '#447caa'; g.fillRect(0, 290, 960, 250);
  g.fillStyle = '#496f3b'; g.fillRect(0, 445, 960, 95);
}

function drawStage(g, world) {
  for (const platform of BRAWL.platforms) {
    const { x, y, w, h, main } = platform;
    if (world === 'hogwarts') {
      const depth = h + (main ? 34 : 12);
      g.fillStyle = '#24263b'; g.fillRect(x - 6, y + 6, w + 12, depth + 7);
      g.fillStyle = '#626374'; g.fillRect(x, y, w, depth);
      g.fillStyle = '#9996a0'; g.fillRect(x, y, w, 6);
      g.fillStyle = '#e2c486'; g.fillRect(x + 5, y + 6, w - 10, 3);
      g.fillStyle = '#494d60';
      for (let bx = x + 20; bx < x + w - 12; bx += 42) {
        g.fillRect(bx, y + 16, 23, 2);
        g.fillRect(bx + 11, y + 18, 2, depth - 21);
      }
      if (main) {
        g.fillStyle = '#38394d';
        for (let bx = x + 58; bx < x + w - 40; bx += 105) {
          g.fillRect(bx, y + 24, 46, 27);
          g.fillStyle = '#817c89'; g.fillRect(bx + 5, y + 28, 36, 21);
          g.fillStyle = '#38394d';
        }
        for (const [offset, color] of [[110, '#a85b59'], [230, '#af925b'],
          [350, '#5e819e'], [470, '#5d866b']]) {
          g.fillStyle = color; g.fillRect(x + offset, y + 9, 13, 24);
          g.fillStyle = '#e4cc92'; g.fillRect(x + offset + 3, y + 13, 7, 3);
        }
      } else {
        g.fillStyle = '#e8d59b';
        g.fillRect(x + w / 2 - 2, y + 1, 4, 4);
      }
      continue;
    }
    if (world === 'nightcity') {
      g.fillStyle = '#231c37'; g.fillRect(x - 6, y + 6, w + 12, h + (main ? 27 : 8));
      g.fillStyle = main ? '#76638f' : '#8b70ac'; g.fillRect(x, y, w, h + (main ? 20 : 0));
      g.fillStyle = '#f1c58d'; g.fillRect(x, y, w, 8);
      g.fillStyle = '#fff0be'; g.fillRect(x + 11, y + 2, w - 22, 3);
      g.fillStyle = '#4d3e70';
      for (let bx = x + 23; bx < x + w - 10; bx += 41) g.fillRect(bx, y + h + 5, 20, main ? 19 : 4);
      if (main) {
        g.fillStyle = '#ec7994'; g.fillRect(x + 13, y + 16, 8, 20);
        g.fillRect(x + w - 21, y + 16, 8, 20);
      }
      continue;
    }
    const depth = h + (main ? 22 : 9);
    g.fillStyle = '#233b3b'; g.fillRect(x - 5, y + 5, w + 10, depth + 5);
    g.fillStyle = main ? '#65754c' : '#60768a'; g.fillRect(x, y, w, depth);
    g.fillStyle = '#385747';
    for (let bx = x + 14; bx < x + w - 10; bx += 37) g.fillRect(bx, y + h + 4, 17, main ? 18 : 6);
    g.fillStyle = '#759f56'; g.fillRect(x - 2, y, w + 4, 8);
    g.fillStyle = '#c9d894';
    for (let bx = x + 8; bx < x + w - 10; bx += 53) g.fillRect(bx, y + 1, 24, 3);
    g.fillStyle = '#a7c46f';
    for (let bx = x + 21; bx < x + w - 8; bx += 67) {
      g.fillRect(bx, y - 4, 3, 4);
      g.fillRect(bx + 5, y - 7, 3, 7);
    }
    if (main) {
      g.fillStyle = '#3b5b46'; g.fillRect(x + 14, y + 18, 8, 22);
      g.fillRect(x + w - 22, y + 18, 8, 22);
    }
  }
}

function drawWorldPreviews() {
  for (const card of worldCards) {
    const preview = card.preview.getContext('2d');
    preview.imageSmoothingEnabled = false;
    preview.setTransform(0.25, 0, 0, 0.25, 0, 0);
    drawBackdrop(preview, card.key, 0);
    drawStage(preview, card.key);
  }
}
drawWorldPreviews();

function drawProjectile(p, lag, now, players) {
  // Positions are sampled from buffered server time before they reach here.
  const x = Math.round(p.x + (p.vx ?? 0) * lag);
  const y = Math.round(p.y + (p.vy ?? 0) * lag + (p.gravity ?? 0) * lag * lag / 2);
  const frame = Math.floor(now / 65 + p.id) % 4;
  const direction = Math.sign(p.vx ?? 0) || 1;
  if (p.kind === 'thunder') {
    ctx.save();
    ctx.lineJoin = 'bevel'; ctx.lineCap = 'square';
    for (const [width, color] of [[20, '#dbaf40aa'], [12, '#ffe46c'], [5, '#fffef1']]) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x, -18);
      for (let step = 1, py = 0; py < y; step++, py += 27)
        ctx.lineTo(x + (step % 2 ? 13 : -11) + (frame % 2 ? 5 : -5), Math.min(y, py));
      ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.fillStyle = '#fff8bc'; ctx.fillRect(x - 12, y - 8, 24, 18);
    ctx.restore();
    return;
  }
  if (p.kind === 'fire') {                       // a bouncing fireball: layered, flickering circles and a short tail
    const flick = frame % 2 ? 2 : 0;
    ctx.save();
    ctx.fillStyle = '#ff7a2a66'; ctx.fillRect(x - direction * 26, y - 5, 20, 10);
    ctx.fillStyle = '#ff9a3acc'; ctx.fillRect(x - direction * 15, y - 7, 14, 14);
    for (const [r, color] of [[13 + flick, '#e8501f'], [10, '#ff8a2b'], [6, '#ffd35a'], [3, '#fff7cf']]) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    return;
  }
  if (p.kind === 'sling') {                      // a small, fast pellet with a thin streak behind it
    ctx.save();
    ctx.fillStyle = '#f6edd566'; ctx.fillRect(x - direction * 30, y - 1, 26, 3);
    ctx.fillStyle = '#7a5a3a'; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c99a62'; ctx.beginPath(); ctx.arc(x - 1, y - 1, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  if (p.kind === 'arrow') {
    ctx.save(); ctx.translate(x, y); ctx.scale(direction, 1);
    ctx.fillStyle = '#d5ba85'; ctx.fillRect(-21, -2, 39, 4);
    ctx.fillStyle = '#f5e6b9'; ctx.fillRect(13, -4, 11, 8);
    ctx.fillStyle = '#6e855a'; ctx.fillRect(-23, -7, 9, 5); ctx.fillRect(-23, 2, 9, 5);
    ctx.fillStyle = '#f4ddaa66'; ctx.fillRect(-48, -1, 21, 2);
    ctx.restore();
    return;
  }
  if (['pamphlet', 'knight', 'mud', 'record'].includes(p.kind)) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    if (p.kind === 'pamphlet') {
      ctx.rotate((frame - 1.5) * 0.18);
      ctx.fillStyle = '#203743'; ctx.fillRect(-11, -9, 22, 18);
      ctx.fillStyle = '#bd4d4b'; ctx.fillRect(-9, -7, 18, 14);
      ctx.fillStyle = '#f5dcad'; ctx.fillRect(-6, -4, 12, 2); ctx.fillRect(-6, 1, 9, 2);
    } else if (p.kind === 'record') {
      ctx.fillStyle = '#d8bd78'; ctx.fillRect(-17, -12, 34, 24);
      ctx.fillStyle = '#303a3d'; ctx.fillRect(-14, -10, 28, 20);
      ctx.fillStyle = '#8f9b8d'; ctx.fillRect(-4, -5, 8, 10);
      ctx.fillStyle = '#d8bd78'; ctx.fillRect(-1, -2, 2, 4);
    } else if (p.kind === 'knight') {
      ctx.fillStyle = '#203743'; ctx.fillRect(-11, 6, 22, 5);
      ctx.fillStyle = '#f3e8cf'; ctx.fillRect(-9, 7, 18, 3);
      ctx.fillStyle = '#f3e8cf'; ctx.fillRect(-7, -3, 12, 10);
      ctx.fillRect(-5, -10, 7, 9); ctx.fillRect(0, -8, 7, 4);
      ctx.fillStyle = '#203743'; ctx.fillRect(-2, -7, 2, 2);
    } else {
      ctx.fillStyle = '#385847'; ctx.fillRect(-24, -18, 48, 36);
      ctx.fillStyle = '#638c52'; ctx.fillRect(-25, -14, 50, 28);
      ctx.fillStyle = '#8cb365'; ctx.fillRect(-17, -21, 31, 37);
      ctx.fillStyle = '#b7cb77'; ctx.fillRect(-12, -15, 13, 7); ctx.fillRect(8, 1, 8, 6);
      ctx.fillStyle = '#4b754a'; ctx.fillRect(-17, 7, 9, 5); ctx.fillRect(11, -11, 7, 5);
    }
    ctx.restore();
    return;
  }
  if (p.character === 'isabelle') {
    const owner = players.find(player => player.id === p.owner);
    if (owner) {
      ctx.strokeStyle = '#f8f2db'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(owner.x + owner.face * 21, owner.y - 54);
      ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.fillStyle = '#f6edd5'; ctx.fillRect(x - 5, y - 5, 10, 10);
    ctx.fillStyle = '#df5149'; ctx.fillRect(x - 5, y - 5, 10, 4);
    ctx.fillStyle = '#263e47'; ctx.fillRect(x - 1, y + 5, 2, 5);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(direction, 1);
  if (p.character === 'zelda') {
    ctx.fillStyle = '#ae64e588'; ctx.fillRect(-18 - frame, -8, 18, 16);
    ctx.fillStyle = '#c783ef'; ctx.fillRect(-11, -11, 22, 22);
    ctx.fillStyle = '#f4c4ff'; ctx.fillRect(-7, -7, 14, 14);
    ctx.fillStyle = '#fff1c4'; ctx.fillRect(-3, -3, 6, 6);
    ctx.fillStyle = '#f2d9ff'; ctx.fillRect(-14, frame - 7, 4, 4);
    ctx.fillRect(10, 4 - frame, 4, 4);
  }
  ctx.restore();
}

function drawPuddle(p, now) {
  if (p.kind === 'trap') {
    const fade = Math.min(1, p.life * 2);
    ctx.save(); ctx.globalAlpha = fade * (p.armed ? 1 : 0.55);
    ctx.fillStyle = '#3b302e';
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 3, p.radius, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7a543e';
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 4, p.radius - 5, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d5ba85';
    for (let i = -2; i <= 2; i++) ctx.fillRect(p.x + i * 10 - 2, p.y - 14 + Math.abs(i) * 2, 4, 9);
    if (p.armed) {
      ctx.fillStyle = Math.floor(now / 350) % 2 ? '#e0544a' : '#7d2c2a';
      ctx.fillRect(p.x - 2, p.y - 20, 4, 4);
    }
    ctx.restore();
    return;
  }
  if (p.kind === 'webpad') {
    const fade = Math.min(1, p.life * 2, WEB_PAD.duration - p.life + 0.2);
    ctx.save(); ctx.globalAlpha = fade;
    ctx.fillStyle = '#d9f0ff66';
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 5, p.radius, 13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ecf8ff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 5, p.radius, 13, 0, 0, Math.PI * 2); ctx.stroke();
    for (let i = -2; i <= 2; i++) {
      const offset = i * p.radius / 3;
      ctx.beginPath(); ctx.moveTo(p.x + offset, p.y - 17);
      ctx.lineTo(p.x + offset * 0.7, p.y + 7); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(p.x - p.radius + 6, p.y - 5);
    ctx.lineTo(p.x + p.radius - 6, p.y - 5); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(p.x - 4, p.y - 14 + Math.sin(now / 120) * 2, 8, 4);
    ctx.restore();
    return;
  }
  const fade = Math.min(1, p.life * 2, SLIME.puddleDuration - p.life + 0.2);
  ctx.save(); ctx.globalAlpha = fade;
  ctx.fillStyle = '#294c43';
  ctx.beginPath(); ctx.ellipse(p.x, p.y - 3, p.radius, 17, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#639b5a';
  ctx.beginPath(); ctx.ellipse(p.x, p.y - 5, p.radius - 6, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#a3c773';
  for (let i = 0; i < 5; i++) {
    const bx = p.x + Math.sin(i * 2.2 + p.id) * (p.radius - 23);
    const by = p.y - 8 + Math.sin(now / 320 + i) * 2;
    ctx.fillRect(Math.round(bx), Math.round(by), 11 + i % 2 * 6, 3);
  }
  ctx.restore();
}

function drawSerpent(p, now) {
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(p.face, 1);
  const sway = Math.round(Math.sin(now / 110 + p.id) * 4);
  ctx.fillStyle = '#203743';
  ctx.fillRect(-31, -3 + sway, 22, 8); ctx.fillRect(-15, -8, 32, 11);
  ctx.fillRect(10, -13, 18, 13); ctx.fillRect(-36, -9 + sway, 8, 9);
  ctx.fillStyle = '#5b9c5b';
  ctx.fillRect(-28, -2 + sway, 22, 5); ctx.fillRect(-12, -6, 30, 7);
  ctx.fillStyle = '#80bd70'; ctx.fillRect(12, -11, 14, 9);
  ctx.fillStyle = '#f3e3a0'; ctx.fillRect(21, -8, 3, 3);
  ctx.fillStyle = '#e57f82'; ctx.fillRect(28, -5, 9, 2); ctx.fillRect(34, -8, 2, 3);
  ctx.restore();
}

function drawFerret(x, y, face) {
  ctx.save(); ctx.translate(x, y); ctx.scale(face, 1);
  ctx.fillStyle = '#203743';
  ctx.fillRect(-31, -18, 40, 18); ctx.fillRect(4, -25, 23, 20);
  ctx.fillRect(10, -30, 7, 8); ctx.fillRect(22, -29, 6, 8);
  ctx.fillRect(-45, -15, 18, 6);
  ctx.fillStyle = '#d9c6a8'; ctx.fillRect(-28, -16, 37, 13);
  ctx.fillStyle = '#eee0c4'; ctx.fillRect(7, -23, 18, 16);
  ctx.fillRect(11, -28, 4, 6); ctx.fillRect(23, -27, 3, 6);
  ctx.fillStyle = '#9c805f'; ctx.fillRect(-42, -13, 16, 3);
  ctx.fillRect(-24, -3, 7, 5); ctx.fillRect(0, -3, 7, 5);
  ctx.fillStyle = '#203743'; ctx.fillRect(18, -18, 3, 3); ctx.fillRect(25, -12, 4, 3);
  ctx.restore();
}

const mainContext = ctx;
function drawDance(p, x, y, target) {
  const ctx = target || mainContext;
  const t = BRAWL_EMOTE.duration - p.emoteTime;
  const beat = Math.sin(t * Math.PI * 7);
  const wide = Math.sin(t * Math.PI * 3.5);
  let dx = 0, lift = 0, tilt = 0, face = p.face;
  if (p.character === 'mario') { dx = wide * 4; lift = Math.max(0, beat) * 9; tilt = wide * 0.1; }
  else if (p.character === 'yoshi') { dx = wide * 6; lift = Math.abs(beat) * 4; tilt = wide * 0.16; }
  else if (p.character === 'pikachu') { dx = beat * 8; lift = Math.abs(beat) * 3; tilt = beat * 0.12; }
  else if (p.character === 'isabelle') { dx = wide * 8; lift = Math.max(0, beat) * 5; tilt = wide * 0.19; }
  else if (p.character === 'wario') { dx = wide * 2; lift = Math.max(0, beat) * 3; tilt = beat * 0.22; }
  else if (p.character === 'zelda') {
    dx = Math.sin(t * Math.PI * 2.4) * 5; lift = Math.abs(wide) * 4;
    tilt = wide * 0.12; face = Math.cos(t * Math.PI * 2.4) < 0 ? -p.face : p.face;
  }
  else if (p.character === 'marx') { dx = wide * 3; lift = Math.max(0, beat) * 3; tilt = wide * 0.08; }
  else if (p.character === 'doom') { dx = beat * 3; lift = Math.abs(beat) * 3; tilt = beat * 0.12; }
  else if (p.character === 'ron') { dx = wide * 4; lift = Math.max(0, beat) * 5; tilt = wide * 0.11; }
  else if (p.character === 'shrek') { dx = wide * 2; lift = Math.max(0, beat) * 2; tilt = wide * 0.09; }
  else if (p.character === 'snape') { dx = wide * 2; lift = Math.max(0, beat) * 2; tilt = wide * 0.06; }
  else if (p.character === 'draco') { dx = wide * 4; lift = Math.max(0, beat) * 4; tilt = wide * 0.12; }
  else if (p.character === 'katniss') { dx = wide * 3; lift = Math.max(0, beat) * 4; tilt = wide * 0.09; }
  else if (p.character === 'spiderman') { dx = beat * 8; lift = Math.abs(beat) * 5; tilt = beat * 0.18; }
  ctx.save();
  ctx.translate(x + dx, y - 34 - lift);
  ctx.rotate(tilt);
  drawFighter(ctx, p.character, 0, 34, 2.1, face, null, 0, p.invuln > 0);
  ctx.restore();
  const px = Math.round(x), py = Math.round(y);
  if (p.character === 'mario') {
    // A raised-cap hop, distinct from his attack animation.
    ctx.fillStyle = '#f2cf73'; ctx.fillRect(px + p.face * 21 - 5, py - 81 - lift, 10, 5);
    ctx.fillStyle = '#ee4a4d'; ctx.fillRect(px + p.face * 21 - 9, py - 88 - lift, 18, 7);
    ctx.fillStyle = '#fff2d7'; ctx.fillRect(px + p.face * 21 - 2, py - 86 - lift, 4, 3);
  } else if (p.character === 'yoshi') {
    // Tail wag and bouncing egg.
    ctx.fillStyle = '#70d765'; ctx.fillRect(px - p.face * (28 + wide * 5) - 7, py - 32, 14, 12);
    ctx.fillStyle = '#f6f0cf'; ctx.fillRect(px + p.face * 28 - 7, py - 38 - Math.abs(beat) * 14, 14, 17);
    ctx.fillStyle = '#9bce78'; ctx.fillRect(px + p.face * 28 - 3, py - 34 - Math.abs(beat) * 14, 5, 5);
  } else if (p.character === 'pikachu') {
    // Quick electric side-shuffle.
    ctx.fillStyle = '#fff4a1';
    ctx.fillRect(px - 39, py - 50 + beat * 4, 7, 4);
    ctx.fillRect(px - 34, py - 56 + beat * 4, 4, 8);
    ctx.fillRect(px + 31, py - 67 - beat * 4, 7, 4);
    ctx.fillRect(px + 28, py - 63 - beat * 4, 4, 9);
  } else if (p.character === 'isabelle') {
    // A gentle two-step with floating music notes.
    ctx.fillStyle = '#fff1a9';
    ctx.font = '26px "PixelText", monospace'; ctx.textAlign = 'center';
    ctx.fillText('♪', px - 34, py - 69 - Math.abs(wide) * 9);
    ctx.fillText('♫', px + 36, py - 77 - Math.abs(beat) * 8);
  } else if (p.character === 'wario') {
    // Heavy alternating stomps kick up dust.
    ctx.fillStyle = '#dcc999';
    ctx.fillRect(px - 34, py - 5, 10 + Math.abs(beat) * 7, 5);
    ctx.fillRect(px + 24, py - 5, 10 + Math.abs(beat) * 7, 5);
    ctx.fillStyle = '#f7dc62'; ctx.fillRect(px - 5, py - 84 - lift, 10, 4);
  } else if (p.character === 'zelda') {
    // A slow twirl with two orbiting magical lights.
    for (const offset of [0, Math.PI]) {
      const a = t * Math.PI * 4 + offset;
      ctx.fillStyle = offset ? '#f1d68f' : '#e4a7ff';
      ctx.fillRect(px + Math.cos(a) * 36 - 4, py - 53 + Math.sin(a) * 15, 8, 8);
    }
  } else if (p.character === 'marx') {
    ctx.fillStyle = '#b74646'; ctx.fillRect(px + p.face * 29 - 8, py - 78 - Math.max(0, beat) * 9, 17, 21);
    ctx.fillStyle = '#ecd6a5'; ctx.fillRect(px + p.face * 29 - 5, py - 74 - Math.max(0, beat) * 9, 11, 2);
  } else if (p.character === 'doom') {
    ctx.fillStyle = '#c8caba'; ctx.fillRect(px + p.face * 32 - 5, py - 68 - lift, 10, 12);
    ctx.fillStyle = '#d8bd78'; ctx.fillRect(px + p.face * 32 - 2, py - 56 - lift, 4, 14);
    ctx.fillStyle = '#e8d896'; ctx.fillRect(px - 36, py - 74 - Math.abs(wide) * 6, 5, 5);
  } else if (p.character === 'ron') {
    ctx.fillStyle = '#f1e4ca'; ctx.fillRect(px + p.face * 30 - 7, py - 38 - Math.abs(beat) * 11, 14, 4);
    ctx.fillRect(px + p.face * 30 - 4, py - 49 - Math.abs(beat) * 11, 8, 11);
  } else if (p.character === 'shrek') {
    ctx.fillStyle = '#a6b970'; ctx.fillRect(px - 36, py - 7, 11 + Math.abs(beat) * 5, 5);
    ctx.fillRect(px + 24, py - 7, 11 + Math.abs(beat) * 5, 5);
    ctx.fillStyle = '#9bcc6c'; ctx.fillRect(px + p.face * 31 - 5, py - 65 - lift, 10, 10);
  } else if (p.character === 'snape') {
    ctx.fillStyle = '#baa6d7'; ctx.fillRect(px + p.face * 31 - 5, py - 77 - lift, 10, 10);
    ctx.fillStyle = '#e1d0ee'; ctx.fillRect(px + p.face * 32 - 2, py - 81 - lift, 4, 4);
  } else if (p.character === 'draco') {
    ctx.fillStyle = '#a6d78b'; ctx.fillRect(px + p.face * 34 - 5, py - 67 - lift, 10, 6);
    ctx.fillStyle = '#d9efaf'; ctx.fillRect(px + p.face * 41 - 3, py - 63 - lift, 6, 3);
  } else if (p.character === 'katniss') {
    ctx.fillStyle = '#e7c995'; ctx.fillRect(px + p.face * 39 - 13, py - 77 - lift, 25, 3);
    ctx.fillStyle = '#7b956b'; ctx.fillRect(px + p.face * 43 - 4, py - 82 - lift, 8, 10);
  } else if (p.character === 'spiderman') {
    ctx.strokeStyle = '#ebf8ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px + p.face * 24, py - 62 - lift);
    ctx.lineTo(px + p.face * 50, py - 89 - lift); ctx.stroke();
    ctx.fillStyle = '#f5fcff'; ctx.fillRect(px + p.face * 50 - 5, py - 94 - lift, 10, 7);
  }
}

function drawEmoteLine(p, x, y) {
  const line = BRAWL_EMOTE_LINES[p.character]?.text;
  if (!line || p.emoteTime <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, p.emoteTime * 5);
  ctx.font = '19px "PixelText", monospace';
  ctx.textAlign = 'center';
  const width = Math.ceil(ctx.measureText(line).width) + 18;
  const left = Math.max(5, Math.min(BRAWL.width - width - 5, Math.round(x - width / 2)));
  const top = Math.max(6, Math.round(y - 128));
  ctx.fillStyle = '#173847'; ctx.fillRect(left - 2, top - 2, width + 4, 29);
  ctx.fillStyle = FIGHTERS[p.character].accent; ctx.fillRect(left, top, width, 25);
  ctx.fillStyle = '#173847'; ctx.fillRect(left + 2, top + 2, width - 4, 21);
  ctx.fillStyle = '#fff8e8'; ctx.fillText(line, left + width / 2, top + 17);
  ctx.fillStyle = FIGHTERS[p.character].accent;
  ctx.fillRect(Math.max(left + 7, Math.min(left + width - 15, Math.round(x) - 4)), top + 27, 8, 5);
  ctx.restore();
}

function drawConfundoBadge(p, x, y) {
  const width = 140, left = Math.max(4, Math.min(BRAWL.width - width - 4, Math.round(x - width / 2)));
  const top = Math.max(5, Math.round(y - (p.emoteTime > 0 ? 178 : 140)));
  ctx.save();
  ctx.fillStyle = '#271b3d'; ctx.fillRect(left - 3, top - 3, width + 6, 43);
  ctx.fillStyle = '#d7a8ff'; ctx.fillRect(left, top, width, 37);
  ctx.fillStyle = '#38234c'; ctx.fillRect(left + 2, top + 2, width - 4, 33);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff2ff'; ctx.font = '10px "Pixel", monospace';
  ctx.fillText('CONFUNDO', left + width / 2, top + 16);
  ctx.font = '17px "PixelText", monospace';
  ctx.fillText('←  →  BYTTET', left + width / 2, top + 31);
  ctx.fillStyle = '#d7a8ff';
  ctx.fillRect(left + 3, top + 39, Math.round((width - 6) * Math.min(1, p.confuseTime / CONFUNDO.duration)), 3);
  ctx.restore();
}

function drawPlayer(p, lag) {
  if (p.stocks <= 0 || p.respawn > 0) return;
  const x = p.x + p.vx * lag;
  const y = p.grounded || p.leviosaTime > 0 ? p.y : p.y + p.vy * lag + 775 * lag * lag;
  if (x < -30 || x > 990 || y < -60 || y > 590) return;
  const character = FIGHTERS[p.character];
  const teamColor = state?.mode === 'teams' ? BRAWL_TEAMS[p.team] : null;
  ctx.fillStyle = teamColor || '#183e48'; ctx.fillRect(x - 20, y - 1, 40, 5);
  if (p.slowTime > 0) {
    ctx.fillStyle = '#7eb05caa'; ctx.fillRect(x - 26, y - 6, 52, 6);
    ctx.fillStyle = '#b0ca77'; ctx.fillRect(x - 16, y - 10, 9, 5); ctx.fillRect(x + 10, y - 9, 7, 4);
  }
  if (p.leviosaTime > 0) {
    ctx.strokeStyle = '#d8e7ff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y - 38, 32, 47, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff3bc'; ctx.fillRect(x - 35, y - 68, 6, 6); ctx.fillRect(x + 30, y - 26, 5, 5);
  }
  if (p.confuseTime > 0) {
    ctx.save();
    ctx.strokeStyle = '#d7a8ff'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(x, y - 38, 30, 45, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#efd3ff'; ctx.font = '22px "PixelText", monospace';
    ctx.textAlign = 'center'; ctx.fillText('?', x - 24, y - 80); ctx.fillText('?', x + 25, y - 64);
    ctx.restore();
  }
  if (p.swing) {
    ctx.save();
    ctx.strokeStyle = '#f2faff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y - 50); ctx.lineTo(p.swing.ax, p.swing.ay); ctx.stroke();
    ctx.strokeStyle = '#ffffff88'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 2, y - 50); ctx.lineTo(p.swing.ax + 2, p.swing.ay); ctx.stroke();
    ctx.fillStyle = '#ecf8ff';
    ctx.beginPath(); ctx.arc(p.swing.ax, p.swing.ay, 6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  if (p.wardTime > 0) {
    ctx.strokeStyle = '#b6e5ff'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(x, y - 37, 34, 47, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e5f7ff'; ctx.fillRect(x - 6, y - 80, 12, 4);
  }
  if (p.stun > 0.08) {
    ctx.fillStyle = character.color + '77';
    ctx.fillRect(x - p.vx * 0.035 - 15, y - 60 - p.vy * 0.02, 30, 53);
  }
  if (p.invuln > 0) {
    ctx.strokeStyle = '#f7e5a3a0'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y - 39, 29, 42, 0, 0, Math.PI * 2); ctx.stroke();
  }
  const localShield = p.id === myId && combatFeatures &&
    (keys.has('shift') || keys.has('touchshield')) && p.grounded &&
    p.stun <= 0 && !p.attack && !p.rollTime && !p.ferretTime && p.shield > 0 && p.shieldBreak <= 0;
  if (p.shielding || localShield) {
    ctx.fillStyle = p.shield < 30 ? '#ffdb954d' : '#a8e9ff45';
    ctx.beginPath(); ctx.ellipse(x, y - 37, 39, 49, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = p.shield < 30 ? '#ffdb95' : '#bceeff';
    ctx.lineWidth = 3; ctx.stroke();
  }
  if (p.attack === 'upair') {
    ctx.fillStyle = `${FIGHTERS[p.character].color}88`;
    ctx.fillRect(x - 11, y + 2, 22, 13);
    ctx.fillRect(x - 7, y + 18, 14, 8);
  }
  if (p.eggTime > 0) {
    ctx.fillStyle = '#233f45'; ctx.fillRect(x - 22, y - 55, 44, 47);
    ctx.fillStyle = '#fff2cd'; ctx.fillRect(x - 19, y - 53, 38, 41);
    ctx.fillStyle = '#9fce78';
    for (const [dx, dy] of [[-9, -43], [8, -40], [0, -28], [-13, -20], [12, -22]])
      ctx.fillRect(x + dx - 3, y + dy - 3, 7, 7);
  } else if (p.ferretTime > 0) {
    drawFerret(x, y, p.face);
  } else if (p.rollTime > 0 || p.spinTime > 0) {
    const progress = 1 - p.rollTime / BRAWL_ROLL.duration;
    if (p.rollTime > 0) {
      ctx.fillStyle = '#e8e1b555';
      ctx.fillRect(x - p.rollDir * 28 - 12, y - 15, 30, 9);
    }
    ctx.save();
    ctx.translate(x, y - 37);
    ctx.rotate(p.rollTime > 0 ? p.rollDir * progress * Math.PI * 2
      : p.spinDir * (1 - p.spinTime / CAPE.spin) * Math.PI * 2);
    ctx.translate(-x, 37 - y);
    drawFighter(ctx, p.character, x, y, 2.1, p.face, p.attack, p.attackTime,
      p.invuln > 0 || isBrawlRollInvulnerable(p));
    ctx.restore();
  } else if (p.rush === 'eggroll') {
    // rolling forward inside a plain egg (a generic egg shape, tumbling in the direction of travel)
    const turn = performance.now() / 85 * p.face;
    ctx.save(); ctx.translate(x, y - 30); ctx.rotate(turn);
    ctx.fillStyle = '#233f45'; ctx.beginPath(); ctx.ellipse(0, 0, 29, 35, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff2cd'; ctx.beginPath(); ctx.ellipse(0, 0, 26, 32, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = character.color;
    for (const [dx, dy] of [[-11, -16], [10, -8], [-4, 10], [13, 16], [-15, 6]]) ctx.fillRect(dx - 3, dy - 3, 7, 7);
    ctx.restore();
    ctx.fillStyle = '#e8e1b555'; ctx.fillRect(x - p.face * 52, y - 12, 34, 8);
  } else if (p.rush === 'quick') {
    // a lightning dash: fading copies behind the fighter and a bright streak
    for (let i = 3; i >= 1; i--) {
      ctx.globalAlpha = 0.16 * (4 - i);
      drawFighter(ctx, p.character, x - p.face * i * 30, y, 2.1, p.face, null, 0, false);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff4a1aa'; ctx.fillRect(x - p.face * 110, y - 46, 100, 5);
    ctx.fillStyle = '#ffffffcc'; ctx.fillRect(x - p.face * 90, y - 33, 80, 3);
    drawFighter(ctx, p.character, x, y, 2.1, p.face, null, 0, false);
  } else if (p.rush === 'shoulder') {
    // a heavy shoulder charge: leaning into it, with dust kicked up behind
    ctx.fillStyle = '#dcc999aa';
    for (let i = 0; i < 3; i++) ctx.fillRect(x - p.face * (30 + i * 18) - 6, y - 6 - i * 5, 12 + i * 3, 6 + i * 2);
    ctx.save(); ctx.translate(x, y); ctx.rotate(p.face * 0.24);
    drawFighter(ctx, p.character, 0, 0, 2.1, p.face, 'smash', 0.3, false);
    ctx.restore();
  } else if (p.rush === 'train') {
    ctx.save(); ctx.translate(x, y); ctx.scale(p.face, 1);
    ctx.fillStyle = '#e2d8bd77';
    for (let i = 0; i < 3; i++) ctx.fillRect(-82 - i * 19, -30 - i * 7, 18, 10);
    ctx.fillStyle = '#26363b'; ctx.fillRect(-43, -74, 43, 48);
    ctx.fillStyle = '#b44846'; ctx.fillRect(-40, -70, 36, 42);
    ctx.fillStyle = '#e8d39c'; ctx.fillRect(-35, -63, 26, 20);
    ctx.restore();
    drawFighter(ctx, p.character, x - p.face * 16, y, 2.1, p.face, null, 0, p.invuln > 0);
    ctx.save(); ctx.translate(x, y); ctx.scale(p.face, 1);
    ctx.fillStyle = '#26363b'; ctx.fillRect(-55, -39, 112, 30);
    ctx.fillStyle = '#a83d43'; ctx.fillRect(-50, -35, 102, 21);
    ctx.fillStyle = '#dcba7c'; ctx.fillRect(-36, -32, 65, 5); ctx.fillRect(36, -27, 13, 8);
    ctx.fillStyle = '#26363b'; ctx.fillRect(29, -59, 16, 24);
    ctx.fillStyle = '#d8ba7c'; ctx.fillRect(33, -56, 8, 19);
    for (const wx of [-35, 0, 35]) {
      ctx.fillStyle = '#24363c'; ctx.beginPath(); ctx.arc(wx, -10, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#dfc891'; ctx.beginPath(); ctx.arc(wx, -10, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#e8dfc6'; ctx.fillRect(32, -75, 17, 10); ctx.fillRect(41, -85, 22, 10);
    ctx.restore();
  } else if (p.emoteTime > 0 && p.grounded && !p.attack) drawDance(p, x, y);
  else drawFighter(ctx, p.character, x, y, 2.1, p.face, p.attack, p.attackTime, p.invuln > 0);
  if (p.attack === 'special' && p.character === 'mario' && p.attackTime > 0.08 && p.attackTime < 0.39) {
    const wave = Math.sin((p.attackTime - 0.08) / 0.31 * Math.PI);
    ctx.fillStyle = '#243b46';
    ctx.beginPath(); ctx.moveTo(x + p.face * 10, y - 54);
    ctx.lineTo(x + p.face * (38 + wave * 38), y - 68);
    ctx.lineTo(x + p.face * (41 + wave * 52), y - 29);
    ctx.lineTo(x + p.face * 8, y - 22); ctx.fill();
    ctx.fillStyle = '#f6d55a';
    ctx.beginPath(); ctx.moveTo(x + p.face * 12, y - 51);
    ctx.lineTo(x + p.face * (35 + wave * 38), y - 64);
    ctx.lineTo(x + p.face * (38 + wave * 48), y - 32);
    ctx.lineTo(x + p.face * 11, y - 25); ctx.fill();
  }
  if (p.attack === 'special' && p.character === 'yoshi' && p.attackTime > 0.08 && p.attackTime < 0.46) {
    const stretch = Math.sin((p.attackTime - 0.08) / 0.38 * Math.PI);
    const length = Math.max(0, Math.round(stretch * EGG_LAY.reach));
    ctx.fillStyle = '#e887a4'; ctx.fillRect(x + p.face * 23 - (p.face < 0 ? length : 0), y - 47, length, 9);
    ctx.fillStyle = '#f6a7b7'; ctx.fillRect(x + p.face * 23 - (p.face < 0 ? length : 0), y - 44, length, 3);
    ctx.fillStyle = '#f5bdd0'; ctx.fillRect(x + p.face * (23 + length) - 6, y - 50, 12, 14);
  }
  if (p.attack === 'special' && p.character === 'doom' && p.attackTime < ATTACKS.special.total) {
    ctx.fillStyle = '#2b3c42'; ctx.fillRect(x + p.face * 27 - 7, y - 67, 14, 17);
    ctx.fillStyle = '#c7d1c5'; ctx.fillRect(x + p.face * 27 - 5, y - 65, 10, 11);
    ctx.fillStyle = '#d8bd78'; ctx.fillRect(x + p.face * 27 - 2, y - 50, 4, 16);
  }
  if (p.attack === 'special2' && p.character === 'ron') {
    ctx.strokeStyle = '#e7d7b6'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x + p.face * 17, y - 47); ctx.lineTo(x + p.face * 45, y - 75); ctx.stroke();
    ctx.fillStyle = '#e2efff'; ctx.fillRect(x + p.face * 45 - 5, y - 81, 10, 10);
  }
  if (p.attack && (p.character === 'snape' || p.character === 'draco')) {
    ctx.strokeStyle = p.character === 'snape' ? '#b4a6d7' : '#c4e2a3';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x + p.face * 18, y - 46);
    ctx.lineTo(x + p.face * 46, y - 72); ctx.stroke();
    ctx.fillStyle = p.character === 'snape' ? '#d8c1f2' : '#deefae';
    ctx.fillRect(x + p.face * 46 - 3, y - 76, 6, 6);
  }
  if (p.grabTarget) {
    ctx.strokeStyle = '#ffe0a1'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(x + p.face * 15, y - 43);
    ctx.lineTo(x + p.face * 37, y - 48); ctx.stroke();
    ctx.fillStyle = '#ffe0a1'; ctx.font = '17px "PixelText", monospace'; ctx.textAlign = 'center';
    ctx.fillText('Kast!', x, y - 111);
    ctx.fillStyle = '#25454b'; ctx.fillRect(x - 27, y - 105, 54, 5);
    ctx.fillStyle = '#ffe0a1'; ctx.fillRect(x - 27, y - 105, Math.max(0, Math.min(54, p.grabTimer / 1.2 * 54)), 5);
  }
  if (p.grabbedBy) {
    ctx.strokeStyle = '#ffe0a1b8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y - 39, 24, 35, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (p.attack && p.attack !== 'special') {
    const a = ATTACKS[p.attack];
    if (p.attackTime >= a.startup && p.attackTime <= a.startup + a.active) {
      ctx.strokeStyle = p.attack === 'smash' ? '#fff0ab' : p.attack === 'grab' ? '#ffd2aa' : '#e5e9ff';
      ctx.lineWidth = p.attack === 'smash' ? 12 : p.attack === 'upair' ? 9 : 7;
      ctx.beginPath();
      if (p.attack === 'upair') ctx.arc(x, y - 78, 36, Math.PI * 1.08, Math.PI * 1.92);
      else if (p.attack === 'grab') ctx.arc(x + p.face * 31, y - 42, 23,
        p.face > 0 ? -0.8 : Math.PI - 0.8, p.face > 0 ? 1.0 : Math.PI + 1.0);
      else ctx.arc(x + p.face * 43, y - 41, p.attack === 'smash' ? 38 : 29,
        p.face > 0 ? -0.9 : Math.PI - 0.9, p.face > 0 ? 1.2 : Math.PI + 1.2);
      ctx.stroke();
    }
  }
  const label = p.id === myId ? 'Du' : p.name;
  ctx.font = '19px "PixelText", monospace'; ctx.textAlign = 'center';
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = '#153748e8'; ctx.fillRect(x - textWidth / 2 - 9, y - 90, textWidth + 18, 20);
  if (teamColor) { ctx.fillStyle = teamColor; ctx.fillRect(x - textWidth / 2 - 9, y - 90, 4, 20); }
  ctx.fillStyle = p.id === myId ? '#ffe184' : teamColor || character.color;
  ctx.fillText(label, x, y - 76);
  if (p.emoteTime > 0) drawEmoteLine(p, x, y);
  if (p.confuseTime > 0) drawConfundoBadge(p, x, y);
}

// ---------------------------------------------------------------------------------------------------------------------
// Attract mode: the title screen's background. Four fighters (a different four each visit) wander the Dolomites stage,
// chase each other, trade blows, get knocked off, come back, and now and then stop to emote. It is only drawn here in
// the browser; nothing is sent to the server and it uses the same drawing code as a real match.
const DEMO_GRAVITY = 1550;
let demoBots = [];

function makeDemo() {
  const picks = Object.keys(FIGHTERS).sort(() => Math.random() - 0.5).slice(0, 4);
  demoBots = picks.map((character, i) => Object.assign(makeFighter(`demo${i}`, FIGHTERS[character].label, character, i), {
    think: Math.random() * 0.5, mode: 'hunt', wander: 1, emoteCooldown: 2 + Math.random() * 5, invuln: 0,
  }));
}

function demoFoe(bot) {
  let best = null, bestDistance = Infinity;
  for (const other of demoBots) {
    if (other === bot || other.respawn > 0) continue;
    const distance = Math.abs(other.x - bot.x) + Math.abs(other.y - bot.y) * 1.5;
    if (distance < bestDistance) { best = other; bestDistance = distance; }
  }
  return best;
}

function demoJump(bot) {
  bot.vy = -FIGHTERS[bot.character].jump; bot.grounded = false; bot.jumps++;
}

function demoKnockOut(bot) {
  bot.percent = 0; bot.stocks = bot.stocks > 1 ? bot.stocks - 1 : 3;
  bot.respawn = 1.3; bot.attack = null; bot.stun = 0; bot.emoteTime = 0;
  burst(Math.max(20, Math.min(940, bot.x)), Math.max(20, Math.min(520, bot.y)), FIGHTERS[bot.character].color, 18, 260);
}

function demoStrike(bot) {
  const a = ATTACKS[bot.attack];
  const reach = bot.attack === 'special' ? 100 : a.reach + 12;
  const window = bot.attack === 'special' ? [a.startup, a.startup + 0.3] : [a.startup, a.startup + a.active];
  if (bot.attackHit || bot.attackTime < window[0] || bot.attackTime > window[1]) return;
  for (const foe of demoBots) {
    if (foe === bot || foe.respawn > 0 || foe.invuln > 0) continue;
    const ahead = (foe.x - bot.x) * bot.face;
    if (ahead < -8 || ahead > reach + 14 || Math.abs(foe.y - bot.y) > 52) continue;
    bot.attackHit = true;
    foe.percent += a.damage;
    foe.stun = 0.28 + Math.min(0.5, foe.percent / 300);
    const speed = knockback(a, foe.percent, FIGHTERS[foe.character].weight);
    const radians = a.angle * Math.PI / 180;
    foe.vx = bot.face * Math.min(620, Math.cos(radians) * speed * 0.78);
    foe.vy = -Math.min(1350, Math.sin(radians) * speed);
    foe.grounded = false; foe.attack = null; foe.emoteTime = 0;
    burst(foe.x, foe.y - 38, '#fff0ab', 9, 200);
    shake = Math.max(shake, bot.attack === 'smash' ? 9 : 4);
    break;
  }
}

function demoStep(dt) {
  if (!demoBots.length) makeDemo();
  for (const bot of demoBots) {
    bot.invuln = Math.max(0, bot.invuln - dt);
    bot.stun = Math.max(0, bot.stun - dt);
    bot.emoteTime = Math.max(0, bot.emoteTime - dt);
    bot.emoteCooldown -= dt;
    if (bot.respawn > 0) {
      bot.respawn -= dt;
      if (bot.respawn <= 0) {                              // drop back in from above, briefly untouchable
        Object.assign(bot, { x: 400 + Math.random() * 160, y: 60, vx: 0, vy: 0, grounded: false, jumps: 1, invuln: 2 });
      }
      continue;
    }
    if (bot.attack) {
      bot.attackTime += dt;
      demoStrike(bot);
      if (bot.attackTime >= ATTACKS[bot.attack].total) { bot.attack = null; bot.attackTime = 0; bot.attackHit = false; }
    }

    let move = 0;
    const free = bot.stun <= 0 && !bot.attack && bot.emoteTime <= 0;
    const foe = demoFoe(bot);
    if (free && foe) {
      bot.think -= dt;
      if (bot.think <= 0) {
        bot.think = 0.3 + Math.random() * 0.6;
        const roll = Math.random();
        bot.mode = roll < 0.72 ? 'hunt' : roll < 0.88 ? 'wander' : 'idle';
        bot.wander = Math.random() < 0.5 ? -1 : 1;
      }
      const dx = foe.x - bot.x, direction = Math.sign(dx) || 1, closeness = Math.abs(dx);
      if (bot.grounded && bot.emoteCooldown <= 0 && Math.random() < dt * 0.4) {
        bot.emoteTime = BRAWL_EMOTE.duration; bot.emoteCooldown = 7 + Math.random() * 7; bot.vx = 0;
      } else if (bot.mode === 'hunt') {
        bot.face = direction;
        if (closeness > 62) move = direction;
        if (closeness < 84 && Math.abs(foe.y - bot.y) < 50 && Math.random() < dt * 3.2) {
          const roll = Math.random();
          bot.attack = roll < 0.28 ? 'smash' : roll < 0.45 && (bot.character === 'mario' || bot.character === 'yoshi') ? 'special' : 'jab';
          bot.attackTime = 0; bot.attackHit = false; bot.vx = 0;
        }
        if (foe.y < bot.y - 60 && bot.grounded && Math.random() < dt * 1.4) demoJump(bot);
      } else if (bot.mode === 'wander') {
        move = bot.wander; bot.face = move;
        if (bot.grounded && Math.random() < dt * 0.5) demoJump(bot);
      }
      if (!bot.grounded && bot.jumps < 2 && bot.vy > 0 && foe.y < bot.y - 30 && Math.random() < dt * 1.5) demoJump(bot);
      // stay on the stage: turn back near the edges, and use the second jump to climb back
      if (bot.x < 150) move = 1; else if (bot.x > 810) move = -1;
      if (!bot.grounded && bot.y > 430 && bot.jumps < 2 && bot.vy > 0) demoJump(bot);
      if (!bot.grounded && bot.y > 380 && (bot.x < 170 || bot.x > 790)) move = bot.x < 480 ? 1 : -1;
    }

    const wanted = move * FIGHTERS[bot.character].speed * 0.85;
    if (bot.stun > 0) bot.vx *= Math.pow(0.55, dt * 6);
    else bot.vx += (wanted - bot.vx) * Math.min(1, dt * (bot.grounded ? 12 : 3.5));
    bot.vy = Math.min(900, bot.vy + DEMO_GRAVITY * dt);
    bot.x += bot.vx * dt;
    const before = bot.y;
    bot.y += bot.vy * dt;
    bot.grounded = false;
    if (bot.vy >= 0) {
      for (const platform of BRAWL.platforms) {
        if (before <= platform.y + 3 && bot.y >= platform.y && bot.x > platform.x - 6 && bot.x < platform.x + platform.w + 6) {
          bot.y = platform.y; bot.vy = 0; bot.grounded = true; bot.jumps = 0; break;
        }
      }
    }
    if (bot.y > 640 || bot.y < -150 || bot.x < -110 || bot.x > 1070) demoKnockOut(bot);
  }
}

function leaveSplash() {
  if (!splash) return;
  splash = false;
  splashScreen.hidden = true;
  demoBots = []; particles = []; shake = 0;
  showRooms('');
}

// ---------------------------------------------------------------------------------------------------------------------
// The room list: every room that exists, who is in it, and whether it can be joined. No codes. "Hurtigspill" puts you
// in the open room with the most people waiting (or a new one), "Nytt rom" always starts a new one.
let roomsTimer = 0;
async function refreshRooms() {
  try {
    const response = await fetch('/api/brawl-rooms', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    renderRooms((await response.json()).rooms || []);
  } catch {
    roomList.replaceChildren(Object.assign(document.createElement('div'), { className: 'roomEmpty', textContent: 'Fikk ikke kontakt med serveren. Prøver igjen …' }));
  }
}

function renderRooms(rooms) {
  if (!rooms.length) {
    roomList.replaceChildren(Object.assign(document.createElement('div'), { className: 'roomEmpty', textContent: 'Ingen rom ennå. Trykk «Hurtigspill» eller «Nytt rom».' }));
    return;
  }
  roomList.replaceChildren(...rooms.map(room => {
    const row = document.createElement('div'); row.className = `roomRow${room.open ? '' : ' closed'}`; row.setAttribute('role', 'listitem');
    const name = document.createElement('span'); name.className = 'roomName'; name.textContent = `Rom ${room.id}`;
    const who = document.createElement('span'); who.className = 'roomWho'; who.textContent = (room.names || []).join(', ') || '—';
    const count = document.createElement('span'); count.className = 'roomCount'; count.textContent = `${room.players}/4`;
    const stateLabel = document.createElement('span'); stateLabel.className = 'roomState';
    stateLabel.textContent = room.phase === 'lobby' ? 'Venter' : room.phase === 'results' ? 'Resultater' : 'I kamp';
    const join = document.createElement('button'); join.type = 'button'; join.className = 'roomJoin';
    join.textContent = room.open ? 'Bli med' : room.players >= 4 ? 'Fullt' : 'I kamp';
    join.disabled = !room.open;
    join.addEventListener('click', () => chooseRoom(String(room.id)));
    row.append(name, who, count, stateLabel, join);
    return row;
  }));
}

function showRooms(message) {
  browsing = true;
  document.body.classList.add('splash');             // keeps the in-game HUD hidden while choosing
  lobby.hidden = true;
  roomsScreen.hidden = false;
  roomsHint.textContent = message || '';
  refreshRooms();
  clearInterval(roomsTimer);
  roomsTimer = setInterval(refreshRooms, 2000);
}

function chooseRoom(choice) {
  clearInterval(roomsTimer);
  browsing = false;
  wantRoom = choice;
  roomsScreen.hidden = true;
  document.body.classList.remove('splash');
  status.textContent = 'Kobler til …';
  connect();
}
quickPlayButton.addEventListener('click', () => chooseRoom('auto'));
newRoomButton.addEventListener('click', () => chooseRoom('new'));

// Back from a room to the room list.
leaveRoomButton.addEventListener('click', () => {
  leaving = true;
  socket?.close();
  state = null; myId = null; lastUiSignature = '';
  updatePodium([], false);
  showRooms('');
});
playButton.addEventListener('click', leaveSplash);
function showMuteState() {
  muteButton.textContent = music.muted ? '♪ Av' : '♪ På';
  muteButton.setAttribute('aria-pressed', String(!music.muted));
  muteButton.title = music.muted ? 'Slå på musikken' : 'Slå av musikken';
  volumeSlider.value = String(Math.round(music.volume * 100));
  volumeSlider.setAttribute('aria-valuetext', `${volumeSlider.value} prosent`);
}
muteButton.addEventListener('click', () => { music.setMuted(!music.muted); showMuteState(); });
volumeSlider.addEventListener('input', () => {
  const value = Number(volumeSlider.value) / 100;
  music.setVolume(value);
  if (music.muted && value > 0) music.setMuted(false);       // moving the slider up turns the music back on
  showMuteState();
});
showMuteState();
document.body.classList.add('splash');

// ---------------------------------------------------------------------------------------------------------------------
// The lobby podium: every fighter in the room stands on top of the lobby box with their name above them and a
// ready / not-ready icon. They walk back and forth along the box, hop around (no fighting up here), and every few
// seconds stop and do their dance (the same one as the in-game emote), or right away when they press ready.
const podiumFigures = new Map();       // player id -> the figure on the podium
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let podiumLast = performance.now();

function updatePodium(players, teamMode) {
  const seen = new Set();
  const width = podium.clientWidth || 600;
  players.forEach((p, index) => {
    seen.add(p.id);
    let f = podiumFigures.get(p.id);
    if (!f) {
      const el = document.createElement('div'); el.className = 'podFigure';          // stays on the box
      const shadow = document.createElement('div'); shadow.className = 'podShadow';  // stays on the box when the fighter jumps
      const body = document.createElement('div'); body.className = 'podBody';        // goes up and down with the hops
      const label = document.createElement('div'); label.className = 'podName';
      const stateIcon = document.createElement('span'); stateIcon.className = 'podState';
      const text = document.createElement('span'); text.className = 'podText';
      label.append(stateIcon, text);
      const figure = document.createElement('canvas'); figure.width = 160; figure.height = 120;
      body.append(label, figure);
      el.append(shadow, body);
      const now = performance.now();
      const x = width * (index + 1) / (players.length + 1);
      f = { el, body, shadow, stateIcon, text, g: figure.getContext('2d'), ready: false, character: p.character,
        x, y: 0, vx: 0, vy: 0, face: x < width / 2 ? 1 : -1, mode: 'stand', until: now + 300 + Math.random() * 1500, target: x,
        danceFrom: -1e9, nextDance: now + 800 + Math.random() * 3500 };
      f.g.imageSmoothingEnabled = false;
      podium.append(el);
      podiumFigures.set(p.id, f);
    }
    f.text.textContent = p.name;
    f.character = p.character;
    if (p.ready && !f.ready) f.danceFrom = performance.now();   // a little cheer when someone readies up
    f.ready = p.ready;
    f.stateIcon.classList.toggle('on', p.ready);
    f.stateIcon.textContent = p.ready ? '✓' : '…';
    f.stateIcon.title = p.ready ? 'Klar' : 'Ikke klar';
    f.el.classList.toggle('mine', p.id === myId);
    f.el.style.setProperty('--team', teamMode && BRAWL_TEAMS[p.team] ? BRAWL_TEAMS[p.team] : '');
  });
  for (const [id, f] of podiumFigures) if (!seen.has(id)) { f.el.remove(); podiumFigures.delete(id); }
}

// One step of a figure's life on the box: gravity for hops, and every so often a new little plan (walk, hop or stand).
function podiumMove(f, dt, now, width, dancing) {
  const min = 34, max = Math.max(min, width - 34);
  if (f.y > 0 || f.vy > 0) {                          // y is the height above the box
    f.vy -= 1500 * dt; f.y += f.vy * dt;
    if (f.y <= 0) { f.y = 0; f.vy = 0; }
  }
  const airborne = f.y > 0;
  if (!airborne && !dancing && now >= f.until) {
    const roll = Math.random();
    if (roll < 0.4) {
      f.mode = 'walk'; f.target = min + Math.random() * (max - min); f.until = now + 1200 + Math.random() * 1800;
    } else if (roll < 0.75) {
      f.mode = 'hop'; f.vy = 320 + Math.random() * 110; f.until = now + 500;
      f.target = Math.max(min, Math.min(max, f.x + (Math.random() - 0.5) * 240));
    } else {
      f.mode = 'stand'; f.until = now + 700 + Math.random() * 1600;
    }
  }
  let want = 0;
  if (!dancing && (f.mode === 'walk' || (f.mode === 'hop' && airborne))) {
    const gap = f.target - f.x;
    if (Math.abs(gap) > 4) want = Math.sign(gap) * (f.mode === 'walk' ? 85 : 110);
    else if (f.mode === 'walk') f.until = 0;
  }
  f.vx += (want - f.vx) * Math.min(1, dt * 10);
  f.x = Math.max(min, Math.min(max, f.x + f.vx * dt));
  if (Math.abs(f.vx) > 8) f.face = Math.sign(f.vx);
}

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - podiumLast) / 1000); podiumLast = now;
  if (lobby.hidden || document.hidden) return;
  const width = podium.clientWidth;
  for (const f of podiumFigures.values()) {
    if (now >= f.nextDance && f.y === 0) { f.danceFrom = now; f.nextDance = now + 4500 + Math.random() * 2500; f.mode = 'stand'; f.until = now + 1900; }
    const since = (now - f.danceFrom) / 1000;
    const dancing = since < BRAWL_EMOTE.duration;
    if (!reducedMotion.matches) podiumMove(f, dt, now, width, dancing);
    f.el.style.transform = `translateX(${Math.round(f.x)}px) translateX(-50%)`;
    f.body.style.transform = `translateY(${-Math.round(f.y)}px)`;
    f.shadow.style.transform = `scaleX(${Math.max(0.45, 1 - f.y / 140).toFixed(2)})`;       // smaller the higher the hop
    const g = f.g;
    g.clearRect(0, 0, 160, 120);
    if (dancing) {
      drawDance({ character: f.character, face: f.face, invuln: 0, emoteTime: BRAWL_EMOTE.duration - since }, 80, 116, g);
    } else {
      const walking = f.mode === 'walk' && Math.abs(f.vx) > 20 && f.y === 0;
      const bob = walking ? -Math.round(Math.abs(Math.sin(now / 95)) * 3) : Math.round(Math.sin(now / 520 + f.nextDance) * 1.2);
      drawFighter(g, f.character, 80, 116 + bob, 2.1, f.face, null, 0, false);
    }
  }
}, 33);

// ---------------------------------------------------------------------------------------------------------------------
// The how-to pop-up ("Slik spiller du"), opened with a button in the lobby. In the middle a little original mascot
// (drawn here from rectangles, not one of the fighters) acts out the moves one after the other while the matching
// key in the lists lights up.
const MASCOT_POSES = [
  ['walk', 'Gå'], ['jump', 'Hopp'], ['jab', 'Rask slag'], ['smash', 'Smash'],
  ['special', 'Spesial'], ['special2', 'Spesial 2'], ['dance', 'Dans'],
];
const POSE_SECONDS = 1.35;
const mascotContext = mascot.getContext('2d');
mascotContext.imageSmoothingEnabled = false;

function drawMascot(pose, t) {
  const g = mascotContext, u = 6, cx = 88, gy = 172;
  g.clearRect(0, 0, mascot.width, mascot.height);
  const R = (x, y, w, h, color) => { g.fillStyle = color; g.fillRect(Math.round(cx + x * u), Math.round(gy + y * u), Math.round(w * u), Math.round(h * u)); };
  const skin = '#f2c9a0', glove = '#d93a3a', band = '#e8504a', tunic = '#3fa9a0', pants = '#3a4b8c', boot = '#5a3a22';
  const stepOn = Math.sin(t * 13) > 0;
  const hop = pose === 'jump' ? -Math.abs(Math.sin(Math.min(1, t / 1.0) * Math.PI)) * 8
    : pose === 'dance' ? -Math.abs(Math.sin(t * 8)) * 1.6 : pose === 'walk' ? -(stepOn ? 0.5 : 0) : Math.sin(t * 4) * 0.25;
  const lean = pose === 'special2' ? 1.5 : 0;
  const body = (offset, alpha) => {
    g.globalAlpha = alpha;
    const o = offset + lean, y = hop;
    const tuck = pose === 'jump' ? -1.5 : 0;                                   // legs pulled up in the air
    R(-4 + o, -2 + y + tuck - (pose === 'walk' && stepOn ? 1 : 0), 3, 2, boot); R(1 + o, -2 + y + tuck - (pose === 'walk' && !stepOn ? 1 : 0), 3, 2, boot);
    R(-4 + o, -6 + y + tuck * 0.5, 3, 4, pants); R(1 + o, -6 + y + tuck * 0.5, 3, 4, pants);
    R(-4.5 + o, -14 + y, 9, 8, tunic); R(-4.5 + o, -9.5 + y, 9, 1, '#6b4a2b'); R(-2 + o, -13 + y, 2, 2, '#6fd3c8');
    R(-5 + o, -23 + y, 10, 9, skin); R(-5 + o, -24 + y, 10, 2, '#5a3a22');
    R(-5 + o, -20 + y, 10, 2, band); R(-8 + o, -20 + y + (Math.sin(t * 6) > 0 ? 0 : 1), 3, 2, band);
    R(0.5 + o, -17.5 + y, 1.4, 2, '#2b2238'); R(3.2 + o, -17.5 + y, 1.4, 2, '#2b2238'); R(2 + o, -14.8 + y, 2.4, 0.7, '#b5524a');
    R(-6.5 + o, pose === 'dance' ? -19 + y : -13 + y, 2, pose === 'dance' ? 6 : 6, skin);       // back arm
    g.globalAlpha = 1;
  };
  if (pose === 'special2') { body(-9, 0.12); body(-6, 0.2); body(-3, 0.3); }                      // a dash: fading copies behind
  const y = hop, o = lean;
  if (pose === 'jab') {
    const reach = t % POSE_SECONDS < 0.5 ? 0 : 1;
    R(4.5 + o, -12.5 + y, 5 + reach * 3, 2, skin); R(9.5 + reach * 3 + o, -13.8 + y, 3.6, 4.4, glove);
    if (reach) { R(14.2 + o, -13 + y, 3, 0.8, '#ffe184'); R(15.3 + o, -14.2 + y, 0.8, 3, '#ffe184'); }
  } else if (pose === 'smash') {
    const phase = (t % POSE_SECONDS) / POSE_SECONDS;
    if (phase < 0.45) { R(-1 + o, -18 + y, 2, 5, skin); R(-2 + o, -21.5 + y, 4.5, 4.5, glove); }          // winding up overhead
    else { R(4.5 + o, -13.5 + y, 8, 3, skin); R(12.5 + o, -16 + y, 6, 6.4, glove);
      for (const [dx, dy] of [[19.5, -17], [20, -12.5], [18.5, -9.5]]) R(dx + o, dy + y, 3, 0.9, '#ffe184'); }
  } else if (pose === 'special') {
    R(4.5 + o, -13 + y, 5, 2.4, skin);
    const pulse = 3.2 + Math.sin(t * 14) * 0.5;
    g.fillStyle = '#6fd3c8'; g.beginPath(); g.arc(cx + 12.5 * u, gy + (-12 + y) * u, pulse * u, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8fffb'; g.beginPath(); g.arc(cx + 12.5 * u, gy + (-12 + y) * u, pulse * 0.45 * u, 0, Math.PI * 2); g.fill();
  } else if (pose === 'dance') {
    R(4.5 + o, -19 + y, 2, 6, skin); R(4.2 + o, -21.5 + y, 2.6, 2.6, glove);
    g.fillStyle = '#fff1a9'; g.font = '700 22px "PixelText", monospace'; g.textAlign = 'center';
    g.fillText('♪', cx + 14 * u, gy + (-19 - Math.abs(Math.sin(t * 5)) * 3) * u * 0.9);
  } else {
    R(4.5 + o, -13 + y, 2, 6, skin); R(4.5 + o, -8 + y, 2.6, 2.2, glove);
  }
  body(0, 1);                                                                                   // the fighter itself (front arm above is behind it, which reads fine at this size)
  g.fillStyle = '#10303a88';                                                                    // shadow, shrinking while in the air
  const wide = 9 - Math.min(3, -hop * 0.4);
  g.fillRect(Math.round(cx - wide * u / 2), gy + 2, Math.round(wide * u), 5);
}

let howtoTimer = 0, howtoStart = 0;
function tickHowto() {
  const t = (performance.now() - howtoStart) / 1000;
  const [pose, label] = MASCOT_POSES[Math.floor(t / POSE_SECONDS) % MASCOT_POSES.length];
  drawMascot(pose, t % POSE_SECONDS);
  if (mascotCaption.textContent !== label) mascotCaption.textContent = label;
  for (const item of howto.querySelectorAll('li[data-pose]')) item.classList.toggle('on', item.dataset.pose === pose);
}
function openHowto() {
  howto.hidden = false;
  howtoStart = performance.now();
  clearInterval(howtoTimer); howtoTimer = setInterval(tickHowto, 60); tickHowto();
  howtoClose.focus({ preventScroll: true });
}
function closeHowto() {
  howto.hidden = true;
  clearInterval(howtoTimer);
  howtoButton.focus({ preventScroll: true });
}
howtoButton.addEventListener('click', openHowto);
howtoClose.addEventListener('click', closeHowto);
howto.addEventListener('mousedown', event => { if (event.target === howto) closeHowto(); });

let lastFrame = performance.now();
function render(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
  simAccumulator = Math.min(simAccumulator + dt, BRAWL.tick * 3);
  while (simAccumulator >= BRAWL.tick) {
    tickLocal(now - simAccumulator * 1000);
    simAccumulator -= BRAWL.tick;
  }
  const matchWorld = Object.hasOwn(BRAWL_WORLDS, state?.world) ? state.world : 'dolomittene';
  const shownWorld = splash ? 'dolomittene' : state?.phase === 'playing' || state?.phase === 'countdown' ? matchWorld : selectedWorld;
  drawBackdrop(worldContext, shownWorld, now);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  if (shake > 0.2) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.82; }
  else shake = 0;
  drawStage(ctx, shownWorld);
  if (splash) {
    demoStep(dt);
    for (const bot of demoBots) drawPlayer(bot, 0);
  } else if (state) {
    const buffered = timeline.sample(now) || state;
    const local = state.phase === 'playing' ? predictor.visual(dt) : null;
    for (const p of buffered.puddles || []) drawPuddle(p, now);
    for (const p of buffered.serpents || []) drawSerpent(p, now);
    for (const p of buffered.projectiles) drawProjectile(p, 0, now, buffered.players);
    for (const p of buffered.players) {
      if (!p.hookedBy || p.hookTime <= 0) continue;
      const owner = buffered.players.find(other => other.id === p.hookedBy);
      if (!owner) continue;
      ctx.strokeStyle = '#f8f2db'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(owner.x + owner.face * 20, owner.y - 51);
      ctx.lineTo(p.x, p.y - 38); ctx.stroke();
    }
    for (const effect of waftEffects) {
      const progress = 1 - effect.life / 0.38;
      ctx.globalAlpha = Math.max(0, effect.life / 0.38);
      ctx.strokeStyle = '#d5ed94'; ctx.lineWidth = 8 - 4 * progress;
      ctx.beginPath(); ctx.ellipse(effect.x, effect.y, effect.radius * progress,
        effect.radius * 0.7 * progress, 0, 0, Math.PI * 2); ctx.stroke();
    }
    for (const effect of dinEffects) {
      const progress = 1 - effect.life / 0.32;
      ctx.globalAlpha = Math.max(0, effect.life / 0.32);
      ctx.fillStyle = '#d681f099';
      ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * progress, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffe1ff'; ctx.lineWidth = 8 - 5 * progress;
      ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * progress, 0, Math.PI * 2); ctx.stroke();
    }
    for (const effect of micEffects) {
      const progress = 1 - effect.life / 0.38;
      ctx.globalAlpha = Math.max(0, effect.life / 0.38);
      ctx.strokeStyle = '#d8bd78'; ctx.lineWidth = 10 - 6 * progress;
      ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * progress, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#e4efdb'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(effect.x, effect.y, effect.radius * progress * 0.75, 0, Math.PI * 2); ctx.stroke();
    }
    for (const effect of spellEffects) {
      ctx.globalAlpha = Math.max(0, effect.life / 0.32);
      ctx.strokeStyle = effect.color || '#b7d8ff'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(effect.x, effect.y); ctx.lineTo(effect.x2, effect.y2); ctx.stroke();
      ctx.strokeStyle = '#fff4d5'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(effect.x, effect.y); ctx.lineTo(effect.x2, effect.y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const p of buffered.players) {
      if (p.spectator) continue;
      drawPlayer(p.id === myId && local ? { ...p, ...local } : p, 0);
    }
  }
  // The countdown dims the whole window (a page overlay, because the game canvas is letterboxed on wide or tall screens).
  const counting = !splash && state?.phase === 'countdown';
  countdownEl.hidden = !counting;
  if (counting) {
    const number = String(Math.max(1, Math.ceil(state.countdown)));
    if (countdownEl.textContent !== number) countdownEl.textContent = number;
  }
  music.set(!splash && (state?.phase === 'countdown' || state?.phase === 'playing') ? 'battle' : 'title');
  music.dim(!splash && (browsing || !lobby.hidden));                  // quieter behind the menu (the lobby form)
  for (const effect of waftEffects) effect.life -= dt;
  waftEffects = waftEffects.filter(effect => effect.life > 0);
  for (const effect of dinEffects) effect.life -= dt;
  dinEffects = dinEffects.filter(effect => effect.life > 0);
  for (const effect of micEffects) effect.life -= dt;
  micEffects = micEffects.filter(effect => effect.life > 0);
  for (const effect of spellEffects) effect.life -= dt;
  spellEffects = spellEffects.filter(effect => effect.life > 0);
  for (const particle of particles) {
    particle.vy += 430 * dt;
    particle.x += particle.vx * dt; particle.y += particle.vy * dt;
    particle.life -= dt;
    ctx.globalAlpha = Math.max(0, particle.life / 0.45);
    ctx.fillStyle = particle.color; ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
  }
  ctx.globalAlpha = 1;
  particles = particles.filter(p => p.life > 0);
  ctx.restore();
  flash.textContent = now < flashUntil ? visibleFlash : '';
  requestAnimationFrame(render);
}
requestAnimationFrame(render);                 // the connection is made when a room is chosen (see chooseRoom)
