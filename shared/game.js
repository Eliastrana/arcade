// Deterministic simulation. Pure, no I/O, no randomness.
// Server runs it for authority; client runs the identical code to predict.
import {
  DT, ARENA_HALF, WALL_HEIGHT, PLAYER_RADIUS, PLAYER_SPEED, ACCEL_RATE, AIR_RATE,
  BODY_CENTER, BODY_RADIUS, HEAD_CENTER, HEAD_RADIUS, MAX_HP, PITCH_MIN, PITCH_MAX,
  PLAYER_EYE, ADS_CAMERA_BACK, ADS_CAMERA_RIGHT, ADS_CAMERA_UP, AIM_CONVERGENCE, DEFAULT_WEAPON,
  GRAVITY, JUMP_SPEED, SPRINT_MULT, ADS_MULT, SNEAK_MULT, ROLL_SPEED, ROLL_TIME, ROLL_CD,
  ROLL_LAND_BUFFER, ROLL_LAND_GRACE,
  LADDER_SPEED, FALL_SAFE_SPEED, FALL_DAMAGE_SCALE, OBSTACLES, RAMPS, LADDERS,
} from './constants.js';

export function makePlayer(id, name, color) {
  return {
    id, name, color,
    x: 0, z: 0, vx: 0, vz: 0,
    y: 0, vy: 0, onGround: true, climbing: false, ladder: -1,
    rollT: 0, rollCd: 0, rollX: 0, rollZ: 0, rollKind: 0,
    rollBuffer: 0, rollBufferKind: 0, rollBufferYaw: 0,
    pendingFallDamage: 0, pendingFallSpeed: 0, fallGrace: 0,
    yaw: 0, pitch: 0, weapon: DEFAULT_WEAPON,
    team: null, character: 'soldier',
    hp: MAX_HP, alive: true,
    kills: 0, deaths: 0,
    respawnAt: 0, lastShot: 0, nextShotAt: 0, shotSeq: 0, lastSeq: 0,
  };
}

/** Direction the player is looking. yaw=0 faces -Z, matching three.js defaults. */
export function lookDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/**
 * World-space ray through the exact centre of the fully-scoped camera.
 * Shared with the server so close-range ADS parallax cannot move a shot away
 * from what is visibly underneath the reticle.
 */
export function adsCameraRay(x, y, z, yaw, pitch) {
  const forward=lookDir(yaw,pitch);
  const rightLen=Math.hypot(forward.x,forward.z)||1;
  const right={x:-forward.z/rightLen,y:0,z:forward.x/rightLen};
  const eye={x,y:(y||0)+PLAYER_EYE,z};
  const desired={
    x:eye.x-forward.x*ADS_CAMERA_BACK+right.x*ADS_CAMERA_RIGHT,
    y:eye.y-forward.y*ADS_CAMERA_BACK+ADS_CAMERA_UP,
    z:eye.z-forward.z*ADS_CAMERA_BACK+right.z*ADS_CAMERA_RIGHT,
  };
  const origin=clipCameraPosition(eye,desired);
  const target={
    x:eye.x+forward.x*AIM_CONVERGENCE,
    y:eye.y+forward.y*AIM_CONVERGENCE,
    z:eye.z+forward.z*AIM_CONVERGENCE,
  };
  const dx=target.x-origin.x,dy=target.y-origin.y,dz=target.z-origin.z;
  const len=Math.hypot(dx,dy,dz)||1;
  return {origin,dir:{x:dx/len,y:dy/len,z:dz/len}};
}

/**
 * Advance one player by one tick.
 * Movement is CAMERA-RELATIVE: W goes where you're looking, so the server
 * needs the yaw the client had when it pressed the key. That's why yaw
 * travels inside the input packet rather than being stored separately.
 */
/** Camera-relative unit direction for a (forward, right) intent. */
export function moveDir(yaw, fwd, rgt) {
  const len = Math.hypot(fwd, rgt);
  if (len === 0) return { x: 0, z: 0 };
  const s = Math.sin(yaw), c = Math.cos(yaw);
  // forward = (-sin, -cos), right = (cos, -sin)
  return { x: (-s * fwd + c * rgt) / len, z: (-c * fwd - s * rgt) / len };
}

// roll kinds, as sent by the client on a double-tap
const ROLL_VECTORS = { 1: [1, 0], 2: [-1, 0], 3: [0, -1], 4: [0, 1] };

function beginRoll(p,kind,yaw) {
  const v=ROLL_VECTORS[kind];
  if (!v||p.rollCd>0) return false;
  const rd=moveDir(yaw||0,v[0],v[1]);
  p.rollX=rd.x; p.rollZ=rd.z; p.rollT=ROLL_TIME; p.rollCd=ROLL_CD+ROLL_TIME;
  p.rollKind=kind; p.vx=rd.x*ROLL_SPEED; p.vz=rd.z*ROLL_SPEED;
  p.rollBuffer=0; p.rollBufferKind=0;
  return true;
}

function cancelFallDamage(p) {
  const prevented=p.pendingFallDamage>0;
  p.pendingFallDamage=0; p.pendingFallSpeed=0; p.fallGrace=0;
  return prevented;
}

function tickFallGrace(p,dt) {
  if (p.pendingFallDamage<=0) return {damage:0,speed:0};
  p.fallGrace=Math.max(0,p.fallGrace-dt);
  if (p.fallGrace>0) return {damage:0,speed:0};
  const released={damage:p.pendingFallDamage,speed:p.pendingFallSpeed||0};
  p.pendingFallDamage=0; p.pendingFallSpeed=0;
  return released;
}

export function rampHeightAt(r, x, z) {
  let along;
  if (r.axis === 'x') {
    if (Math.abs(z - r.z) > r.width / 2 || Math.abs(x - r.x) > r.length / 2) return -1;
    along = r.dir > 0 ? x - (r.x - r.length/2) : (r.x + r.length/2) - x;
  } else {
    if (Math.abs(x - r.x) > r.width / 2 || Math.abs(z - r.z) > r.length / 2) return -1;
    along = r.dir > 0 ? z - (r.z - r.length/2) : (r.z + r.length/2) - z;
  }
  return Math.max(0, Math.min(r.height, along / r.length * r.height));
}

export function groundHeightAt(x, z) {
  let h = 0;
  for (const r of RAMPS) h = Math.max(h, rampHeightAt(r, x, z));
  // Crates and house roofs are real walkable surfaces. Horizontal collision
  // still prevents entering them from below; once the feet clear the top,
  // landing and walking use this shared height on client and server.
  for (const o of OBSTACLES) {
    if (o.kind!=='crate'&&o.kind!=='house') continue;
    if (Math.abs(x-o.x)<=o.w/2&&Math.abs(z-o.z)<=o.d/2) h=Math.max(h,o.h);
  }
  return h;
}

/** Resolve the player's circular footprint against all solid boxes. */
function collideBoxes(p,prevY=p.y) {
  for (const o of OBSTACLES) {
    // Once the player's feet clear the top, the obstacle can be jumped over.
    const landingOnTop=(o.kind==='crate'||o.kind==='house')&&p.vy<=0&&prevY>=o.h-.12;
    if (p.y > o.h - 0.12||landingOnTop) continue;
    const minX=o.x-o.w/2, maxX=o.x+o.w/2, minZ=o.z-o.d/2, maxZ=o.z+o.d/2;
    const cx=Math.max(minX,Math.min(maxX,p.x)), cz=Math.max(minZ,Math.min(maxZ,p.z));
    const dx=p.x-cx, dz=p.z-cz, d2=dx*dx+dz*dz;
    if (d2 >= PLAYER_RADIUS*PLAYER_RADIUS) continue;
    if (d2 > 1e-8) {
      const d=Math.sqrt(d2), push=(PLAYER_RADIUS-d)/d;
      p.x += dx*push; p.z += dz*push;
      const vn=p.vx*dx/d+p.vz*dz/d;
      if (vn < 0) { p.vx -= vn*dx/d; p.vz -= vn*dz/d; }
    } else {
      // Centre is inside the box: exit through the nearest expanded face.
      const sides=[
        { d:Math.abs(p.x-(minX-PLAYER_RADIUS)), x:minX-PLAYER_RADIUS, axis:'x' },
        { d:Math.abs(p.x-(maxX+PLAYER_RADIUS)), x:maxX+PLAYER_RADIUS, axis:'x' },
        { d:Math.abs(p.z-(minZ-PLAYER_RADIUS)), z:minZ-PLAYER_RADIUS, axis:'z' },
        { d:Math.abs(p.z-(maxZ+PLAYER_RADIUS)), z:maxZ+PLAYER_RADIUS, axis:'z' },
      ].sort((a,b)=>a.d-b.d)[0];
      if (sides.axis === 'x') { p.x=sides.x; p.vx=0; }
      else { p.z=sides.z; p.vz=0; }
    }
  }
}

function ladderContact(p,input) {
  if (p.climbing&&LADDERS[p.ladder]) return {ladder:LADDERS[p.ladder],index:p.ladder};
  if (!input.up&&!input.down) return null;
  for (let i=0;i<LADDERS.length;i++) {
    const l=LADDERS[i],dx=p.x-l.x,dz=p.z-l.z;
    const along=dx*(-l.nz)+dz*l.nx;
    const away=dx*l.nx+dz*l.nz;
    const beside=Math.abs(along)<=l.width/2+.18&&away>=.18&&away<=PLAYER_RADIUS+.48;
    const roofEntry=input.down&&p.y>=l.height-.45&&away>=-(PLAYER_RADIUS+.38)&&away<=PLAYER_RADIUS+.48;
    if ((beside||roofEntry)&&p.y>=-.05&&p.y<=l.height+.38) return {ladder:l,index:i};
  }
  return null;
}

/** Deterministic ladder movement; returns true when it consumed this tick. */
function stepLadder(p,input,dt) {
  const contact=ladderContact(p,input);
  if (!contact) { p.climbing=false; p.ladder=-1; return false; }
  const {ladder:l,index}=contact;

  if (input.jump) {
    p.climbing=false; p.ladder=-1; p.onGround=false;
    p.vx=l.nx*PLAYER_SPEED*.75; p.vz=l.nz*PLAYER_SPEED*.75; p.vy=JUMP_SPEED*.72;
    return false;
  }

  p.climbing=true; p.ladder=index; p.onGround=false; p.rollT=0;
  p.vx=0; p.vz=0;
  const standOff=PLAYER_RADIUS+.08;
  const targetX=l.x+l.nx*standOff,targetZ=l.z+l.nz*standOff;
  const magnet=1-Math.exp(-22*dt);
  p.x+=(targetX-p.x)*magnet; p.z+=(targetZ-p.z)*magnet;

  const climb=(input.up?1:0)-(input.down?1:0);
  p.vy=climb*LADDER_SPEED;
  p.y=Math.max(0,Math.min(l.height,p.y+p.vy*dt));

  if (climb>0&&p.y>=l.height-.02) {
    // Step over the lip onto the roof, just inside the wall face.
    p.x=l.x-l.nx*(PLAYER_RADIUS+.12);
    p.z=l.z-l.nz*(PLAYER_RADIUS+.12);
    p.y=l.height; p.vy=0; p.onGround=true; p.climbing=false; p.ladder=-1;
  } else if (climb<0&&p.y<=.001) {
    p.y=0; p.vy=0; p.onGround=true; p.climbing=false; p.ladder=-1;
  }
  return true;
}

export function step(p, input, dt = DT) {
  const prevX=p.x, prevZ=p.z, prevY=p.y;
  const wasGrounded=p.onGround;
  let fallDamagePrevented=false;
  if (p.rollCd>0) p.rollCd=Math.max(0,p.rollCd-dt);
  if (p.rollBuffer>0) p.rollBuffer=Math.max(0,p.rollBuffer-dt);
  if (input.roll&&!p.onGround) {
    p.rollBuffer=ROLL_LAND_BUFFER; p.rollBufferKind=input.roll; p.rollBufferYaw=input.yaw||0;
  }
  // A slightly late roll gets first refusal on damage waiting in the landing
  // grace window. Starting the actual roll remains subject to its cooldown.
  if (input.roll&&p.onGround&&p.rollT<=0&&beginRoll(p,input.roll,input.yaw||0))
    fallDamagePrevented=cancelFallDamage(p);

  if (p.rollT<=0&&stepLadder(p,input,dt)) {
    const released=tickFallGrace(p,dt);
    return {fallDamage:released.damage,landedSpeed:released.speed,fallDamagePrevented};
  }
  const fwd = (input.up ? 1 : 0) - (input.down ? 1 : 0);
  const rgt = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const d = moveDir(input.yaw || 0, fwd, rgt);
  let dx = d.x, dz = d.z;

  // A roll overrides normal steering for its duration - committed movement,
  // which is what makes it a dodge rather than a speed boost.
  if (p.rollT > 0) {
    p.rollT = Math.max(0, p.rollT - dt);
    p.vx = p.rollX * ROLL_SPEED;
    p.vz = p.rollZ * ROLL_SPEED;
  }
  const rolling = p.rollT > 0;

  // Sneaking wins over sprinting: you cannot creep and charge at once.
  // p.sneaking is the authoritative flag - every client reads it off the
  // snapshot to decide whether to play that player's footsteps.
  const sneaking = !!input.sneak && p.onGround && !rolling;
  p.sneaking = sneaking;

  // Sprint only applies on the ground and only going forwards - you can't
  // sprint sideways, backwards, while scoped, or while sneaking.
  const sprinting = input.sprint && !sneaking && p.onGround && fwd > 0 && !input.ads;
  const topSpeed = PLAYER_SPEED * (
    sneaking ? SNEAK_MULT : sprinting ? SPRINT_MULT : input.ads ? ADS_MULT : 1);

  // Ease toward the desired velocity. Exponential so it's framerate-independent,
  // and much slower in the air so a sprint-jump keeps its momentum.
  if (!rolling) {
    const rate = 1 - Math.exp(-(p.onGround ? ACCEL_RATE : AIR_RATE) * dt);
    p.vx += (dx * topSpeed - p.vx) * rate;
    p.vz += (dz * topSpeed - p.vz) * rate;
  }

  // Vertical motion is integrated before horizontal motion; after moving we
  // sample the shared ramp height and either follow its slope or fall away.
  if (input.jump && p.onGround) { p.vy = JUMP_SPEED; p.onGround = false; }
  p.vy -= GRAVITY * dt;
  p.y  += p.vy * dt;

  p.x += p.vx * dt;
  p.z += p.vz * dt;

  const lim = ARENA_HALF - PLAYER_RADIUS;
  if (p.x < -lim) { p.x = -lim; p.vx = 0; }
  if (p.x >  lim) { p.x =  lim; p.vx = 0; }
  if (p.z < -lim) { p.z = -lim; p.vz = 0; }
  if (p.z >  lim) { p.z =  lim; p.vz = 0; }

  collideBoxes(p,prevY);

  let ground = groundHeightAt(p.x, p.z);
  // A ramp's tall edge is a wall unless the player is already high enough.
  // Rolling/walking up the slope advances by far less than this per tick.
  if (ground > p.y + 0.32 && ground - prevY > 0.42) {
    p.x=prevX; p.z=prevZ; p.vx=0; p.vz=0;
    ground=groundHeightAt(p.x,p.z);
  }
  let fallDamage=0,landedSpeed=0,newPending=false;
  if (p.y <= ground || (wasGrounded && p.vy <= 0 && p.y-ground < 0.38)) {
    landedSpeed=wasGrounded?0:Math.max(0,-p.vy);
    if (landedSpeed>FALL_SAFE_SPEED) {
      p.pendingFallDamage=Math.min(MAX_HP,Math.round((landedSpeed-FALL_SAFE_SPEED)*FALL_DAMAGE_SCALE));
      p.pendingFallSpeed=landedSpeed;
      p.fallGrace=ROLL_LAND_GRACE; newPending=true;
    }
    p.y=ground; p.vy=0; p.onGround=true;

    // A buffered roll just before impact, or a roll already crossing the lip,
    // converts the landing into a safe tumble immediately.
    if (p.pendingFallDamage>0&&p.rollT>0) fallDamagePrevented=cancelFallDamage(p)||fallDamagePrevented;
    else if (p.pendingFallDamage>0&&p.rollBuffer>0&&p.rollCd<=0&&
            beginRoll(p,p.rollBufferKind,p.rollBufferYaw))
      fallDamagePrevented=cancelFallDamage(p)||fallDamagePrevented;
  } else {
    p.onGround=false;
  }
  if (!newPending&&p.pendingFallDamage>0) {
    const released=tickFallGrace(p,dt);
    fallDamage=released.damage;
    if (released.speed>0) landedSpeed=released.speed;
  }
  return {fallDamage,landedSpeed,fallDamagePrevented};
}

function raySphereT(origin,dir,cx,cy,cz,radius,limit) {
  const ox=origin.x-cx, oy=origin.y-cy, oz=origin.z-cz;
  const b=ox*dir.x+oy*dir.y+oz*dir.z;
  const c=ox*ox+oy*oy+oz*oz-radius*radius;
  const disc=b*b-c;
  if (disc<0) return null;
  const sq=Math.sqrt(disc);
  let t=-b-sq; if (t<0) t=-b+sq;
  return t>=0 && t<limit ? t : null;
}

/**
 * Hitscan against separate body and head volumes. Returns the nearest
 * { player, t, headshot } or null. Hit zones ride with jumps and ramps.
 */
export function raycast(origin, dir, candidates, range) {
  let best = null, bestT = range;
  for (const p of candidates) {
    if (!p.alive) continue;
    const y=p.y||0;
    const bodyT=raySphereT(origin,dir,p.x,y+BODY_CENTER,p.z,BODY_RADIUS,bestT);
    const headT=raySphereT(origin,dir,p.x,y+HEAD_CENTER,p.z,HEAD_RADIUS,bestT);
    // The body and head volumes overlap slightly around the neck. Prefer the
    // head whenever this ray intersects both volumes for the same player;
    // otherwise the larger body sphere can sit a few millimetres nearer the
    // shooter and incorrectly turn a visually clean face shot into body damage.
    let t=null, headshot=false;
    if (headT!==null) { t=headT; headshot=true; }
    else if (bodyT!==null) t=bodyT;
    if (t===null || t>=bestT) continue;
    bestT=t; best={player:p,t,headshot};
  }
  return best;
}

function rayBox(origin, dir, min, max, range) {
  let lo=0, hi=range;
  for (const k of ['x','y','z']) {
    const o=origin[k], d=dir[k];
    if (Math.abs(d) < 1e-8) { if (o < min[k] || o > max[k]) return null; continue; }
    let a=(min[k]-o)/d, b=(max[k]-o)/d;
    if (a>b) [a,b]=[b,a];
    lo=Math.max(lo,a); hi=Math.min(hi,b);
    if (lo>hi) return null;
  }
  return lo >= 0 && lo <= range ? lo : null;
}

/** Distance to the first solid piece of arena geometry along a shot ray. */
export function raycastWorld(origin, dir, range) {
  let best=range;
  for (const o of OBSTACLES) {
    const t=rayBox(origin,dir,
      {x:o.x-o.w/2,y:0,z:o.z-o.d/2},
      {x:o.x+o.w/2,y:o.h,z:o.z+o.d/2}, best);
    if (t !== null) best=t;
  }
  // The rendered arena boundary is four one-unit-thick boxes. Including it
  // here keeps bullet endpoints and third-person camera collision aligned with
  // what players actually see.
  for (const [min,max] of [
    [{x:-ARENA_HALF-.5,y:0,z:-ARENA_HALF-.5},{x:-ARENA_HALF+.5,y:WALL_HEIGHT,z:ARENA_HALF+.5}],
    [{x: ARENA_HALF-.5,y:0,z:-ARENA_HALF-.5},{x: ARENA_HALF+.5,y:WALL_HEIGHT,z:ARENA_HALF+.5}],
    [{x:-ARENA_HALF-.5,y:0,z:-ARENA_HALF-.5},{x: ARENA_HALF+.5,y:WALL_HEIGHT,z:-ARENA_HALF+.5}],
    [{x:-ARENA_HALF-.5,y:0,z: ARENA_HALF-.5},{x: ARENA_HALF+.5,y:WALL_HEIGHT,z: ARENA_HALF+.5}],
  ]) {
    const t=rayBox(origin,dir,min,max,best);
    if (t!==null) best=t;
  }
  // Ramps are wedges, not boxes. A short deterministic march avoids invisible
  // bullet-blocking volume over the low end while remaining cheap per shot.
  for (let t=.05; t<best; t+=.075) {
    const x=origin.x+dir.x*t, y=origin.y+dir.y*t, z=origin.z+dir.z*t;
    if (y < 0) return t;
    for (const r of RAMPS) {
      const h=rampHeightAt(r,x,z);
      if (h >= 0 && y <= h) { best=t; break; }
    }
  }
  return best;
}

/** Pull a third-person camera toward the eye before it enters solid geometry. */
export function clipCameraPosition(eye,desired,padding=.18) {
  const dx=desired.x-eye.x,dy=desired.y-eye.y,dz=desired.z-eye.z;
  const distance=Math.hypot(dx,dy,dz);
  if (distance<1e-6) return {...eye};
  const dir={x:dx/distance,y:dy/distance,z:dz/distance};
  const hit=raycastWorld(eye,dir,distance);
  const safe=hit<distance?Math.max(.12,hit-padding):distance;
  return {x:eye.x+dir.x*safe,y:eye.y+dir.y*safe,z:eye.z+dir.z*safe};
}

export function sanitizeInput(raw) {
  const num = (v, lo, hi) =>
    (typeof v === 'number' && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : 0;
  return {
    up:    !!(raw && raw.up),
    down:  !!(raw && raw.down),
    left:  !!(raw && raw.left),
    right: !!(raw && raw.right),
    yaw:   num(raw && raw.yaw, -Math.PI * 4, Math.PI * 4),
    pitch: num(raw && raw.pitch, PITCH_MIN, PITCH_MAX),
    ads:   !!(raw && raw.ads),
    jump:   !!(raw && raw.jump),
    sprint: !!(raw && raw.sprint),
    sneak:  !!(raw && raw.sneak),
    roll:   (raw && [1,2,3,4].includes(raw.roll)) ? raw.roll : 0,
    weapon: (raw && [1,2].includes(raw.weapon)) ? raw.weapon : DEFAULT_WEAPON,
  };
}

/**
 * Perturb an aim direction within a cone of `maxAngle` radians.
 * sqrt(random) keeps the distribution uniform over the disc rather than
 * clustering shots in the middle.
 */
export function coneSpread(dir, maxAngle, rand = Math.random) {
  if (maxAngle <= 0) return dir;
  const up = Math.abs(dir.y) < 0.9 ? { x:0, y:1, z:0 } : { x:1, y:0, z:0 };
  let tx = up.y*dir.z - up.z*dir.y,
      ty = up.z*dir.x - up.x*dir.z,
      tz = up.x*dir.y - up.y*dir.x;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = dir.y*tz - dir.z*ty,
        by = dir.z*tx - dir.x*tz,
        bz = dir.x*ty - dir.y*tx;
  const ang = Math.sqrt(rand()) * maxAngle;
  const phi = rand() * Math.PI * 2;
  const s = Math.sin(ang), c = Math.cos(ang);
  const ox = Math.cos(phi), oy = Math.sin(phi);
  return {
    x: dir.x*c + (tx*ox + bx*oy)*s,
    y: dir.y*c + (ty*ox + by*oy)*s,
    z: dir.z*c + (tz*ox + bz*oy)*s,
  };
}
