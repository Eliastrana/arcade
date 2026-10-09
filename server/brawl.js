import { BRAWL, BRAWL_WORLDS, BRAWL_TEAMS, BRAWL_EMOTE, BRAWL_EMOTE_LINES, FIGHTERS, ATTACKS, CAPE, EGG_LAY, THUNDER, DIN_FIRE, eggLayDuration, isBrawlRollInvulnerable, makeFighter, knockback, launchBrawlVelocity, waftBrawlAttack, throwBrawlVelocity, resetFighter, isOut, jumpBrawlFighter, recoverBrawlFighter, stepBrawlMovement } from '../shared/brawl.js';

const MAX_PLAYERS = 4;
const RESULTS_SECONDS = 7;
const IDLE_MATCH_MS = 45_000;
const LIMIT = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// One match room. Several of these run side by side: server/index.js puts each new player in the open room with the
// most people waiting, or starts a new one. `onEmpty` is called when the last player leaves, so the room can be removed.
export function createBrawlRoom({ id: roomId = 1, onEmpty } = {}) {
  const clients = new Map();
  let nextId = 1;
  let nextProjectile = 1;
  let frame = 0;
  let phase = 'lobby';
  let countdown = 0;
  let resultsLeft = 0;
  let elapsed = 0;
  let lastActivityAt = Date.now();
  let winner = null;
  let winnerTeam = null;
  let mode = 'ffa';
  let friendlyFire = false;
  let world = 'dolomittene';
  let projectiles = [];
  let events = [];

  const participants = () => [...clients.values()].filter(p => !p.spectator);
  const hostId = () => participants()[0]?.id ?? null;
  const teamCount = (team, excludeId = null) => participants().filter(p => p.team === team && p.id !== excludeId).length;
  const openTeam = () => teamCount('red') <= teamCount('blue') ? 'red' : 'blue';
  const canHit = (attacker, target) => mode !== 'teams' || friendlyFire || attacker.team !== target.team;
  const send = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };

  function chooseWorld(players) {
    const counts = Object.fromEntries(Object.keys(BRAWL_WORLDS).map(key => [key, 0]));
    for (const p of players) counts[p.worldVote]++;
    const highest = Math.max(...Object.values(counts));
    const tied = Object.keys(counts).filter(key => counts[key] === highest);
    return tied[Math.floor(Math.random() * tied.length)];
  }

  function promoteWaiting() {
    if (phase === 'playing' || phase === 'countdown') return;
    let openSlots = MAX_PLAYERS - participants().length;
    for (const p of clients.values()) {
      if (!p.spectator || openSlots <= 0) continue;
      p.team = openTeam();
      p.spectator = false;
      p.ready = false;
      openSlots--;
    }
  }

  function openLobby() {
    phase = 'lobby'; countdown = 0; resultsLeft = 0; winner = null; winnerTeam = null;
    for (const p of clients.values()) p.ready = false;
    promoteWaiting();
  }

  function lobbyIfEmpty() {
    if (clients.size) return;
    openLobby(); elapsed = 0;
    mode = 'ffa'; friendlyFire = false;
    projectiles = []; events = [];
    onEmpty?.();
  }

  function finish(forceDraw = false) {
    if (phase !== 'playing') return;
    const alive = participants().filter(p => p.stocks > 0);
    if (!forceDraw && (mode === 'teams' ? new Set(alive.map(p => p.team)).size > 1 : alive.length > 1)) return;
    phase = 'results';
    resultsLeft = RESULTS_SECONDS;
    winner = mode === 'ffa' && !forceDraw ? alive[0]?.id ?? null : null;
    winnerTeam = mode === 'teams' && !forceDraw ? alive[0]?.team ?? null : null;
    for (const p of participants()) if (p.grabTarget) releaseGrab(p);
    for (const p of clients.values()) p.ready = false;
    events.push({ type: 'gameover', winner, winnerTeam });
    promoteWaiting();
  }

  function startMatch() {
    const ready = participants();
    if (phase !== 'lobby' || ready.length < 2 || !ready.every(p => p.ready) ||
        (mode === 'teams' && new Set(ready.map(p => p.team)).size < 2)) return;
    phase = 'countdown'; countdown = 3.2; winner = null; winnerTeam = null; elapsed = 0;
    world = chooseWorld(ready);
    lastActivityAt = Date.now();
    projectiles = [];
    const teamSlots = { red: [0, 2], blue: [1, 3] };
    ready.forEach((p, slot) => resetFighter(p, mode === 'teams' ? teamSlots[p.team].shift() : slot));
    events.push({ type: 'countdown' });
  }

  function join(ws) {
    const spectator = participants().length >= MAX_PLAYERS || phase === 'playing' || phase === 'countdown';
    const id = nextId++;
    const p = makeFighter(id, `Spiller ${id}`, 'mario', participants().length);
    p.spectator = spectator;
    if (!spectator) p.team = openTeam();
    p.input = { move: 0, down: false, shield: false, lastAt: 0, seq: 0 };
    p.lastSeq = 0;
    p.lastHitBy = null; p.lastHitAt = -Infinity;
    clients.set(ws, p);
    send(ws, { t: 'brawl-welcome', id, spectator, inputVersion: 2,
      features: ['shield', 'grab', 'upair', 'throws', 'roll', 'teams', 'emotes'], roster: Object.keys(FIGHTERS), worlds: BRAWL_WORLDS });

    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'net-ping') {
        if (Number.isSafeInteger(m.id) && m.id >= 0) send(ws, { t: 'net-pong', id: m.id });
      } else if (m.t === 'brawl-name') {
        const name = String(m.name ?? '').slice(0, 16).replace(/[^\w \-]/g, '').trim();
        if (name) p.name = name;
      } else if (m.t === 'brawl-character' && phase !== 'playing' && phase !== 'countdown') {
        if (Object.hasOwn(FIGHTERS, m.character)) { p.character = m.character; p.ready = false; }
      } else if (m.t === 'brawl-world') {
        if (Object.hasOwn(BRAWL_WORLDS, m.world)) {
          if (p.worldVote !== m.world && (phase === 'lobby' || phase === 'results')) p.ready = false;
          p.worldVote = m.world;
        }
      } else if (m.t === 'brawl-mode' && phase === 'lobby' && p.id === hostId()) {
        if ((m.mode === 'ffa' || m.mode === 'teams') && mode !== m.mode) {
          mode = m.mode;
          for (const player of participants()) player.ready = false;
        }
      } else if (m.t === 'brawl-friendly-fire' && phase === 'lobby' &&
          p.id === hostId() && mode === 'teams' && typeof m.enabled === 'boolean') {
        if (friendlyFire !== m.enabled) {
          friendlyFire = m.enabled;
          for (const player of participants()) player.ready = false;
        }
      } else if (m.t === 'brawl-team' && phase === 'lobby' &&
          mode === 'teams' && !p.spectator && Object.hasOwn(BRAWL_TEAMS, m.team)) {
        if (p.team !== m.team && teamCount(m.team, p.id) < 2) {
          p.team = m.team;
          p.ready = false;
        }
      } else if (m.t === 'brawl-ready' && (phase === 'lobby' || phase === 'results')) {
        if (p.spectator) return;
        if (phase === 'results') openLobby();
        p.ready = !!m.ready;
        startMatch();
      } else if (m.t === 'brawl-input' && phase === 'playing' && !p.spectator) {
        const seq = Number.isSafeInteger(m.seq) && m.seq > 0 ? m.seq : 0;
        if (seq && seq <= p.input.seq) return;
        p.input.move = m.move < 0 ? -1 : m.move > 0 ? 1 : 0;
        p.input.down = !!m.down;
        p.input.shield = !!m.shield;
        if (!p.input.shield) p.shielding = false;
        p.input.lastAt = Date.now();
        if (seq) p.input.seq = seq;
        if (p.input.move || p.input.down) lastActivityAt = p.input.lastAt;
        if (seq && m.jump) jump(p);
        if (seq && m.upair) attack(p, 'upair');
      } else if (m.t === 'brawl-action' && phase === 'playing' && !p.spectator) {
        lastActivityAt = Date.now();
        if (m.action === 'jump') jump(p);
        else if (m.action === 'emote') emote(p);
        else if (m.action === 'throw' || (m.action === 'grab' && p.grabTarget)) throwGrab(p, m.dirX, m.dirY);
        else if (Object.hasOwn(ATTACKS, m.action)) attack(p, m.action);
      }
    });

    const drop = () => {
      if (!clients.has(ws)) return;
      if (p.grabTarget) releaseGrab(p);
      if (p.grabbedBy) {
        const holder = participants().find(other => other.id === p.grabbedBy);
        if (holder) releaseGrab(holder);
      }
      clients.delete(ws);
      if (phase === 'playing') finish();
      if (phase === 'countdown' && (participants().length < 2 ||
          (mode === 'teams' && new Set(participants().map(player => player.team)).size < 2))) openLobby();
      promoteWaiting();
      lobbyIfEmpty();
    };
    ws.on('close', drop); ws.on('error', drop);
  }

  function jump(p) {
    const kind = jumpBrawlFighter(p, p.input.down);
    if (kind) p.emoteTime = 0;
    if (kind && kind !== 'drop') events.push({ type: kind, p: p.id, x: p.x, y: p.y });
  }

  function emote(p) {
    if (p.stocks <= 0 || p.respawn > 0 || !p.grounded || p.stun > 0 || p.attack ||
        p.shielding || p.input.shield || p.rollTime > 0 || p.grabTarget || p.grabbedBy ||
        p.eggTime > 0 || p.hookTime > 0 || p.emoteCooldown > 0 ||
        (Date.now() - p.input.lastAt < 250 && p.input.move)) return;
    p.emoteTime = BRAWL_EMOTE.duration;
    p.emoteCooldown = BRAWL_EMOTE.cooldown;
    p.vx = 0;
    events.push({ type: 'emote', p: p.id, character: p.character,
      line: BRAWL_EMOTE_LINES[p.character].text, x: p.x, y: p.y });
  }

  function attack(p, kind) {
    if (p.stocks <= 0 || p.respawn > 0 || p.stun > 0 || p.attack || p.shielding || p.rollTime > 0 || p.input.shield || p.grabTarget || p.grabbedBy) return;
    if (kind === 'upair') {
      if (!recoverBrawlFighter(p, p.input.move)) return;
      events.push({ type: 'recovery', p: p.id, x: p.x, y: p.y });
    }
    p.attack = kind; p.attackTime = 0; p.attackHit = false; p.attackVictims = new Set();
    p.emoteTime = 0;
    if (p.input.move) p.face = p.input.move;
    events.push({ type: 'swing', p: p.id, kind, x: p.x, y: p.y });
  }

  function releaseGrab(holder) {
    const target = participants().find(other => other.id === holder.grabTarget);
    if (target && target.grabbedBy === holder.id) target.grabbedBy = null;
    holder.grabTarget = null;
    holder.grabTimer = 0;
    return target;
  }

  function catchFighter(holder, target) {
    if (!canHit(holder, target) || holder.grabTarget || target.grabbedBy || target.grabTarget ||
        target.stocks <= 0 || target.respawn > 0 || target.invuln > 0 || isBrawlRollInvulnerable(target)) return false;
    holder.grabTarget = target.id; holder.grabTimer = 1.2;
    holder.attack = null; holder.vx *= 0.25;
    target.grabbedBy = holder.id; target.shielding = false;
    target.emoteTime = 0;
    target.rollTime = 0;
    target.attack = null; target.vx = 0; target.vy = 0;
    target.grounded = false; target.coyote = 0; target.drop = 0; target.throwBounce = 0;
    target.hookedBy = null; target.hookTime = 0;
    target.x = holder.x + holder.face * 35; target.y = holder.y - 9;
    events.push({ type: 'grab', p: holder.id, to: target.id, x: target.x, y: target.y - 38 });
    return true;
  }

  function throwGrab(holder, rawX = 0, rawY = 0) {
    if (!holder.grabTarget) return;
    const target = releaseGrab(holder);
    if (!target || target.stocks <= 0 || target.respawn > 0) return;
    target.percent = Math.min(999, target.percent + ATTACKS.grab.damage);
    const velocity = throwBrawlVelocity(target.character, target.percent, holder.face, rawX, rawY);
    target.vx = velocity.vx;
    target.vy = velocity.vy;
    target.throwBounce = velocity.bounce;
    if (velocity.dirY > 0) {
      target.y = holder.y - 70;
    }
    target.grounded = false; target.coyote = 0; target.drop = 0;
    target.hookedBy = null; target.hookTime = 0;
    target.stun = LIMIT(0.22 + velocity.speed / 1800, 0.28, 0.85);
    target.flash = 0.18;
    target.lastHitBy = holder.id; target.lastHitAt = elapsed;
    events.push({ type: 'throw', p: holder.id, to: target.id, x: target.x, y: target.y - 38, dirX: velocity.dirX, dirY: velocity.dirY });
    events.push({ type: 'hit', from: holder.id, to: target.id, x: target.x, y: target.y - 38,
      damage: ATTACKS.grab.damage, percent: target.percent, power: velocity.speed });
  }

  function damage(attacker, target, move, x, y, direction) {
    if (!canHit(attacker, target) || target.stocks <= 0 || target.respawn > 0 || target.invuln > 0 || isBrawlRollInvulnerable(target) || target.grabbedBy) return false;
    if (target.grabTarget) releaseGrab(target);
    target.throwBounce = 0;
    target.hookedBy = null; target.hookTime = 0;
    if (target.shielding && move !== ATTACKS.grab) {
      target.shield = Math.max(0, target.shield - 14 - move.damage * 2.3);
      target.shieldRegenDelay = 0.8;
      target.vx = direction * Math.min(120, 25 + move.damage * 4);
      if (target.shield <= 0) {
        target.shielding = false; target.shieldBreak = 1.3; target.stun = 1.3;
        events.push({ type: 'shieldbreak', p: target.id, x: target.x, y: target.y });
      } else {
        events.push({ type: 'block', p: target.id, x: target.x, y: target.y });
      }
      return true;
    }
    target.percent = Math.min(999, target.percent + move.damage);
    target.emoteTime = 0;
    const speed = knockback(move, target.percent, FIGHTERS[target.character].weight);
    const launch = launchBrawlVelocity(speed, move.angle, direction);
    target.vx = launch.vx;
    target.vy = launch.vy;
    target.rollTime = 0;
    target.grounded = false; target.coyote = 0;
    target.stun = LIMIT(0.1 + speed / 1550, 0.18, 0.9);
    target.attack = null; target.flash = 0.18;
    target.lastHitBy = attacker.id; target.lastHitAt = elapsed;
    events.push({ type: 'hit', from: attacker.id, to: target.id, x, y,
      damage: move.damage, percent: target.percent, power: speed });
    return true;
  }

  function stepDefense(p, dt) {
    if (p.spectator || p.stocks <= 0 || p.respawn > 0) { p.shielding = false; return; }
    p.shieldBreak = Math.max(0, p.shieldBreak - dt);
    p.shieldRegenDelay = Math.max(0, p.shieldRegenDelay - dt);
    p.shielding = !p.rollTime && !p.grabTarget && !p.grabbedBy && !!p.input.shield && Date.now() - p.input.lastAt < 300 &&
      p.grounded && p.shield > 0 && p.shieldBreak <= 0 && p.stun <= 0 && !p.attack;
    if (p.shielding) {
      p.shield = Math.max(0, p.shield - 18 * dt);
      p.shieldRegenDelay = 0.55;
      if (p.shield <= 0) {
        p.shielding = false; p.shieldBreak = 1.3; p.stun = 1.3;
        events.push({ type: 'shieldbreak', p: p.id, x: p.x, y: p.y });
      }
    } else if (p.shieldRegenDelay <= 0) p.shield = Math.min(100, p.shield + 24 * dt);
  }

  function spawnProjectile(p) {
    const styles = {
      isabelle: { kind: 'rod', speed: 690, vy: -35, gravity: 140, bounce: 0, damage: 5, base: 110, growth: 340, angle: 65 },
      zelda: { kind: 'din', speed: 520, vy: 0, gravity: 0, bounce: 0, life: 0.86 },
    };
    const style = styles[p.character];
    projectiles.push({ id: nextProjectile++, owner: p.id, character: p.character,
      x: p.x + p.face * 32, y: p.y - 42, vx: p.face * style.speed,
      vy: style.vy, life: 1.55, bounce: style.bounce, ...style });
    events.push({ type: 'projectile', p: p.id, x: p.x, y: p.y });
  }

  function sweepCape(p) {
    events.push({ type: 'cape', p: p.id, x: p.x + p.face * 52, y: p.y - 40, dir: p.face });
    for (const target of participants()) {
      if (target.id === p.id || (target.x - p.x) * p.face < -12 ||
          (target.x - p.x) * p.face > CAPE.reach || Math.abs(target.y - p.y) > CAPE.height) continue;
      const guarded = target.shielding;
      if (!damage(p, target, CAPE, target.x, target.y - 38, p.face) || guarded) continue;
      target.face *= -1;
      target.vx = -p.face * Math.max(165, Math.abs(target.vx));
      target.vy = Math.min(target.vy, -105);
      target.stun = Math.max(target.stun, CAPE.spin);
      target.spinTime = CAPE.spin; target.spinDir = p.face;
      events.push({ type: 'capeturn', p: p.id, to: target.id, x: target.x, y: target.y - 38 });
    }
  }

  function layEgg(p) {
    events.push({ type: 'tongue', p: p.id, x: p.x + p.face * 55, y: p.y - 38, dir: p.face });
    const target = participants().filter(other => other.id !== p.id && canHit(p, other) &&
      (other.x - p.x) * p.face >= -8 && (other.x - p.x) * p.face <= EGG_LAY.reach &&
      Math.abs(other.y - p.y) <= EGG_LAY.height)
      .sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    if (!target) return;
    const guarded = target.shielding;
    if (!damage(p, target, EGG_LAY, target.x, target.y - 38, p.face) || guarded) return;
    target.x = p.x - p.face * 58;
    target.y = p.y - 12;
    target.vx = -p.face * 190; target.vy = -190;
    target.grounded = false; target.coyote = 0; target.drop = 0;
    target.eggTime = eggLayDuration(target.percent);
    target.stun = Math.max(target.stun, target.eggTime);
    events.push({ type: 'egg', p: p.id, to: target.id, x: target.x, y: target.y - 38 });
  }

  function summonThunder(p) {
    const x = LIMIT(p.x + p.face * THUNDER.offset, 25, BRAWL.width - 25);
    projectiles.push({ id: nextProjectile++, owner: p.id, character: p.character,
      kind: 'thunder', x, y: -16, vx: 0, vy: THUNDER.speed, gravity: 0,
      life: 0.65, bounce: 0, ...THUNDER });
    events.push({ type: 'thunder', p: p.id, x, y: -16 });
  }

  function burstWaft(p) {
    const charge = p.waftCharge;
    const { radius, lift, ...move } = waftBrawlAttack(charge);
    for (const target of participants()) {
      if (target.id === p.id || Math.hypot(target.x - p.x, target.y - p.y) > radius) continue;
      damage(p, target, move, target.x, target.y - 38, Math.sign(target.x - p.x) || p.face);
    }
    p.waftCharge = 0;
    p.vy = Math.min(p.vy, -lift);
    p.grounded = false; p.coyote = 0;
    events.push({ type: 'waft', p: p.id, x: p.x, y: p.y - 36, radius, charge });
  }

  function detonateDin(projectile, owner) {
    if (projectile.detonated) return;
    projectile.detonated = true;
    projectile.life = 0;
    events.push({ type: 'dinblast', p: owner.id, x: projectile.x, y: projectile.y, radius: DIN_FIRE.radius });
    for (const target of participants()) {
      if (target.id === owner.id || Math.hypot(target.x - projectile.x, target.y - 35 - projectile.y) > DIN_FIRE.radius) continue;
      const direction = Math.sign(target.x - projectile.x) || Math.sign(projectile.vx) || 1;
      damage(owner, target, DIN_FIRE, target.x, target.y - 38, direction);
    }
  }

  function stepFighter(p, dt) {
    if (p.spectator || p.stocks <= 0) return;
    p.flash = Math.max(0, p.flash - dt);
    p.emoteTime = Math.max(0, p.emoteTime - dt);
    p.emoteCooldown = Math.max(0, p.emoteCooldown - dt);
    p.spinTime = Math.max(0, p.spinTime - dt);
    if (p.eggTime > 0) {
      p.eggTime = Math.max(0, p.eggTime - dt);
      if (!p.eggTime && p.respawn <= 0) events.push({ type: 'eggpop', p: p.id, x: p.x, y: p.y - 38 });
    }
    if (p.respawn > 0) {
      p.respawn -= dt;
      if (p.respawn <= 0) {
        p.x = 480; p.y = 124; p.vx = 0; p.vy = 0;
        p.percent = 0; p.invuln = 2.15; p.jumps = 0;
        p.shield = 100; p.shielding = false; p.shieldBreak = 0; p.shieldRegenDelay = 0; p.recoveryUsed = false;
        p.rollTime = 0; p.rollCooldown = 0; p.rollDir = 0; p.rollInput = 0;
        p.grabTarget = null; p.grabbedBy = null; p.grabTimer = 0; p.throwBounce = 0;
        p.hookedBy = null; p.hookTime = 0;
        p.spinTime = 0; p.spinDir = 0; p.eggTime = 0;
        p.emoteTime = 0; p.emoteCooldown = 0;
        p.grounded = false; p.lastHitBy = null; p.lastHitAt = -Infinity;
        events.push({ type: 'respawn', p: p.id });
      }
      return;
    }
    p.invuln = Math.max(0, p.invuln - dt);
    if (p.character === 'wario') p.waftCharge = Math.min(1, p.waftCharge + dt / 18);
    if (p.grabbedBy) { p.vx = 0; p.vy = 0; return; }
    if (p.hookTime > 0) {
      const owner = participants().find(other => other.id === p.hookedBy);
      p.hookTime = Math.max(0, p.hookTime - dt);
      if (owner && owner.stocks > 0 && owner.respawn <= 0) {
        p.vx = LIMIT((owner.x - p.x) * 4, -520, 520);
        p.vy = -Math.max(210, Math.min(390, Math.abs(owner.x - p.x) * 0.7));
        p.stun = Math.max(p.stun, p.hookTime);
      } else p.hookTime = 0;
      if (p.hookTime <= 0) p.hookedBy = null;
    }
    if (p.grabTarget) {
      p.grabTimer -= dt;
      if (p.grabTimer <= 0) throwGrab(p);
    }
    const freshInput = Date.now() - p.input.lastAt < 250;
    const move = p.grabTarget ? 0 : freshInput ? p.input.move : 0;
    if (move || (freshInput && p.input.shield) || p.stun > 0 || !p.grounded) p.emoteTime = 0;
    const wasRolling = p.rollTime > 0;
    if (stepBrawlMovement(p, move, dt, freshInput && p.input.shield)) events.push({ type: 'land', p: p.id, x: p.x, y: p.y });
    if (!wasRolling && p.rollTime > 0) events.push({ type: 'roll', p: p.id, x: p.x, y: p.y, dir: p.rollDir });

    if (p.attack) {
      const kind = p.attack;
      const moveData = ATTACKS[kind];
      p.attackTime += dt;
      if (kind === 'special' && !p.attackHit && p.attackTime >= moveData.startup) {
        p.attackHit = true;
        if (p.character === 'wario') burstWaft(p);
        else if (p.character === 'mario') sweepCape(p);
        else if (p.character === 'yoshi') layEgg(p);
        else if (p.character === 'pikachu') summonThunder(p);
        else spawnProjectile(p);
      }
      if (kind !== 'special' && p.attackTime >= moveData.startup && p.attackTime < moveData.startup + moveData.active) {
        for (const target of participants()) {
          if (target.id === p.id || p.attackVictims.has(target.id)) continue;
          const forward = (target.x - p.x) * p.face;
          const vertical = Math.abs(target.y - p.y);
          const inRange = kind === 'upair'
            ? Math.abs(target.x - p.x) <= 52 && target.y <= p.y + 16 && target.y >= p.y - 104
            : forward >= -15 && forward <= moveData.reach + moveData.radius && vertical <= 58;
          if (inRange) {
            if (kind === 'grab') {
              if (catchFighter(p, target)) break;
            } else if (damage(p, target, moveData, target.x, target.y - 38, p.face)) p.attackVictims.add(target.id);
          }
        }
      }
      if (p.attack && p.attackTime >= moveData.total) p.attack = null;
    }

    if (isOut(p)) {
      if (p.grabTarget) releaseGrab(p);
      p.stocks--;
      p.falls++;
      const killer = elapsed - p.lastHitAt < 8 ? participants().find(other => other.id === p.lastHitBy) : null;
      if (killer) killer.kos++;
      events.push({ type: 'ko', p: p.id, by: killer?.id ?? null, stocks: p.stocks, x: p.x, y: p.y });
      p.attack = null; p.vx = 0; p.vy = 0; p.respawn = p.stocks > 0 ? 1.45 : 9999;
      p.hookedBy = null; p.hookTime = 0;
      p.spinTime = 0; p.spinDir = 0; p.eggTime = 0;
      p.emoteTime = 0;
      p.shielding = false; p.recoveryUsed = false; p.rollTime = 0; p.rollInput = 0;
      p.x = LIMIT(p.x, 0, BRAWL.width); p.y = -100;
    }
  }

  function stepProjectiles(dt) {
    for (const projectile of projectiles) {
      const owner = participants().find(p => p.id === projectile.owner);
      if (!owner) { projectile.life = 0; continue; }
      const previousY = projectile.y;
      projectile.x += projectile.vx * dt;
      projectile.vy += projectile.gravity * dt;
      projectile.y += projectile.vy * dt;
      projectile.life -= dt;
      if (projectile.x < -20 || projectile.x > 980 || projectile.y > 540) { projectile.life = 0; continue; }
      if (projectile.kind === 'thunder') {
        // Pass through the small platforms so a fighter below one is still vulnerable.
        const stage = BRAWL.platforms[0];
        if (previousY <= stage.y && projectile.y >= stage.y &&
            projectile.x >= stage.x && projectile.x <= stage.x + stage.w) {
          events.push({ type: 'thunderimpact', p: owner.id, x: projectile.x, y: stage.y });
          projectile.life = 0;
        }
      }
      if (projectile.vy > 0 && projectile.kind !== 'thunder') {
        for (const platform of BRAWL.platforms) {
          if (previousY <= platform.y && projectile.y >= platform.y &&
              projectile.x >= platform.x && projectile.x <= platform.x + platform.w) {
            if (projectile.kind === 'din') {
              projectile.y = platform.y - 4;
              detonateDin(projectile, owner);
            } else if (projectile.bounce > 0) {
              projectile.y = platform.y - 2; projectile.vy = -250;
              projectile.bounce--;
            } else projectile.life = 0;
            break;
          }
        }
      }
      if (projectile.life <= 0) {
        if (projectile.kind === 'din' && !projectile.detonated) detonateDin(projectile, owner);
        continue;
      }
      for (const target of participants()) {
        if (target.id === owner.id || !canHit(owner, target)) continue;
        if (Math.hypot(target.x - projectile.x, target.y - 35 - projectile.y) <
            (projectile.kind === 'thunder' ? THUNDER.radius : 32)) {
          if (projectile.kind === 'din') {
            detonateDin(projectile, owner);
            break;
          }
          const guarded = target.shielding;
          const hit = damage(owner, target, projectile, projectile.x, projectile.y,
            projectile.kind === 'thunder' ? Math.sign(target.x - projectile.x) || owner.face : Math.sign(projectile.vx));
          if (hit) projectile.life = 0;
          if (hit && projectile.kind === 'thunder')
            events.push({ type: 'thunderimpact', p: owner.id, x: projectile.x, y: projectile.y });
          if (hit && projectile.kind === 'rod' && !guarded && target.stocks > 0) {
            target.hookedBy = owner.id;
            target.hookTime = 0.38;
            events.push({ type: 'hook', p: owner.id, to: target.id, x: target.x, y: target.y - 38 });
          }
          if (projectile.life <= 0) break;
        }
      }
    }
    projectiles = projectiles.filter(p => p.life > 0);
  }

  function tick() {
    frame++;
    if (phase === 'countdown') {
      countdown -= BRAWL.tick;
      if (countdown <= 0) {
        phase = 'playing'; countdown = 0;
        events.push({ type: 'go' });
      }
    } else if (phase === 'playing') {
      elapsed += BRAWL.tick;
      for (const p of participants()) stepDefense(p, BRAWL.tick);
      for (const p of participants()) {
        stepFighter(p, BRAWL.tick);
        p.lastSeq = p.input.seq;
      }
      for (const holder of participants()) {
        if (!holder.grabTarget) continue;
        const target = participants().find(other => other.id === holder.grabTarget);
        if (!target || target.grabbedBy !== holder.id) { releaseGrab(holder); continue; }
        target.x = holder.x + holder.face * 35;
        target.y = holder.y - 9;
        target.vx = 0; target.vy = 0;
      }
      stepProjectiles(BRAWL.tick);
      finish();
      if (Date.now() - lastActivityAt > IDLE_MATCH_MS) finish(true);
    } else if (phase === 'results') {
      resultsLeft -= BRAWL.tick;
      if (resultsLeft <= 0) openLobby();
    }
  }

  function snapshot() {
    const data = JSON.stringify({
      t: 'brawl-state', room: roomId, frame, phase, countdown: +countdown.toFixed(2), elapsed: +elapsed.toFixed(3),
      winner, winnerTeam, mode, friendlyFire, hostId: hostId(), world,
      players: [...clients.values()].map(p => ({
        id: p.id, name: p.name, character: p.character, team: p.team, worldVote: p.worldVote,
        ready: p.ready, spectator: p.spectator,
        x: +p.x.toFixed(1), y: +p.y.toFixed(1), vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1),
        face: p.face, percent: p.percent, stocks: p.stocks, grounded: p.grounded,
        jumps: p.jumps, coyote: +p.coyote.toFixed(3), drop: +p.drop.toFixed(3), groundIndex: p.groundIndex ?? -1, seq: p.lastSeq,
        attack: p.attack, attackTime: +p.attackTime.toFixed(2), stun: +p.stun.toFixed(2),
        shield: +p.shield.toFixed(1), shielding: p.shielding, shieldBreak: +p.shieldBreak.toFixed(2), recoveryUsed: p.recoveryUsed,
        rollTime: +p.rollTime.toFixed(3), rollCooldown: +p.rollCooldown.toFixed(3), rollDir: p.rollDir, rollInput: p.rollInput,
        grabTarget: p.grabTarget, grabbedBy: p.grabbedBy, grabTimer: +p.grabTimer.toFixed(2), throwBounce: +p.throwBounce.toFixed(1),
        hookedBy: p.hookedBy, hookTime: +p.hookTime.toFixed(2), waftCharge: +p.waftCharge.toFixed(3),
        spinTime: +p.spinTime.toFixed(3), spinDir: p.spinDir, eggTime: +p.eggTime.toFixed(3),
        emoteTime: +p.emoteTime.toFixed(3), emoteCooldown: +p.emoteCooldown.toFixed(3),
        invuln: +p.invuln.toFixed(2), respawn: +p.respawn.toFixed(2),
        kos: p.kos, falls: p.falls, flash: +p.flash.toFixed(2),
      })),
      projectiles: projectiles.map(p => ({
        id: p.id, owner: p.owner, character: p.character, kind: p.kind,
        x: +p.x.toFixed(1), y: +p.y.toFixed(1),
        vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1), gravity: p.gravity,
      })),
      events,
    });
    events = [];
    for (const ws of clients.keys()) sendRaw(ws, data);
  }

  function sendRaw(ws, data) { if (ws.readyState === 1) ws.send(data); }
  // Keep the published state on the same 60 Hz cadence as the simulation.
  const loop = setInterval(() => {
    tick();
    if (clients.size) snapshot();
  }, BRAWL.tick * 1000);
  return {
    join,
    id: roomId,
    /** Newcomers may join between matches while there is a free slot. */
    open: () => (phase === 'lobby' || phase === 'results') && participants().length < MAX_PLAYERS,
    size: () => participants().length,
    names: () => participants().map(p => p.name),
    phase: () => phase,
    dispose: () => clearInterval(loop),
  };
}
