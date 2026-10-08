// Transport + authority. Owns the only real copy of the world.
// Clients send intent ("keys down", "I fired"). They never send positions,
// and they never decide whether they hit anyone.
import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBrawlRoom } from './brawl.js';

import { makePlayer, step, sanitizeInput, raycast, raycastWorld, lookDir, coneSpread, adsCameraRay } from '../shared/game.js';
import {
  TICK_HZ, ARENA_HALF, MAX_INPUT_QUEUE, PLAYER_EYE, MAX_SPEED,
  MAX_HP, RESPAWN_MS, SPREAD_MOVE, SPREAD_AIR,
  TEAM_COLORS, WEAPONS, DEFAULT_WEAPON,
} from '../shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.PORT) || 3001;

// ---------------------------------------------------------------- static
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.png':'image/png', '.webp':'image/webp', '.glb':'model/gltf-binary' };
const ROUTES = {
  '/':                       path.join(ROOT, 'public/brawl.html'),
  '/arena':                  path.join(ROOT, 'public/arena.html'),
  '/arena/':                 path.join(ROOT, 'public/arena.html'),
  '/skyhook':                path.join(ROOT, 'public/skyhook.html'),
  '/skyhook/':               path.join(ROOT, 'public/skyhook.html'),
  '/brawl':                  path.join(ROOT, 'public/brawl.html'),
  '/brawl/':                 path.join(ROOT, 'public/brawl.html'),
  '/vendor/three.module.js': path.join(ROOT, 'node_modules/three/build/three.module.js'),
};
function resolve(urlPath) {
  if (ROUTES[urlPath]) return ROUTES[urlPath];
  const clean = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  // /vendor/jsm/* -> three.js addon modules (GLTFLoader, SkeletonUtils, ...)
  const f = clean.startsWith('/vendor/jsm/')
    ? path.join(ROOT, 'node_modules/three/examples/jsm', clean.slice('/vendor/jsm/'.length))
    : clean.startsWith('/shared/') ? path.join(ROOT, clean)
    : path.join(ROOT, 'public', clean);
  const allowed = [path.join(ROOT, 'shared'), path.join(ROOT, 'public'),
                   path.join(ROOT, 'node_modules/three/examples/jsm')];
  if (!allowed.some(a => f.startsWith(a))) return null;
  return (fs.existsSync(f) && fs.statSync(f).isFile()) ? f : null;
}
const server = http.createServer((req, res) => {
  const file = resolve(req.url.split('?')[0]);
  if (!file) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // no-cache so a plain refresh always picks up edits; the files are tiny
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(buf);
  });
});

// ---------------------------------------------------------------- world
const NAMES = ['Otter','Moose','Lynx','Puffin','Heron','Badger','Marten','Grouse','Raven','Stoat','Tern','Elk'];
const CHARACTERS = new Set(['soldier']);
const players = new Map();      // ws -> player
const inputs  = new Map();      // ws -> queued inputs
const skyPlayers = new Map();   // a separate live room for Skyhook Summit
const brawlRoom = createBrawlRoom();
let nextId = 1;
let nextSkyId = 1;
let fx = [];                    // tracers created this tick
let killfeed = [];              // kills this tick
let falls = [];                 // authoritative landing impacts this tick

const rand = (lim) => (Math.random() * 2 - 1) * lim;

function respawn(p) {
  // Fixed team courtyards: Red deploys west, Blue east, both facing mid.
  const side = p.team === 'red' ? -1 : 1;
  p.x = side * (ARENA_HALF - 3.5) + rand(.75);
  p.z = rand(1.8);
  p.yaw = p.team === 'red' ? -Math.PI/2 : Math.PI/2;
  p.vx = p.vz = 0;
  p.y = 0; p.vy = 0; p.onGround = true;
  p.climbing = false; p.ladder = -1;
  p.rollT = 0; p.rollCd = 0; p.rollKind = 0;
  p.rollBuffer = 0; p.rollBufferKind = 0; p.rollBufferYaw = 0;
  p.pendingFallDamage = 0; p.pendingFallSpeed = 0; p.fallGrace = 0;
  p.hp = MAX_HP; p.alive = true;
}

// ---------------------------------------------------------------- connections
const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', (ws, req) => {
  const game = new URL(req.url || '/', 'http://localhost').searchParams.get('game');
  if (game === 'brawl') { brawlRoom.join(ws); return; }
  if (game === 'skyhook') {
    const id = nextSkyId++;
    const colors = ['#ec5578','#70def0','#ffd16a','#9a7cff','#8ee08e','#ff995e'];
    const p = { id, name:`${NAMES[id % NAMES.length]} ${id}`, color:colors[id % colors.length],
      x:42,y:355,vx:0,vy:0,face:1,glide:false,flip:0,hook:null,checkpoint:0,finished:false,time:0 };
    skyPlayers.set(ws,p);
    ws.send(JSON.stringify({t:'sky-welcome',id,name:p.name,color:p.color}));
    ws.on('message',raw=>{
      let m;try{m=JSON.parse(raw);}catch{return;}
      if(m?.t==='sky-name'){
        const n=String(m.name||'').slice(0,14).replace(/[^\w \-]/g,'').trim();if(n)p.name=n;
      }else if(m?.t==='sky-state'){
        const finite=(v,fallback=0)=>Number.isFinite(v)?v:fallback;
        p.x=Math.max(0,Math.min(1640,finite(m.x,p.x)));p.y=Math.max(-50,Math.min(500,finite(m.y,p.y)));
        p.vx=Math.max(-400,Math.min(400,finite(m.vx)));p.vy=Math.max(-500,Math.min(500,finite(m.vy)));
        p.face=m.face<0?-1:1;p.glide=!!m.glide;p.flip=Math.max(0,Math.min(1,finite(m.flip)));p.checkpoint=Math.max(0,Math.min(3,m.checkpoint|0));
        p.finished=!!m.finished;p.time=Math.max(0,Math.min(36000,finite(m.time)));
        p.hook=m.hook&&Number.isFinite(m.hook.x)&&Number.isFinite(m.hook.y)
          ? {x:Math.max(0,Math.min(1640,m.hook.x)),y:Math.max(0,Math.min(440,m.hook.y)),pulling:!!m.hook.pulling}:null;
      }
    });
    const drop=()=>skyPlayers.delete(ws);ws.on('close',drop);ws.on('error',drop);
    return;
  }
  const id = nextId++;
  const p = makePlayer(id, `${NAMES[id % NAMES.length]} ${id}`, '#aab3b5');
  // Connected players spectate until they explicitly choose a side.
  p.alive = false; p.hp = 0;
  players.set(ws, p);
  inputs.set(ws, []);

  ws.send(JSON.stringify({ t:'welcome', id, name:p.name, color:p.color, tickHz:TICK_HZ, maxHp:MAX_HP }));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'i') {
      const q = inputs.get(ws);
      if (q.length >= MAX_INPUT_QUEUE) q.shift();
      const input = sanitizeInput(m);
      p.yaw = input.yaw; p.pitch = input.pitch;       // remembered for shooting
      p.weapon = input.weapon;
      p.ads = input.ads && !!WEAPONS[p.weapon]?.canAds; // shotgun cannot scope
      q.push({ seq: Number(m.seq) || 0, input });

    } else if (m.t === 'shoot') {
      // A shot carries the aim from the exact click frame. Without this, the
      // server can fire with a 30 Hz input packet that is one frame behind the
      // reticle during a quick adjustment.
      const shotInput=sanitizeInput({
        yaw:Number.isFinite(m.yaw)?m.yaw:p.yaw,
        pitch:Number.isFinite(m.pitch)?m.pitch:p.pitch,
        ads:typeof m.ads==='boolean'?m.ads:p.ads,
        weapon:[1,2].includes(m.weapon)?m.weapon:p.weapon,
      });
      p.yaw=shotInput.yaw; p.pitch=shotInput.pitch; p.weapon=shotInput.weapon;
      p.ads=shotInput.ads && !!WEAPONS[p.weapon]?.canAds;
      shoot(p);

    } else if (m.t === 'name') {
      const n = String(m.name || '').slice(0, 14).replace(/[^\w \-]/g, '').trim();
      if (n) p.name = n;

    } else if (m.t === 'character' && !p.team) {
      if (CHARACTERS.has(m.character)) p.character = m.character;

    } else if (m.t === 'team' && !p.team) {
      const team = m.team === 'red' || m.team === 'blue' ? m.team : null;
      if (team) {
        p.team = team;
        p.color = TEAM_COLORS[team];
        respawn(p);
      }
    }
  });

  const drop = () => { players.delete(ws); inputs.delete(ws); };
  ws.on('close', drop);
  ws.on('error', drop);
});

/** Exact world direction through the scope centre, converted to an eye ray. */
function scopedAimDir(p,origin,others,range) {
  const camera=adsCameraRay(p.x,p.y||0,p.z,p.yaw,p.pitch);
  const toEye={x:origin.x-camera.origin.x,y:origin.y-camera.origin.y,z:origin.z-camera.origin.z};
  const skip=Math.max(0,toEye.x*camera.dir.x+toEye.y*camera.dir.y+toEye.z*camera.dir.z)+.02;
  const cameraStart={
    x:camera.origin.x+camera.dir.x*skip,
    y:camera.origin.y+camera.dir.y*skip,
    z:camera.origin.z+camera.dir.z*skip,
  };
  const cameraWorld=raycastWorld(cameraStart,camera.dir,range);
  const cameraHit=raycast(cameraStart,camera.dir,others,cameraWorld);
  const cameraDist=cameraHit?cameraHit.t:cameraWorld;
  const aimPoint={
    x:cameraStart.x+camera.dir.x*cameraDist,
    y:cameraStart.y+camera.dir.y*cameraDist,
    z:cameraStart.z+camera.dir.z*cameraDist,
  };
  const dx=aimPoint.x-origin.x,dy=aimPoint.y-origin.y,dz=aimPoint.z-origin.z;
  const len=Math.hypot(dx,dy,dz)||1;
  return {x:dx/len,y:dy/len,z:dz/len};
}

/** Server decides weapon, cadence, pellet spread, cover and damage. */
function shoot(p) {
  const now=Date.now(),weapon=WEAPONS[p.weapon]||WEAPONS[DEFAULT_WEAPON];
  if (!p.team || !p.alive || now < (p.nextShotAt||0)) return;
  p.lastShot=now; p.nextShotAt=now+weapon.cooldown;
  p.shotSeq=(p.shotSeq||0)+1;

  const origin={x:p.x,y:PLAYER_EYE+(p.y||0),z:p.z};
  const others=[...players.values()].filter(o=>o.id!==p.id&&o.team&&o.team!==p.team);
  let aimDir=lookDir(p.yaw,p.pitch);
  if (p.ads) aimDir=scopedAimDir(p,origin,others,weapon.range);

  let spread=p.ads?weapon.spreadAds:weapon.spreadHip;
  if (!p.ads) {
    spread+=SPREAD_MOVE*Math.min(1,Math.hypot(p.vx,p.vz)/MAX_SPEED);
    if (!p.onGround) spread+=SPREAD_AIR;
  }

  const pellets=[],damage=new Map();
  for (let i=0;i<weapon.pellets;i++) {
    const dir=coneSpread(aimDir,spread);
    const worldDist=raycastWorld(origin,dir,weapon.range);
    const hit=raycast(origin,dir,others,worldDist);
    const dist=hit?hit.t:worldDist;
    pellets.push({dir,dist,hit});
    if (hit) {
      const prior=damage.get(hit.player)||{player:hit.player,amount:0,headshots:0};
      prior.amount+=hit.headshot?weapon.headDamage:weapon.damage;
      if (hit.headshot) prior.headshots++;
      damage.set(hit.player,prior);
    }
  }

  const anyHit=pellets.some(r=>!!r.hit),anyHead=pellets.some(r=>!!r.hit?.headshot);
  for (let i=0;i<pellets.length;i++) {
    const {dir,dist,hit}=pellets[i];
    fx.push({
      ax:+origin.x.toFixed(2),ay:+origin.y.toFixed(2),az:+origin.z.toFixed(2),
      bx:+(origin.x+dir.x*dist).toFixed(2),by:+(origin.y+dir.y*dist).toFixed(2),bz:+(origin.z+dir.z*dist).toFixed(2),
      c:p.color,h:!!hit,hs:!!hit?.headshot,wh:anyHit,whs:anyHead,first:i===0,
      ad:!!p.ads,p:p.id,q:p.shotSeq,w:weapon.id,
    });
  }

  for (const {player:v,amount,headshots} of damage.values()) {
    v.hp-=amount;
    if (v.hp<=0) {
      v.hp=0; v.alive=false; v.deaths++; v.respawnAt=now+RESPAWN_MS;
      p.kills++;
      killfeed.push({k:p.name,v:v.name,kc:p.color,vc:v.color,hs:headshots>0,w:weapon.id});
    }
  }
}

function movementStep(p,input,now) {
  const result=step(p,input);
  if (!result?.fallDamage||!p.alive) return;
  p.hp-=result.fallDamage;
  falls.push({p:p.id,d:result.fallDamage,s:+result.landedSpeed.toFixed(2)});
  if (p.hp<=0) {
    p.hp=0; p.alive=false; p.deaths++; p.respawnAt=now+RESPAWN_MS;
    killfeed.push({k:'FALL',v:p.name,kc:'#d7b56d',vc:p.color,hs:false,env:true});
  }
}

// ---------------------------------------------------------------- tick
setInterval(() => {
  const now = Date.now();

  for (const [ws, p] of players) {
    if (!p.team) { inputs.get(ws).length = 0; continue; }
    if (!p.alive) {
      if (now >= p.respawnAt) respawn(p);
      inputs.get(ws).length = 0;
      continue;
    }
    const q = inputs.get(ws);
    if (q.length === 0) {
      movementStep(p,{up:false,down:false,left:false,right:false,jump:false,sprint:false,roll:0,yaw:p.yaw,pitch:p.pitch},now);
    } else {
      for (const {seq,input} of q) {
        movementStep(p,input,now); p.lastSeq=seq;
        if (!p.alive) break;
      }
      q.length = 0;
    }
  }

  const snapshot = JSON.stringify({
    t:'s', ts: now,
    players: [...players.values()].map(p => ({
      i:p.id, n:p.name, c:p.color,
      x:+p.x.toFixed(3), z:+p.z.toFixed(3), y:+(p.y||0).toFixed(3),
      vx:+p.vx.toFixed(3), vz:+p.vz.toFixed(3), vy:+(p.vy||0).toFixed(3), og:!!p.onGround,
      cl:!!p.climbing, li:p.ladder??-1,
      rl:+(p.rollT||0).toFixed(3), rc:+(p.rollCd||0).toFixed(3), rk:p.rollKind|0,
      rx:+(p.rollX||0).toFixed(3), rz:+(p.rollZ||0).toFixed(3),
      rb:+(p.rollBuffer||0).toFixed(3), rbk:p.rollBufferKind|0,
      rby:+(p.rollBufferYaw||0).toFixed(3),
      fg:+(p.fallGrace||0).toFixed(3), pd:p.pendingFallDamage||0,
      ps:+(p.pendingFallSpeed||0).toFixed(3),
      yaw:+p.yaw.toFixed(3), pt:+(p.pitch||0).toFixed(3),
      hp:p.hp, al:p.alive, k:p.kills, d:p.deaths, ad:!!p.ads, tm:p.team,
      w:p.weapon||DEFAULT_WEAPON, ch:p.character||'soldier',
      rt: p.alive ? 0 : Math.max(0, p.respawnAt - now),   // ms until respawn
      seq:p.lastSeq | 0,
    })),
    fx, kf: killfeed, fd: falls,
  });
  fx=[]; killfeed=[]; falls=[];
  for (const ws of players.keys()) if (ws.readyState === 1) ws.send(snapshot);
}, 1000 / TICK_HZ);

// Skyhook is a non-combat race room. Movement remains responsive on each
// client; the server sanitizes and relays compact state at 20 Hz so climbers,
// ropes and wingsuits appear live to everyone else.
setInterval(() => {
  if (!skyPlayers.size) return;
  const snapshot=JSON.stringify({t:'sky-s',players:[...skyPlayers.values()].map(p=>({
    i:p.id,n:p.name,c:p.color,x:+p.x.toFixed(2),y:+p.y.toFixed(2),
    vx:+p.vx.toFixed(2),vy:+p.vy.toFixed(2),f:p.face,g:p.glide,fl:+p.flip.toFixed(2),
    h:p.hook?{x:+p.hook.x.toFixed(1),y:+p.hook.y.toFixed(1),pulling:p.hook.pulling}:null,
    cp:p.checkpoint,done:p.finished,time:+p.time.toFixed(2),
  }))});
  for(const ws of skyPlayers.keys())if(ws.readyState===1)ws.send(snapshot);
},50);

server.listen(PORT, '127.0.0.1', () =>
  console.log(`arena listening on 127.0.0.1:${PORT} @ ${TICK_HZ}Hz`));
