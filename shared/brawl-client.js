import { BRAWL, ATTACKS, jumpBrawlFighter, recoverBrawlFighter, stepBrawlMovement } from './brawl.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mix = (a, b, t) => a + (b - a) * t;

function interpolateActors(first, second, t) {
  const next = new Map(second.map(actor => [actor.id, actor]));
  return first.flatMap(actor => {
    const newer = next.get(actor.id);
    if (!newer) return t < 1 ? [actor] : [];
    const base = t < 0.5 ? actor : newer;
    return [{ ...base,
      x: mix(actor.x, newer.x, t), y: mix(actor.y, newer.y, t),
      vx: mix(actor.vx, newer.vx, t), vy: mix(actor.vy, newer.vy, t),
      attackTime: mix(actor.attackTime || 0, newer.attackTime || 0, t),
      rollTime: mix(actor.rollTime || 0, newer.rollTime || 0, t),
      spinTime: mix(actor.spinTime || 0, newer.spinTime || 0, t),
      eggTime: mix(actor.eggTime || 0, newer.eggTime || 0, t),
      emoteTime: mix(actor.emoteTime || 0, newer.emoteTime || 0, t),
    }];
  }).concat(t >= 1 ? second.filter(actor => !first.some(old => old.id === actor.id)) : []);
}

function extrapolate(actor, seconds, gravity = 1550) {
  return { ...actor,
    x: actor.x + actor.vx * seconds,
    y: actor.grounded ? actor.y : actor.y + actor.vy * seconds + gravity * seconds * seconds / 2,
  };
}

// Render remote actors behind server time, not behind packet arrival time.
// That keeps uneven network spacing from becoming uneven on-screen movement.
export class BrawlTimeline {
  constructor() { this.clear(); }

  clear() {
    this.entries = []; this.offsets = []; this.gaps = [];
    this.phase = null; this.lastArrival = 0; this.delayMs = 90;
  }

  push(snapshot, now) {
    if (this.phase !== snapshot.phase) this.clear();
    this.phase = snapshot.phase;
    if (snapshot.phase !== 'playing') {
      this.entries = [{ time: now, snapshot }];
      return;
    }
    const time = Number.isFinite(snapshot.frame)
      ? snapshot.frame * BRAWL.tick * 1000 : snapshot.elapsed * 1000;
    if (this.entries.length && time <= this.entries.at(-1).time) return;
    if (this.lastArrival) {
      this.gaps.push(now - this.lastArrival);
      if (this.gaps.length > 40) this.gaps.shift();
      const sorted = [...this.gaps].sort((a, b) => a - b);
      const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)] || 17;
      const desired = clamp(80 + Math.max(0, p90 - 25) * 1.35, 80, 180);
      this.delayMs = mix(this.delayMs, desired, desired > this.delayMs ? 0.28 : 0.025);
    }
    this.lastArrival = now;
    this.offsets.push(now - time);
    if (this.offsets.length > 90) this.offsets.shift();
    this.entries.push({ time, snapshot });
    if (this.entries.length > 48) this.entries.shift();
  }

  sample(now) {
    if (!this.entries.length) return null;
    if (this.phase !== 'playing' || this.entries.length === 1) return this.entries.at(-1).snapshot;
    const target = now - Math.min(...this.offsets) - this.delayMs;
    const first = this.entries[0];
    if (target <= first.time) return first.snapshot;
    for (let i = 1; i < this.entries.length; i++) {
      const newer = this.entries[i];
      if (target > newer.time) continue;
      const older = this.entries[i - 1];
      const t = clamp((target - older.time) / (newer.time - older.time), 0, 1);
      return {
        players: interpolateActors(older.snapshot.players, newer.snapshot.players, t),
        projectiles: interpolateActors(older.snapshot.projectiles, newer.snapshot.projectiles, t),
      };
    }
    const latest = this.entries.at(-1).snapshot;
    const seconds = clamp((target - this.entries.at(-1).time) / 1000, 0, 0.05);
    return {
      players: latest.players.map(actor => extrapolate(actor, seconds)),
      projectiles: latest.projectiles.map(actor => extrapolate(actor, seconds, actor.gravity || 0)),
    };
  }
}

function copyFighter(auth) {
  return { ...auth,
    jumps: auth.jumps ?? (auth.grounded ? 0 : 1),
    coyote: auth.coyote ?? 0,
    drop: auth.drop ?? 0,
    groundIndex: auth.groundIndex ?? -1,
    rollTime: auth.rollTime ?? 0,
    rollCooldown: auth.rollCooldown ?? 0,
    rollDir: auth.rollDir ?? 0,
    rollInput: auth.rollInput ?? 0,
  };
}

// Inputs are replayed from the last server acknowledgement when available.
// Older servers without acknowledgements use a short RTT-sized history window.
export class BrawlPredictor {
  constructor() { this.reset(); }

  reset(auth = null) {
    this.state = auth ? copyFighter(auth) : null;
    this.history = [];
    this.offsetX = 0; this.offsetY = 0;
    this.lastAuth = auth ? { ...auth } : null;
  }

  step(input, now) {
    if (!this.state || this.state.stocks <= 0 || this.state.respawn > 0 || this.state.grabbedBy) return;
    if (!input.shield) this.state.shielding = false;
    if (input.move || input.shield || input.jump || input.upair) this.state.emoteTime = 0;
    if (input.jump) jumpBrawlFighter(this.state, input.down);
    if (input.upair && recoverBrawlFighter(this.state, input.move)) {
      this.state.attack = 'upair'; this.state.attackTime = 0;
    }
    stepBrawlMovement(this.state, input.move, BRAWL.tick, input.shield);
    if (this.state.attack === 'upair') {
      this.state.attackTime += BRAWL.tick;
      if (this.state.attackTime >= ATTACKS.upair.total) this.state.attack = null;
    }
    this.history.push({ ...input, at: now });
    if (this.history.length > 180) this.history.shift();
  }

  reconcile(auth, now, oneWayMs = 35) {
    if (!this.state) { this.reset(auth); return; }
    const previousX = this.state.x + this.offsetX;
    const previousY = this.state.y + this.offsetY;
    const corrected = copyFighter(auth);
    const hasAck = Number.isSafeInteger(auth.seq);
    const replay = corrected.grabbedBy ? [] : this.history.filter(input => hasAck
      ? input.seq > auth.seq : input.at >= now - clamp(oneWayMs, 15, 130));
    for (const input of replay) {
      if (!input.shield) corrected.shielding = false;
      if (input.move || input.shield || input.jump || input.upair) corrected.emoteTime = 0;
      if (input.jump) jumpBrawlFighter(corrected, input.down);
      if (input.upair && recoverBrawlFighter(corrected, input.move)) {
        corrected.attack = 'upair'; corrected.attackTime = 0;
      }
      stepBrawlMovement(corrected, input.move, BRAWL.tick, input.shield);
      if (corrected.attack === 'upair') {
        corrected.attackTime += BRAWL.tick;
        if (corrected.attackTime >= ATTACKS.upair.total) corrected.attack = null;
      }
    }
    const hardCorrection = Math.hypot(corrected.x - this.state.x, corrected.y - this.state.y) > 100 ||
      auth.stocks !== this.lastAuth?.stocks || auth.percent !== this.lastAuth?.percent ||
      auth.respawn > 0 || auth.character !== this.lastAuth?.character ||
      auth.grabbedBy !== this.lastAuth?.grabbedBy || auth.grabTarget !== this.lastAuth?.grabTarget;
    this.state = corrected;
    this.offsetX = hardCorrection ? 0 : clamp(previousX - corrected.x, -55, 55);
    this.offsetY = hardCorrection ? 0 : clamp(previousY - corrected.y, -55, 55);
    this.history = this.history.filter(input => input.at > now - 1000 && (!hasAck || input.seq > auth.seq));
    this.lastAuth = { ...auth };
  }

  visual(frameSeconds) {
    if (!this.state) return null;
    const easing = Math.exp(-frameSeconds / 0.11);
    this.offsetX *= easing; this.offsetY *= easing;
    return { ...this.state, x: this.state.x + this.offsetX, y: this.state.y + this.offsetY };
  }
}
