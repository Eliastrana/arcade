// Networking, client-side prediction, and snapshot interpolation.
//
// Your own player is PREDICTED so it feels instant, then reconciled against
// the server by replaying inputs it hasn't acknowledged yet.
// Everyone else is rendered ~100ms in the past and interpolated, so their
// motion is smooth despite arriving only 30 times a second.
import { step } from '/shared/game.js';
import { INTERP_DELAY_MS } from '/shared/constants.js';

export class Net {
  constructor() {
    this.id = null;
    this.ready = false;
    this.connected = false;
    this.local = { x:0, z:0, vx:0, vz:0, y:0, vy:0, onGround:true,
                   climbing:false, ladder:-1,
                   rollT:0, rollCd:0, rollX:0, rollZ:0, rollKind:0,
                   rollBuffer:0, rollBufferKind:0, rollBufferYaw:0,
                   pendingFallDamage:0, pendingFallSpeed:0, fallGrace:0 };
    this.pending = [];
    this.seq = 0;
    this.buffer = [];
    this.meta = new Map();       // id -> {name,color,hp,alive,kills,deaths}
    this.fx = [];                // tracers awaiting render
    this.killfeed = [];
    this.falls = [];
    this.dries = [];             // empty-trigger clicks awaiting a sound
    this.onWelcome = () => {};
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    this.ws = new WebSocket(proto + location.host);
    this.ws.onopen  = () => { this.connected = true; };
    this.ws.onclose = () => {
      this.connected = false; this.ready = false;
      setTimeout(() => this.connect(), 1200);
    };
    this.ws.onmessage = (ev) => this._recv(JSON.parse(ev.data));
  }

  _send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  _recv(m) {
    if (m.t === 'welcome') { this.id = m.id; this.maxHp = m.maxHp; this.ready = true; this.onWelcome(m); return; }
    if (m.t !== 's') return;

    for (const p of m.players)
      this.meta.set(p.i, { name:p.n, color:p.c, hp:p.hp, alive:p.al, kills:p.k, deaths:p.d,
                           ads:p.ad, team:p.tm || null, weapon:p.w || 1,
                           character:p.ch || 'soldier', respawnIn:p.rt || 0,
                           ammo:p.am ?? 0, mag:p.mg ?? 0,
                           reloadLeft:p.rd || 0, reloadTotal:p.rdt || 0 });
    for (const id of [...this.meta.keys()])
      if (!m.players.some(p => p.i === id)) this.meta.delete(id);

    if (m.fx && m.fx.length) this.fx.push(...m.fx);
    if (m.kf && m.kf.length) {
      this.killfeed.unshift(...m.kf.map(k => ({ ...k, at: performance.now() })));
      this.killfeed.length = Math.min(this.killfeed.length, 5);
    }
    if (m.fd?.length) this.falls.push(...m.fd);
    if (m.df?.length) this.dries.push(...m.df);

    this.buffer.push({ at: performance.now(), players: m.players });
    while (this.buffer.length > 40) this.buffer.shift();

    this._reconcile(m.players.find(p => p.i === this.id));
  }

  _reconcile(auth) {
    if (!auth) return;
    // While dead the server holds you in place - don't fight it with prediction.
    if (!auth.al) { this.pending.length = 0; }
    this.local.x = auth.x; this.local.z = auth.z;
    this.local.vx = auth.vx; this.local.vz = auth.vz;
    this.local.y = auth.y || 0;
    this.local.vy = auth.vy || 0;
    this.local.onGround = auth.og !== false;
    this.local.climbing = !!auth.cl;
    this.local.ladder = auth.li ?? -1;
    // roll state must come back too, or replaying a buffered roll input would
    // start a second roll the server never granted
    this.local.rollT = auth.rl || 0;
    this.local.rollCd = auth.rc || 0;
    this.local.rollX = auth.rx || 0;
    this.local.rollZ = auth.rz || 0;
    this.local.rollKind = auth.rk || 0;
    this.local.rollBuffer = auth.rb || 0;
    this.local.rollBufferKind = auth.rbk || 0;
    this.local.rollBufferYaw = auth.rby || 0;
    this.local.pendingFallDamage = auth.pd || 0;
    this.local.pendingFallSpeed = auth.ps || 0;
    this.local.fallGrace = auth.fg || 0;
    this.pending = this.pending.filter(p => p.seq > auth.seq);
    for (const p of this.pending) step(this.local, p.input);
  }

  tick(input) {
    if (!this.ready) return;
    const me = this.meta.get(this.id);
    const seq = ++this.seq;
    if (me && me.alive !== false) {
      step(this.local, input);
      this.pending.push({ seq, input });
      if (this.pending.length > 120) this.pending.shift();
    }
    this._send({ t:'i', seq, ...input });
  }

  shoot(aim={})  { this._send({ t:'shoot', yaw:aim.yaw, pitch:aim.pitch, ads:!!aim.ads, weapon:aim.weapon }); }
  setName(name)  { this._send({ t:'name', name }); }
  setCharacter(character) { this._send({ t:'character', character }); }
  joinTeam(team) { if (team === 'red' || team === 'blue') this._send({ t:'team', team }); }
  self()         { return this.meta.get(this.id); }
  takeFx()       { const f = this.fx; this.fx = []; return f; }
  takeFalls()    { const f = this.falls; this.falls = []; return f; }
  takeDries()    { const d = this.dries; this.dries = []; return d; }
  reload()       { this._send({ t:'reload' }); }

  /** Everyone but you, interpolated into the recent past. */
  remotes() {
    const target = performance.now() - INTERP_DELAY_MS;
    let a = null, b = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].at <= target) { a = this.buffer[i]; b = this.buffer[i + 1] || null; break; }
    }
    if (!a) a = this.buffer[0];
    if (!a) return [];
    const t = (b && b.at > a.at) ? (target - a.at) / (b.at - a.at) : 0;

    const out = [];
    for (const pa of a.players) {
      if (pa.i === this.id) continue;
      const pb = b ? b.players.find(p => p.i === pa.i) : null;
      const meta = this.meta.get(pa.i);
      if (!meta) continue;
      out.push({
        id: pa.i,
        x: pb ? pa.x + (pb.x - pa.x) * t : pa.x,
        z: pb ? pa.z + (pb.z - pa.z) * t : pa.z,
        yaw: pa.yaw, pitch: pa.pt || 0,
        y: pb ? (pa.y||0) + ((pb.y||0) - (pa.y||0)) * t : (pa.y||0),
        vy: pb ? (pa.vy||0) + ((pb.vy||0) - (pa.vy||0)) * t : (pa.vy||0),
        onGround: pa.og !== false,
        climbing: !!pa.cl, ladder: pa.li ?? -1,
        rollT: pa.rl || 0, rollKind: pa.rk || 0, sneaking: !!pa.sn,
        reloadLeft: pa.rd || 0, reloadTotal: pa.rdt || 0,
        speed: pa.cl ? 5.0 : Math.hypot(pa.vx, pa.vz), // drives walk/climb animation
        ...meta,
      });
    }
    return out;
  }

  leaderboard() {
    return [...this.meta.entries()].map(([id, m]) => ({ id, ...m })).filter(p => p.team)
      .sort((x, y) => y.kills - x.kills || x.deaths - y.deaths).slice(0, 6);
  }

  teamCounts() {
    const counts={ red:0, blue:0 };
    for (const m of this.meta.values()) if (m.team) counts[m.team]++;
    return counts;
  }
}
