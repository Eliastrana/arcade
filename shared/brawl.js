// Shared stage dimensions and combat tuning. The server runs the simulation;
// the browser imports these values only to draw the same stage and HUD.
export const BRAWL = Object.freeze({
  width: 960, height: 540, tick: 1 / 60, stocks: 3,
  blast: { left: -110, right: 1070, top: -145, bottom: 675 },
  platforms: [
    { x: 170, y: 420, w: 620, h: 28, main: true },
    { x: 260, y: 312, w: 150, h: 15 },
    { x: 550, y: 312, w: 150, h: 15 },
    { x: 415, y: 227, w: 130, h: 15 },
  ],
});

export const BRAWL_WORLDS = Object.freeze({
  dolomittene: 'dolomittene',
  nightcity: 'night city',
});

export const BRAWL_TEAMS = Object.freeze({ red: '#f27a72', blue: '#79beff' });

export const FIGHTERS = Object.freeze({
  mario: { label: 'Mario', color: '#ee4a4d', accent: '#3988dd', speed: 284, weight: 1.03, jump: 585, air: 0.95, special: 'Cape · reverses foes', recovery: 760, recoveryDrift: 290 },
  yoshi: { label: 'Yoshi', color: '#70d765', accent: '#f5f3db', speed: 296, weight: 0.94, jump: 618, air: 1.06, special: 'Egg lay · tongue catch', recovery: 820, recoveryDrift: 240 },
  pikachu: { label: 'Pikachu', color: '#f8d74d', accent: '#db644b', speed: 315, weight: 0.88, jump: 603, air: 1.12, special: 'Thunder · sky strike', recovery: 865, recoveryDrift: 330 },
  isabelle: { label: 'Isabelle', color: '#f7d88b', accent: '#9bce8c', speed: 278, weight: 0.9, jump: 605, air: 1.04, special: 'Fishing rod', recovery: 840, recoveryDrift: 310 },
  wario: { label: 'Wario', color: '#f5d34d', accent: '#9162b6', speed: 265, weight: 1.13, jump: 570, air: 0.9, special: 'Waft · charges over time', recovery: 735, recoveryDrift: 260 },
  zelda: { label: 'Zelda', color: '#c998ed', accent: '#f1d68f', speed: 274, weight: 0.93, jump: 598, air: 1.02, special: "Din's Fire", recovery: 855, recoveryDrift: 305 },
});

export const DIN_FIRE = Object.freeze({ radius: 62, damage: 10, base: 175, growth: 525, angle: 73 });
export const CAPE = Object.freeze({ damage: 4, base: 0, growth: 0, angle: 90, reach: 106, height: 65, spin: 0.48 });
export const EGG_LAY = Object.freeze({ damage: 8, base: 0, growth: 0, angle: 90, reach: 122, height: 62,
  baseDuration: 0.6, durationPerPercent: 0.006, maxDuration: 1.8 });
export const THUNDER = Object.freeze({ damage: 13, base: 185, growth: 550, angle: 82, speed: 1160, radius: 44, offset: 94 });
export const BRAWL_ROLL = Object.freeze({ duration: 0.34, cooldown: 0.8, speed: 440,
  invulnStart: 0.05, invulnEnd: 0.25, shieldCost: 8 });
export const BRAWL_EMOTE = Object.freeze({ duration: 1.8, cooldown: 2.4 });
export const BRAWL_EMOTE_LINES = Object.freeze({
  mario: { text: "it's-a me, mario!", speech: "it's a me, mario!", pitch: 1.15, rate: 1.08 },
  yoshi: { text: 'yoshi!', speech: 'yoshi!', pitch: 1.8, rate: 1.2 },
  pikachu: { text: 'pika pika!', speech: 'pika pika!', pitch: 1.75, rate: 1.28 },
  isabelle: { text: "let's dance!", speech: "let's dance!", pitch: 1.45, rate: 1.08 },
  wario: { text: 'wah-ha-ha!', speech: 'wah ha ha!', pitch: 0.7, rate: 0.9 },
  zelda: { text: 'for hyrule!', speech: 'for hyrule!', pitch: 1.05, rate: 0.95 },
});

export const ATTACKS = Object.freeze({
  jab: { damage: 6, base: 145, growth: 470, startup: 0.065, active: 0.11, total: 0.31, reach: 70, radius: 30, angle: 55 },
  smash: { damage: 15, base: 220, growth: 720, startup: 0.19, active: 0.14, total: 0.66, reach: 83, radius: 36, angle: 58 },
  special: { damage: 8, base: 165, growth: 535, startup: 0.16, active: 0, total: 0.52, reach: 0, radius: 0, angle: 56 },
  grab: { damage: 5, base: 155, growth: 465, startup: 0.09, active: 0.11, total: 0.43, reach: 48, radius: 26, angle: 62 },
  upair: { damage: 7, base: 155, growth: 500, startup: 0.05, active: 0.25, total: 0.46, reach: 42, radius: 35, angle: 80 },
});

export const SPAWNS = [290, 670, 385, 575];

export function makeFighter(id, name, character, slot) {
  const x = SPAWNS[slot % SPAWNS.length];
  return {
    id, name, character, slot, team: slot % 2 ? 'blue' : 'red', worldVote: 'dolomittene', x, y: 370, vx: 0, vy: 0,
    face: slot % 2 ? -1 : 1, percent: 0, stocks: BRAWL.stocks,
    grounded: false, jumps: 0, coyote: 0, drop: 0,
    attack: null, attackTime: 0, attackHit: false,
    shield: 100, shielding: false, shieldBreak: 0, shieldRegenDelay: 0,
    rollTime: 0, rollCooldown: 0, rollDir: 0, rollInput: 0,
    recoveryUsed: false,
    grabTarget: null, grabbedBy: null, grabTimer: 0, throwBounce: 0,
    hookedBy: null, hookTime: 0, waftCharge: 0,
    spinTime: 0, spinDir: 0, eggTime: 0,
    emoteTime: 0, emoteCooldown: 0,
    stun: 0, invuln: 2.3, respawn: 0, ready: false,
    kos: 0, falls: 0, flash: 0,
  };
}

// Low percentages add little launch speed; the curve steepens as damage grows.
// Weight reduces velocity. The server uses this for every hit.
export function knockback(attack, targetPercent, weight) {
  const damageScale = Math.max(0, targetPercent) / 100;
  const speed = (attack.base + attack.growth * damageScale ** 1.45) / weight;
  return Math.min(speed, 1750);
}

// Lean launches upward so players get an arc and a chance to steer back.
export function launchBrawlVelocity(speed, angle, direction) {
  const radians = angle * Math.PI / 180;
  return {
    vx: direction * Math.min(620, Math.cos(radians) * speed * 0.78),
    vy: -Math.min(1350, Math.sin(radians) * speed),
  };
}

export function waftBrawlAttack(charge) {
  const power = Math.max(0, Math.min(1, charge));
  return { radius: 50 + power * 48, damage: Math.round(5 + 16 * power),
    base: 130 + 170 * power, growth: 400 + 230 * power, angle: 78,
    lift: 180 + power * 520 };
}

// Higher damage makes Yoshi's egg harder to escape, but never traps indefinitely.
export function eggLayDuration(percent) {
  return Math.min(EGG_LAY.maxDuration,
    EGG_LAY.baseDuration + Math.max(0, percent) * EGG_LAY.durationPerPercent);
}

export function isBrawlRollInvulnerable(p) {
  const elapsed = BRAWL_ROLL.duration - (p.rollTime || 0);
  return p.rollTime > 0 && elapsed >= BRAWL_ROLL.invulnStart && elapsed < BRAWL_ROLL.invulnEnd;
}

export function throwBrawlVelocity(character, percent, face, rawX = 0, rawY = 0) {
  let dirX = rawX < 0 ? -1 : rawX > 0 ? 1 : 0;
  const dirY = rawY < 0 ? -1 : rawY > 0 ? 1 : 0;
  if (!dirX && !dirY) dirX = face;
  const length = Math.hypot(dirX, dirY);
  const speed = knockback(ATTACKS.grab, percent, FIGHTERS[character].weight);
  return {
    dirX, dirY, speed,
    vx: dirX / length * Math.min(620, speed * (dirY === 0 ? 0.58 : 0.78)),
    vy: dirY > 0 ? Math.max(310, dirY / length * speed)
      : dirY < 0 ? -Math.min(1350, speed / length)
        : -Math.min(1080, speed * 0.58),
    bounce: dirY > 0 ? Math.max(250, speed * 0.8) : 0,
  };
}

export function resetFighter(p, slot = p.slot) {
  p.slot = slot;
  p.x = SPAWNS[slot % SPAWNS.length]; p.y = 370;
  p.vx = 0; p.vy = 0; p.face = slot % 2 ? -1 : 1;
  p.percent = 0; p.stocks = BRAWL.stocks;
  p.grounded = false; p.jumps = 0; p.coyote = 0; p.drop = 0;
  p.attack = null; p.attackTime = 0; p.attackHit = false;
  p.shield = 100; p.shielding = false; p.shieldBreak = 0; p.shieldRegenDelay = 0;
  p.rollTime = 0; p.rollCooldown = 0; p.rollDir = 0; p.rollInput = 0;
  p.recoveryUsed = false;
  p.grabTarget = null; p.grabbedBy = null; p.grabTimer = 0; p.throwBounce = 0;
  p.hookedBy = null; p.hookTime = 0; p.waftCharge = 0;
  p.spinTime = 0; p.spinDir = 0; p.eggTime = 0;
  p.emoteTime = 0; p.emoteCooldown = 0;
  p.stun = 0; p.invuln = 0; p.respawn = 0; p.kos = 0; p.falls = 0; p.flash = 0;
}

export function isOut(p) {
  const b = BRAWL.blast;
  return p.x < b.left || p.x > b.right || p.y < b.top || p.y > b.bottom;
}

// Run the same movement rules in the authoritative room and the local client.
// Combat, damage, stocks and respawns remain server-owned.
export function jumpBrawlFighter(p, down = false) {
  if (p.stocks <= 0 || p.respawn > 0 || p.stun > 0.12 || p.shielding || p.rollTime > 0 || p.grabTarget || p.grabbedBy || p.attack === 'upair') return null;
  if (down && p.grounded && p.groundIndex > 0) {
    p.grounded = false; p.drop = 0.23; p.y += 5; p.vy = 75;
    return 'drop';
  }
  const grounded = p.grounded || p.coyote > 0;
  if (!grounded && p.jumps >= 2) return null;
  const stats = FIGHTERS[p.character];
  p.vy = -stats.jump * (grounded ? 1 : 0.84);
  p.grounded = false; p.coyote = 0; p.jumps = grounded ? 1 : 2;
  return grounded ? 'jump' : 'doublejump';
}

export function recoverBrawlFighter(p, move = 0) {
  if (p.stocks <= 0 || p.respawn > 0 || p.stun > 0 || p.shielding || p.rollTime > 0 || p.grabTarget || p.grabbedBy || p.recoveryUsed || p.attack) return false;
  const stats = FIGHTERS[p.character];
  p.recoveryUsed = true;
  p.grounded = false; p.coyote = 0; p.drop = 0;
  p.vy = -stats.recovery;
  if (move) p.vx = move * stats.recoveryDrift;
  return true;
}

export function stepBrawlMovement(p, move, dt, shieldInput = false) {
  p.stun = Math.max(0, p.stun - dt);
  p.drop = Math.max(0, p.drop - dt);
  p.coyote = Math.max(0, p.coyote - dt);
  p.rollCooldown = Math.max(0, (p.rollCooldown || 0) - dt);
  const wasRolling = p.rollTime > 0;
  p.rollTime = Math.max(0, (p.rollTime || 0) - dt);
  if (wasRolling && !p.rollTime) p.vx = 0;
  const chord = shieldInput && move ? move : 0;
  const rollEdge = chord && p.rollInput !== chord;
  p.rollInput = chord;
  if (rollEdge && !p.rollTime && !p.rollCooldown && p.grounded && p.shield > BRAWL_ROLL.shieldCost &&
      p.shieldBreak <= 0 && p.stun <= 0 && !p.attack && !p.grabTarget && !p.grabbedBy &&
      p.stocks > 0 && p.respawn <= 0) {
    p.rollTime = BRAWL_ROLL.duration;
    p.rollCooldown = BRAWL_ROLL.cooldown;
    p.rollDir = move;
    p.face = move;
    p.shielding = false;
    p.shield -= BRAWL_ROLL.shieldCost;
    p.shieldRegenDelay = Math.max(p.shieldRegenDelay, 0.55);
  }
  const stats = FIGHTERS[p.character];
  if (p.rollTime > 0) p.vx = p.rollDir * BRAWL_ROLL.speed;
  else if (p.stun <= 0) {
    const walking = shieldInput || p.shielding ? 0 : move;
    if (walking) {
      p.face = walking;
      const target = walking * stats.speed;
      const change = (p.grounded ? 3400 : 1650 * stats.air) * dt;
      p.vx = p.vx < target ? Math.min(p.vx + change, target) : Math.max(p.vx - change, target);
    } else if (p.grounded) p.vx *= 0.76;
    else p.vx *= 0.993;
  } else p.vx *= 0.994;

  const previousY = p.y;
  p.x += p.vx * dt;
  p.vy = Math.min(1450, p.vy + 1550 * dt);
  p.y += p.vy * dt;
  let landed = false;
  if (p.vy >= 0 && p.drop <= 0) {
    for (let i = 0; i < BRAWL.platforms.length; i++) {
      const platform = BRAWL.platforms[i];
      if (previousY <= platform.y + 3 && p.y >= platform.y &&
          p.x + 17 > platform.x && p.x - 17 < platform.x + platform.w) {
        p.y = platform.y; p.vy = 0; landed = true; p.groundIndex = i;
        break;
      }
    }
  }
  if (landed) {
    p.grounded = true; p.jumps = 0; p.coyote = 0;
    p.recoveryUsed = false;
    if (p.throwBounce > 0) {
      p.vy = -p.throwBounce;
      p.grounded = false;
      p.throwBounce = 0;
    }
  } else if (p.grounded) {
    p.grounded = false; p.coyote = 0.095;
  }
  return landed && previousY < p.y - 4;
}
