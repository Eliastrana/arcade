// Rendering + the client game loop.
// Two clocks: a FIXED 30Hz tick feeding the simulation (must match the server),
// and a free-running render loop at whatever the display can manage.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned, retargetClip } from '/vendor/jsm/utils/SkeletonUtils.js';
import { Net } from './net.js?v=reload-v1';
import { ArenaAudio } from './audio.js?v=reload-v1';
import { readInput, isFiring, isLocked, isAiming, getWeapon, setWeapon, setAiming, attachLook, setVirtual, setFiring, requestRoll, view , takeReload} from './input.js?v=reload-v1';
import { lookDir, clipCameraPosition } from '/shared/game.js';
import {
  DT, ARENA_HALF, WALL_HEIGHT, PLAYER_RADIUS, PLAYER_EYE, MAX_HP, ROLL_TIME,
  OBSTACLES, RAMPS, LADDERS, TEAM_COLORS, ADS_CAMERA_BACK, ADS_CAMERA_RIGHT, ADS_CAMERA_UP, WEAPONS,
} from '/shared/constants.js';

const UP = new THREE.Vector3(0, 1, 0);
const CAM_BACK = 4.2, CAM_RIGHT = 1.15, CAM_UP = 0.45;   // over-the-shoulder, hip fire
const ADS_BACK = ADS_CAMERA_BACK, ADS_RIGHT = ADS_CAMERA_RIGHT, ADS_UP = ADS_CAMERA_UP;
const FOV_HIP = 72, FOV_ADS = 36;
let adsT = 0;                                            // 0 = hip, 1 = scoped

// ------------------------------------------------------------------ scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x65727a);
scene.fog = new THREE.FogExp2(0x65727a, 0.0115);

const camera = new THREE.PerspectiveCamera(FOV_HIP, innerWidth / innerHeight, 0.1, 320);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);
renderer.setSize(innerWidth, innerHeight);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(170, 28, 14),
  new THREE.ShaderMaterial({
    side:THREE.BackSide, depthWrite:false,
    vertexShader:`varying float vY; void main(){ vY=normalize(position).y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader:`varying float vY; void main(){
      float h=smoothstep(-0.18,0.72,vY);
      vec3 low=vec3(.48,.48,.42), high=vec3(.12,.20,.27);
      vec3 col=mix(low,high,h);
      col+=vec3(.17,.075,.025)*exp(-pow((vY-.08)*6.0,2.0));
      gl_FragColor=vec4(col,1.0);
    }`,
  }),
);
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xaec8d3, 0x332d25, 1.4));
scene.add(new THREE.AmbientLight(0x98a298, 0.34));
const sun = new THREE.DirectionalLight(0xffddb0, 2.4);
sun.position.set(-34, 48, -24);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-40, right:40, top:40, bottom:-40 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({
  map:softDiscTexture('rgba(255,236,188,1)','rgba(255,160,72,0)'),
  color:0xffd59b, transparent:true, opacity:.72, depthWrite:false,
  blending:THREE.AdditiveBlending, fog:false,
}));
sunDisc.position.set(-104, 48, -118); sunDisc.scale.set(23,23,1); scene.add(sunDisc);

// ---------------------------------------------------------------- desert city
// Deterministic dressing means every player sees the same landmarks without
// putting decorative data on the wire. None of it changes the authoritative
// collision plane: debris is ankle-high and the large silhouettes beyond the
// arena walls remain unreachable.
function seeded(seed = 0x3f6a2c91) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const envRand = seeded();

function makeGroundTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#917a57'; g.fillRect(0, 0, 512, 512);

  // Fine mottling plus a few broad, muddy sweeps. Kept low contrast so player
  // silhouettes and tracers still read instantly against the ground.
  for (let i = 0; i < 13000; i++) {
    const v = 72 + Math.floor(envRand() * 70);
    g.fillStyle = `rgba(${v},${Math.floor(v * 0.82)},${Math.floor(v * 0.58)},${0.04 + envRand() * 0.10})`;
    const s = 0.5 + envRand() * 2.2;
    g.fillRect(envRand() * 512, envRand() * 512, s, s);
  }
  g.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    g.strokeStyle = `rgba(32,31,26,${0.035 + envRand() * 0.05})`;
    g.lineWidth = 5 + envRand() * 13;
    g.beginPath();
    const y = envRand() * 512;
    g.moveTo(-20, y);
    g.bezierCurveTo(130, y + envRand() * 60 - 30, 380, y + envRand() * 80 - 40, 540, y + envRand() * 60 - 30);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

// A very large ground sheet continues beyond the playable square, so the
// boundary feels like part of a wider desert district instead of a floating box.
const farGround = new THREE.Mesh(
  new THREE.PlaneGeometry(260, 260),
  new THREE.MeshStandardMaterial({ color:0x756a55, roughness:1 }),
);
farGround.rotation.x = -Math.PI / 2;
farGround.position.y = -0.31;
farGround.receiveShadow = true;
scene.add(farGround);

const groundTex = makeGroundTexture();
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(ARENA_HALF * 2, 0.5, ARENA_HALF * 2),
  new THREE.MeshStandardMaterial({ map:groundTex, color:0xe0c08a, roughness:0.98, metalness:0 }),
);
floor.position.y = -0.25;
floor.receiveShadow = true;
scene.add(floor);

const wallMat = new THREE.MeshStandardMaterial({color:0x9c8463,roughness:.98});
for (const [x, z, w, d] of [
  [0,  ARENA_HALF, ARENA_HALF*2+1, 1], [0, -ARENA_HALF, ARENA_HALF*2+1, 1],
  [ ARENA_HALF, 0, 1, ARENA_HALF*2+1], [-ARENA_HALF, 0, 1, ARENA_HALF*2+1],
]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_HEIGHT, d), wallMat);
  m.position.set(x, WALL_HEIGHT/2, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}

// Team deployment circles make the two courtyards readable at a glance.
for (const [x,color] of [[-21.5,TEAM_COLORS.red],[21.5,TEAM_COLORS.blue]]) {
  const mark=new THREE.Mesh(
    new THREE.RingGeometry(1.9,2.15,48),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity:.48,depthWrite:false}),
  );
  mark.rotation.x=-Math.PI/2; mark.position.set(x,.018,0); scene.add(mark);
}

// Server-backed architecture. Shared dimensions drive rendering, movement and
// hitscan, so every apparent wall is genuine cover.
const houseMat = new THREE.MeshStandardMaterial({color:0xb49a72,roughness:.98});
const obstacleWallMat = new THREE.MeshStandardMaterial({color:0xa48b68,roughness:.98});
const crateMat = new THREE.MeshStandardMaterial({color:0x76543b,roughness:.9,metalness:.04});
const roofMat = new THREE.MeshStandardMaterial({color:0xc3aa80,roughness:1});
const windowMat = new THREE.MeshStandardMaterial({color:0x202b2d,roughness:.55,metalness:.08});
const edgeMat = new THREE.LineBasicMaterial({color:0x4b392a,transparent:true,opacity:.5});

function addWindow(x,y,z,rotY,w=.95,h=.72) {
  const pane=new THREE.Mesh(new THREE.BoxGeometry(w,h,.055),windowMat);
  pane.position.set(x,y,z); pane.rotation.y=rotY; scene.add(pane);
}

for (const o of OBSTACLES) {
  const geo=new THREE.BoxGeometry(o.w,o.h,o.d);
  const material=o.kind==='house'?houseMat:o.kind==='crate'?crateMat:obstacleWallMat;
  const mesh=new THREE.Mesh(geo,material);
  mesh.position.set(o.x,o.h/2,o.z); mesh.castShadow=mesh.receiveShadow=true;
  scene.add(mesh);
  const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo),edgeMat);
  edges.position.copy(mesh.position); scene.add(edges);

  if (o.kind==='house') {
    const roof=new THREE.Mesh(new THREE.BoxGeometry(o.w+.16,.18,o.d+.16),roofMat);
    roof.position.set(o.x,o.h+.09,o.z); roof.castShadow=roof.receiveShadow=true; scene.add(roof);
    const parapets=[
      [o.x,o.h+.34,o.z-o.d/2,o.w+.25,.22],[o.x,o.h+.34,o.z+o.d/2,o.w+.25,.22],
      [o.x-o.w/2,o.h+.34,o.z,.22,o.d+.25],[o.x+o.w/2,o.h+.34,o.z,.22,o.d+.25],
    ];
    for (const [x,y,z,w,d] of parapets) {
      const p=new THREE.Mesh(new THREE.BoxGeometry(w,.5,d),roofMat);
      p.position.set(x,y,z); p.castShadow=true; scene.add(p);
    }
    // Small dark recesses sell the multi-storey scale without suggesting that
    // the solid buildings are enterable.
    for (const y of [2.8,5.7]) {
      if (y>o.h-.8) continue;
      for (const s of [-.24,.24]) {
        addWindow(o.x+o.w*s,y,o.z-o.d/2-.031,0);
        addWindow(o.x+o.w*s,y,o.z+o.d/2+.031,0);
        addWindow(o.x-o.w/2-.031,y,o.z+o.d*s,Math.PI/2);
        addWindow(o.x+o.w/2+.031,y,o.z+o.d*s,Math.PI/2);
      }
    }
  } else if (o.kind==='wall') {
    const cap=new THREE.Mesh(new THREE.BoxGeometry(o.w+.08,.10,o.d+.08),roofMat);
    cap.position.set(o.x,o.h+.02,o.z); cap.castShadow=true; scene.add(cap);
  }
}

// Every house has a shared-simulation ladder. The rails sit just off the wall
// face, while the rungs make the climbable route readable from across a lane.
const ladderMat=new THREE.MeshStandardMaterial({color:0x596166,roughness:.48,metalness:.72});
for (const l of LADDERS) {
  const ladder=new THREE.Group();
  const railGeo=new THREE.CylinderGeometry(.045,.045,l.height+.28,8);
  for (const x of [-l.width/2,l.width/2]) {
    const rail=new THREE.Mesh(railGeo,ladderMat); rail.position.set(x,l.height/2,0); rail.castShadow=true; ladder.add(rail);
  }
  const rungGeo=new THREE.CylinderGeometry(.035,.035,l.width,8);
  for (let y=.28;y<l.height+.12;y+=.38) {
    const rung=new THREE.Mesh(rungGeo,ladderMat); rung.rotation.z=Math.PI/2; rung.position.set(0,y,.01);
    rung.castShadow=true; ladder.add(rung);
  }
  ladder.position.set(l.x+l.nx*.055,0,l.z+l.nz*.055);
  ladder.rotation.y=Math.atan2(l.nx,l.nz);
  scene.add(ladder);
}

function makeRampGeometry(width,length,height) {
  const w=width/2, l=length/2;
  const pos=new Float32Array([
    -w,0,-l,  w,0,-l,  -w,0,l,  w,0,l,  -w,height,l,  w,height,l,
  ]);
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  geo.setIndex([
    0,2,3, 0,3,1,       // bottom
    0,1,5, 0,5,4,       // sloped deck
    2,4,5, 2,5,3,       // tall face
    0,4,2,               // left side
    1,3,5,               // right side
  ]);
  geo.computeVertexNormals(); return geo;
}
const rampMat=new THREE.MeshStandardMaterial({color:0x806c53,roughness:.82,metalness:.12});
for (const r of RAMPS) {
  const ramp=new THREE.Mesh(makeRampGeometry(r.width,r.length,r.height),rampMat);
  ramp.position.set(r.x,.012,r.z);
  ramp.rotation.y = r.axis === 'x' ? (r.dir>0 ? Math.PI/2 : -Math.PI/2) : (r.dir>0 ? 0 : Math.PI);
  ramp.castShadow=ramp.receiveShadow=true; scene.add(ramp);

  // Thin crossbars communicate slope and direction without becoming colliders.
  const bars=new THREE.Group();
  for (let i=1;i<7;i++) {
    const q=i/7, bar=new THREE.Mesh(
      new THREE.BoxGeometry(r.width*.96,.035,.055),
      new THREE.MeshStandardMaterial({color:0xc2aa7f,roughness:.85,metalness:.10}),
    );
    bar.position.set(0,q*r.height+.035,-r.length/2+q*r.length);
    bar.rotation.x=-Math.atan2(r.height,r.length);
    bars.add(bar);
  }
  bars.position.copy(ramp.position); bars.rotation.copy(ramp.rotation); scene.add(bars);
}

// Small stones and broken timbers add texture but stay low enough that walking
// straight through them never reads as missing collision.
const stoneGeo = new THREE.DodecahedronGeometry(0.16, 0);
const stoneMat = new THREE.MeshStandardMaterial({color:0x79694f,roughness:1,flatShading:true});
const stones = new THREE.InstancedMesh(stoneGeo,stoneMat,58);
const envDummy = new THREE.Object3D();
for (let i = 0; i < 58; i++) {
  const edgeBias = Math.pow(envRand(), 0.58);
  const a = envRand() * Math.PI * 2;
  const r = 7 + edgeBias * 16;
  envDummy.position.set(Math.cos(a) * r, 0.08, Math.sin(a) * r);
  envDummy.rotation.set(envRand()*2, envRand()*2, envRand()*2);
  const s = 0.45 + envRand() * 1.35;
  envDummy.scale.set(s, 0.35 + envRand() * 0.7, s);
  envDummy.updateMatrix(); stones.setMatrixAt(i, envDummy.matrix);
}
stones.castShadow = stones.receiveShadow = true;
scene.add(stones);

const timberGeo = new THREE.BoxGeometry(0.12, 0.10, 1.4);
const timberMat = new THREE.MeshStandardMaterial({ color:0x4a3828, roughness:1 });
const timbers = new THREE.InstancedMesh(timberGeo,timberMat,16);
for (let i = 0; i < 16; i++) {
  const a = envRand() * Math.PI * 2, r = 9 + envRand() * 13;
  envDummy.position.set(Math.cos(a)*r, 0.06, Math.sin(a)*r);
  envDummy.rotation.set(0, envRand()*Math.PI, (envRand()-.5)*0.09);
  envDummy.scale.set(0.7 + envRand()*.6, 1, 0.55 + envRand()*.7);
  envDummy.updateMatrix(); timbers.setMatrixAt(i, envDummy.matrix);
}
timbers.castShadow = true; scene.add(timbers);

// Low-poly ridges beyond the walls provide a strong horizon silhouette while
// remaining unreachable and purely visual.
const ridgeMat = new THREE.MeshStandardMaterial({ color:0x454b45, roughness:1, flatShading:true });
for (let i = 0; i < 20; i++) {
  const a = i / 20 * Math.PI * 2 + (envRand() - .5) * .18;
  const dist = 55 + envRand() * 20;
  const ridge = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 1), ridgeMat);
  ridge.position.set(Math.cos(a)*dist, 3 + envRand()*4, Math.sin(a)*dist);
  ridge.scale.set(13 + envRand()*13, 7 + envRand()*10, 8 + envRand()*13);
  ridge.rotation.set(envRand()*.35, envRand()*Math.PI, envRand()*.16);
  ridge.castShadow = ridge.receiveShadow = true;
  scene.add(ridge);
}

// Skeletal trees punctuate the skyline. Their branches are deliberately kept
// outside the arena so they are never mistaken for interactive cover.
const deadWood = new THREE.MeshStandardMaterial({ color:0x302b25, roughness:1 });
const trunkGeo = new THREE.CylinderGeometry(.10, .19, 3.8, 6);
const branchGeo = new THREE.CylinderGeometry(.045, .085, 1.7, 5);
for (let i = 0; i < 24; i++) {
  const a = envRand() * Math.PI * 2, dist = 30 + envRand()*20;
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(trunkGeo, deadWood); trunk.position.y = 1.9; tree.add(trunk);
  for (let b = 0; b < 3; b++) {
    const branch = new THREE.Mesh(branchGeo, deadWood);
    branch.position.set(0, 2.0 + b*.55, 0);
    branch.rotation.z = (b%2 ? -1 : 1) * (.62 + envRand()*.35);
    branch.rotation.y = envRand()*Math.PI;
    tree.add(branch);
  }
  tree.position.set(Math.cos(a)*dist, 0, Math.sin(a)*dist);
  tree.scale.setScalar(.65 + envRand()*.75);
  tree.rotation.y = envRand()*Math.PI;
  tree.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(tree);
}

// Flags sit on top of the four boundary corners. Their vertex positions are
// animated below, giving the arena a readable wind direction.
const flags = [];
const poleMat = new THREE.MeshStandardMaterial({ color:0x34383a, metalness:.55, roughness:.5 });
for (const [x,z,rot,color] of [
  [-23.5,-23.5,0,TEAM_COLORS.red], [23.5,-23.5,Math.PI/2,TEAM_COLORS.blue],
  [23.5,23.5,Math.PI,TEAM_COLORS.blue], [-23.5,23.5,-Math.PI/2,TEAM_COLORS.red],
]) {
  const group = new THREE.Group(); group.position.set(x, WALL_HEIGHT, z); group.rotation.y = rot;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(.035,.05,3.4,8), poleMat);
  pole.position.y = 1.7; pole.castShadow = true; group.add(pole);
  const geo = new THREE.PlaneGeometry(1.8, .85, 8, 2);
  geo.translate(.9, -.38, 0);
  const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color, roughness:.86, side:THREE.DoubleSide,
  }));
  cloth.position.y = 3.1; cloth.castShadow = true; group.add(cloth);
  flags.push({ mesh:cloth, base:geo.attributes.position.array.slice(), phase:envRand()*10 });
  scene.add(group);
}

function softDiscTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(48,48,3,48,48,47);
  gr.addColorStop(0, inner); gr.addColorStop(.38, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0,0,96,96);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

// Three looping smoke columns hint at action beyond the playable square. Each
// puff recycles in place, so ambience does not allocate during the render loop.
const smokeTexture = softDiscTexture('rgba(63,67,65,.7)', 'rgba(55,59,58,0)');
const smokePuffs = [];
for (const [bx,bz,scale] of [[-39,-31,1.15],[46,18,.85],[14,52,1.0]]) {
  for (let i = 0; i < 11; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map:smokeTexture, color:0x6f7470, transparent:true, opacity:.25,
      depthWrite:false, fog:true,
    }));
    const phase = (i / 11 + envRand()*.04) % 1;
    sprite.position.set(bx, 1, bz); scene.add(sprite);
    smokePuffs.push({ sprite, bx, bz, phase, scale, sway:envRand()*Math.PI*2 });
  }
}

// Windblown dust/ash crosses the play space. Points are cheap enough to keep
// this visible on mobile, and wrapping avoids per-frame object churn.
const dustCount = 360;
const dustPos = new Float32Array(dustCount * 3);
for (let i = 0; i < dustCount; i++) {
  dustPos[i*3] = (envRand()-.5)*58;
  dustPos[i*3+1] = .15 + envRand()*5.2;
  dustPos[i*3+2] = (envRand()-.5)*58;
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  color:0xd7c9a1, size:.055, transparent:true, opacity:.42, depthWrite:false,
}));
dust.frustumCulled = false; scene.add(dust);

function animateEnvironment(now, dt) {
  const t = now * .001;
  for (const f of flags) {
    const p = f.mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = f.base[i*3], y = f.base[i*3+1];
      p.setXYZ(i, x, y + Math.sin(t*4.4 + x*3.6 + f.phase)*.045*x,
        Math.sin(t*5.2 + x*4.2 + f.phase)*.10*x);
    }
    p.needsUpdate = true;
    f.mesh.geometry.computeVertexNormals();
  }
  for (const p of smokePuffs) {
    const q = (p.phase + t*.028) % 1;
    const rise = q * 19;
    p.sprite.position.set(
      p.bx + Math.sin(q*5 + p.sway)*(.6 + q*2.6) + q*5.0,
      1 + rise,
      p.bz + Math.cos(q*4 + p.sway)*(.35 + q*1.3),
    );
    const s = p.scale * (2.2 + q*7.5);
    p.sprite.scale.set(s, s, 1);
    p.sprite.material.opacity = .24 * Math.sin(Math.PI*q) * (1-q*.45);
  }
  const pos = dust.geometry.attributes.position;
  for (let i = 0; i < dustCount; i++) {
    let x = pos.getX(i) + dt * (1.0 + (i%7)*.09);
    let z = pos.getZ(i) + dt * .22;
    if (x > 29) x -= 58;
    if (z > 29) z -= 58;
    pos.setXYZ(i, x, pos.getY(i) + Math.sin(t*1.6 + i)*dt*.045, z);
  }
  pos.needsUpdate = true;
}

// ------------------------------------------------------------------ avatars
// One rigged glTF is loaded once and cloned per player. SkeletonUtils.clone()
// (not Object3D.clone) is required - a plain clone would share skeletons and
// every player would animate identically.
const CHAR_HEIGHT = 1.8;
const WAIST = 0.85;          // roll tumbles about here; the death topple uses the feet
let CLIPS = null;
const CHARACTER_ASSETS = new Map();
const CHARACTER_SOURCES = {
  soldier: { url:'/models/Soldier.glb', frontZ:-1, yawOffset:0,       armSign: 1, tint:.55 },
};

// The weapon is mounted to the torso rather than to one wrist. Both hands are
// then solved onto explicit grip points every frame. This avoids the old
// "floating gun + shrugging arms" pose and keeps the grip stable through the
// idle, walk and run clips.
// Weapon position and size are derived from each rig's shoulder height and arm
// length. This keeps the mount adaptable if differently proportioned rigs are
// added later instead of forcing every character through one hard-coded pose.

const BONE = (root, ...names) => {
  for (const n of names) { const b = root.getObjectByName(n); if (b) return b; }
  return null;
};

const _qWant = new THREE.Quaternion(), _qParent = new THREE.Quaternion();
const _eAim = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Point the barrel exactly along (yaw, pitch), whatever the body animation is
 * doing. We build the desired WORLD rotation and convert it into the hand
 * rig's local space - far more robust than hand-tuned Euler offsets, and it
 * survives any change to the pose or the model.
 */
function aimGun(a, yaw, pitch) {
  if (!a.gunOuter || !a.gunOuter.parent) return;
  _eAim.set(pitch, yaw, 0);
  _qWant.setFromEuler(_eAim);                       // -Z of this faces the aim dir
  a.gunOuter.parent.getWorldQuaternion(_qParent);
  a.gunOuter.quaternion.copy(_qParent.invert()).multiply(_qWant);
}

const _ikY=new THREE.Vector3(0,1,0),_ikFrom=new THREE.Vector3(),_ikAim=new THREE.Vector3();
const _ikStart=new THREE.Vector3(),_ikElbow=new THREE.Vector3(),_ikWrist=new THREE.Vector3();
const _ikTarget=new THREE.Vector3(),_ikDir=new THREE.Vector3(),_ikPole=new THREE.Vector3(),_ikBase=new THREE.Vector3();
const _ikQ0=new THREE.Quaternion(),_ikQ1=new THREE.Quaternion(),_ikQ2=new THREE.Quaternion();

/** Aim a bone's local +Y axis while retaining the animation's existing twist. */
function pointBoneAt(bone,target) {
  if (!bone||!bone.parent) return;
  bone.updateWorldMatrix(true,true);
  bone.getWorldPosition(_ikStart);
  _ikAim.copy(target).sub(_ikStart).normalize();
  bone.getWorldQuaternion(_ikQ0);
  _ikFrom.copy(_ikY).applyQuaternion(_ikQ0).normalize();
  _ikQ1.setFromUnitVectors(_ikFrom,_ikAim);
  _ikQ0.premultiply(_ikQ1);                 // minimal world-space correction
  bone.parent.getWorldQuaternion(_ikQ2).invert();
  bone.quaternion.copy(_ikQ2.multiply(_ikQ0));
  bone.updateWorldMatrix(true,true);
}

/** Analytic two-bone IK: shoulder -> elbow -> weapon grip. */
function solveArm(arm,fore,hand,target,poleSign,a) {
  if (!arm||!fore||!hand||!target) return;
  a.root.updateWorldMatrix(true,true);
  arm.getWorldPosition(_ikStart); fore.getWorldPosition(_ikElbow); hand.getWorldPosition(_ikWrist);
  const upper=_ikStart.distanceTo(_ikElbow),lower=_ikElbow.distanceTo(_ikWrist);
  target.getWorldPosition(_ikTarget);
  _ikDir.copy(_ikTarget).sub(_ikStart);
  const dist=Math.max(.001,Math.min(_ikDir.length(),upper+lower-.003));
  _ikDir.normalize();
  const along=(upper*upper-lower*lower+dist*dist)/(2*dist);
  const bend=Math.sqrt(Math.max(0,upper*upper-along*along));

  // Elbows sit slightly out and down from the torso. Rotate that pole with the
  // avatar so the bend remains anatomically consistent at every world yaw.
  _ikPole.set(poleSign,-.42,.18).normalize();
  a.group.getWorldQuaternion(_ikQ0);
  _ikPole.applyQuaternion(_ikQ0);
  _ikPole.addScaledVector(_ikDir,-_ikPole.dot(_ikDir));
  if (_ikPole.lengthSq()<1e-5) _ikPole.set(0,-1,0);
  _ikPole.normalize();
  _ikBase.copy(_ikStart).addScaledVector(_ikDir,along);
  _ikElbow.copy(_ikBase).addScaledVector(_ikPole,bend);

  pointBoneAt(arm,_ikElbow);
  pointBoneAt(fore,_ikTarget);
}

function applyWeaponGrip(a) {
  const grips=a.weapon===2?a.shotgunGrips:a.rifleGrips;
  if (!grips) return;
  const side=a.armSign||1;
  solveArm(a.bones.rArm,a.bones.rFore,a.bones.rHand,grips.right, side,a);
  solveArm(a.bones.lArm,a.bones.lFore,a.bones.lHand,grips.left,-side,a);
}

function makeGun() {
  // outer: parented to the character root and scale-corrected.
  // inner: recoils along its own -Z (the barrel axis) without fighting the bone.
  const outer = new THREE.Group();
  const recoil = new THREE.Group();
  outer.add(recoil);

  const dark  = new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.5, metalness: 0.35 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a444f, roughness: 0.35, metalness: 0.6 });
  const wood  = new THREE.MeshStandardMaterial({ color: 0x6b4328, roughness: 0.72, metalness: 0.05 });

  const rifle = new THREE.Group();
  const body   = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.11, 0.42), dark);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.042, 0.30), steel);
  barrel.position.z = -0.38;
  const mag    = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.17, 0.09), dark);
  mag.position.set(0, -0.13, -0.02);
  const stock  = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.14), dark);
  stock.position.z = 0.25;
  rifle.add(body, barrel, mag, stock);

  const muzzleRifle = new THREE.Object3D();
  muzzleRifle.name = 'muzzleRifle'; muzzleRifle.position.set(0,0,-0.55); rifle.add(muzzleRifle);
  const rifleRightGrip=new THREE.Object3D(),rifleLeftGrip=new THREE.Object3D();
  rifleRightGrip.position.set(.055,-.075,.10);
  rifleLeftGrip.position.set(-.035,-.025,-.04);
  rifle.add(rifleRightGrip,rifleLeftGrip);

  // Chunkier pump-action silhouette: broad receiver, long tube/barrel and
  // wooden furniture make the selected weapon readable on other players.
  const shotgun = new THREE.Group(); shotgun.visible=false;
  const receiver=new THREE.Mesh(new THREE.BoxGeometry(.095,.125,.42),dark);
  const shotBarrel=new THREE.Mesh(new THREE.CylinderGeometry(.028,.031,.54,10),steel);
  shotBarrel.rotation.x=Math.PI/2; shotBarrel.position.z=-.43;
  const tube=new THREE.Mesh(new THREE.CylinderGeometry(.023,.023,.42,9),dark);
  tube.rotation.x=Math.PI/2; tube.position.set(0,-.055,-.36);
  const pump=new THREE.Mesh(new THREE.BoxGeometry(.10,.105,.20),wood); pump.position.z=-.32;
  const shotStock=new THREE.Mesh(new THREE.BoxGeometry(.075,.11,.18),wood); shotStock.position.z=.27;
  shotgun.add(receiver,shotBarrel,tube,pump,shotStock);
  const muzzleShotgun=new THREE.Object3D();
  muzzleShotgun.name='muzzleShotgun'; muzzleShotgun.position.set(0,0,-.70); shotgun.add(muzzleShotgun);
  const shotgunRightGrip=new THREE.Object3D(),shotgunLeftGrip=new THREE.Object3D();
  shotgunRightGrip.position.set(.06,-.08,.11);
  shotgunLeftGrip.position.set(-.04,-.035,-.05);
  shotgun.add(shotgunRightGrip,shotgunLeftGrip);

  recoil.add(rifle,shotgun);
  recoil.traverse(o => { if (o.isMesh) o.castShadow = true; });

  outer.userData.recoil = recoil;
  outer.userData.rifle = rifle;
  outer.userData.shotgun = shotgun;
  outer.userData.rifleGrips = {right:rifleRightGrip,left:rifleLeftGrip};
  outer.userData.shotgunGrips = {right:shotgunRightGrip,left:shotgunLeftGrip};
  return outer;
}

/**
 * Mount the weapon in torso space. The procedural arm solver reaches for its
 * grip markers; the weapon itself remains rock-solid and exactly aim-aligned.
 */
function attachGun(parent,modelScale,mount,weaponScale=1) {
  const gun = makeGun();
  // The character root is scaled from model units to metres. Cancel that
  // scale for the weapon geometry, and convert the waist-relative mount point
  // back into root-local model units. It now follows rolls/death topples while
  // remaining a stable, metre-sized target for the hand IK.
  const k=1/modelScale;
  gun.scale.setScalar(k);
  gun.userData.recoil.scale.setScalar(weaponScale);
  gun.position.set(mount.x*k,(mount.y-parent.position.y)*k,mount.z*k);
  gun.userData.k = k;
  parent.add(gun);
  return gun;
}

async function loadCharacters() {
  const loader=new GLTFLoader();
  const loaded=await Promise.all(Object.entries(CHARACTER_SOURCES).map(async ([key,cfg])=>
    [key,cfg,await loader.loadAsync(cfg.url)]));
  const soldier=loaded.find(([key])=>key==='soldier')[2];
  CLIPS=soldier.animations;
  const firstSkin=root=>{ let skin=null;root.traverse(o=>{if(!skin&&o.isSkinnedMesh)skin=o;});return skin; };
  const sourceSkin=firstSkin(soldier.scene);

  for (const [key,cfg,gltf] of loaded) {
    gltf.scene.traverse(o=>{ if (o.name?.startsWith('mixamorig1:')) o.name=o.name.replace('mixamorig1:','mixamorig:'); });
    const box=new THREE.Box3().setFromObject(gltf.scene);
    const scale=CHAR_HEIGHT/(box.max.y-box.min.y);
    let clips=CLIPS;
    if (key!=='soldier') {
      const targetSkin=firstSkin(gltf.scene);
      const names={};
      for (const bone of targetSkin.skeleton.bones) names[bone.name]=bone.name;
      // SkeletonUtils converts each source pose through world space into the
      // target rig's bind axes. This handles Mixamo exports whose local bone
      // orientation differs from the Blender-exported Soldier sample.
      clips=CLIPS.map(clip=>retargetClip(targetSkin,sourceSkin,clip,{
        names,hip:'__no_root_motion__',preserveBonePositions:true,fps:30,
      }));
      targetSkin.skeleton.pose(); gltf.scene.updateMatrixWorld(true);
    }
    CHARACTER_ASSETS.set(key,{
      key,template:gltf.scene,clips,
      scale,footOffset:-box.min.y*scale,...cfg,
    });
  }
}

/** Name + health bar baked into one sprite; redrawn only when it changes. */
function drawTag(name, color, hp) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 76;
  const g = c.getContext('2d');
  g.font = 'bold 26px ui-monospace, Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 2, 256, 34);
  g.fillStyle = color;            g.fillText(name, 128, 19);
  const pct = Math.max(0, Math.min(1, hp / MAX_HP));
  g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(38, 44, 180, 14);
  g.fillStyle = pct > 0.5 ? '#3ddc84' : pct > 0.25 ? '#f5c451' : '#ff5470';
  g.fillRect(40, 46, 176 * pct, 10);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(3.4, 1.0, 1);
  return sp;
}

const avatars = new Map();

function avatar(id, name, color, hp, character='soldier') {
  let a = avatars.get(id);
  if (a&&a.character!==character) {
    scene.remove(a.group,a.tag);
    a.tag.material.map.dispose(); a.tag.material.dispose();
    avatars.delete(id); a=null;
  }
  if (!a) {
    const asset=CHARACTER_ASSETS.get(character)||CHARACTER_ASSETS.get('soldier');
    const root = cloneSkinned(asset.template);
    root.scale.setScalar(asset.scale);
    root.position.y = asset.footOffset;
    const teamTint=new THREE.Color(color);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;              // skinned bounds go stale while animating
      o.material = o.material.clone();      // clone or every player shares one colour
      if (o.material.color) o.material.color.lerp(teamTint,asset.tint);
    });

    // group (world position + yaw)
    //  \_ pivot (waist height)  - the roll tumbles about this
    //      \_ root (model, origin at the feet) - the death topple uses this
    const pivot = new THREE.Group();
    pivot.position.y = WAIST;
    root.position.y -= WAIST;
    pivot.add(root);
    const group = new THREE.Group();
    group.add(pivot);
    scene.add(group);

    const bones = {
      rArm:  BONE(root, 'mixamorigRightArm', 'mixamorig:RightArm'),
      rFore: BONE(root, 'mixamorigRightForeArm', 'mixamorig:RightForeArm'),
      rHand: BONE(root, 'mixamorigRightHand', 'mixamorig:RightHand'),
      lArm:  BONE(root, 'mixamorigLeftArm', 'mixamorig:LeftArm'),
      lFore: BONE(root, 'mixamorigLeftForeArm', 'mixamorig:LeftForeArm'),
      lHand: BONE(root, 'mixamorigLeftHand', 'mixamorig:LeftHand'),
    };
    root.updateWorldMatrix(true,true);
    const bonePos=b=>b?b.getWorldPosition(new THREE.Vector3()):new THREE.Vector3();
    const rShoulder=bonePos(bones.rArm),lShoulder=bonePos(bones.lArm);
    const shoulder=rShoulder.clone().add(lShoulder).multiplyScalar(.5);
    const reachOf=(arm,fore,hand)=>bonePos(arm).distanceTo(bonePos(fore))+bonePos(fore).distanceTo(bonePos(hand));
    const reach=(reachOf(bones.rArm,bones.rFore,bones.rHand)+reachOf(bones.lArm,bones.lFore,bones.lHand))*.5;
    const mount=new THREE.Vector3(
      shoulder.x,shoulder.y-WAIST-reach*.34,shoulder.z+asset.frontZ*reach*.68);
    const weaponScale=Math.max(.68,Math.min(1.12,reach/.473));
    const gun = attachGun(root,asset.scale,mount,weaponScale);

    const mixer = new THREE.AnimationMixer(root);
    const pick = (n) => {
      const clip = THREE.AnimationClip.findByName(asset.clips, n);
      return clip ? mixer.clipAction(clip) : null;
    };
    const actions = { idle: pick('Idle'), walk: pick('Walk'), run: pick('Run') };
    if (actions.idle) actions.idle.play();

    const tag = drawTag(name, color, hp);
    scene.add(tag);
    a = {
      id, character:asset.key, asset, armSign:asset.armSign, yawOffset:asset.yawOffset,
      wantAds: false, rollT: 0, rollKind: 0, rolling: false,
      group, pivot, root, mixer, actions, state: 'idle', tag, name, hp, color,
      gunOuter: gun, gunK: gun ? gun.userData.k : 1,
      gunRecoil: gun ? gun.userData.recoil : null,
      rifleModel: gun ? gun.userData.rifle : null,
      shotgunModel: gun ? gun.userData.shotgun : null,
      rifleGrips: gun ? gun.userData.rifleGrips : null,
      shotgunGrips: gun ? gun.userData.shotgunGrips : null,
      muzzleRifle: gun ? gun.getObjectByName('muzzleRifle') : null,
      muzzleShotgun: gun ? gun.getObjectByName('muzzleShotgun') : null,
      muzzle: gun ? gun.getObjectByName('muzzleRifle') : null,
      weapon: 1,
      recoil: 0, adsT: 0,
      bones,
    };
    avatars.set(id, a);
  } else if (a.name !== name || a.hp !== hp) {
    scene.remove(a.tag);
    a.tag.material.map.dispose(); a.tag.material.dispose();
    a.tag = drawTag(name, color, hp);
    scene.add(a.tag);
    a.name = name; a.hp = hp;
  }
  return a;
}

function setAvatarWeapon(a,slot) {
  slot=slot===2?2:1;
  if (a.weapon===slot) return;
  a.weapon=slot;
  if (a.rifleModel) a.rifleModel.visible=slot===1;
  if (a.shotgunModel) a.shotgunModel.visible=slot===2;
  a.muzzle=slot===2?a.muzzleShotgun:a.muzzleRifle;
}

/** Crossfade between idle / walk / run rather than snapping between clips. */
function setAnimState(a, state) {
  if (a.state === state || !a.actions[state]) return;
  const next = a.actions[state], prev = a.actions[a.state];
  next.reset().setEffectiveWeight(1).fadeIn(0.18).play();
  if (prev) prev.fadeOut(0.18);
  a.state = state;
}

function place(a, x, z, yaw, alive, speed = 0, y = 0, showTag = false) {
  a.alive = alive;
  a.group.visible = true;                      // body stays up while dead - it topples
  a.tag.visible = alive && showTag;             // teammates only; enemies get no reveal
  a.group.position.set(x, y, z);
  a.group.rotation.y = yaw + a.yawOffset;
  a.tag.position.set(x, CHAR_HEIGHT + 0.65 + y, z);
  if (!alive) return;                          // frozen mid-pose while collapsing

  setAnimState(a, speed < 0.5 ? 'idle' : speed < 7.5 ? 'walk' : 'run');
  // nudge playback rate toward the real speed so feet don't skate
  const act = a.actions[a.state];
  if (act && a.state !== 'idle') {
    const ref = a.state === 'walk' ? 5.0 : 10.0;
    act.timeScale = Math.max(0.55, Math.min(1.8, speed / ref));
  }
}

// ------------------------------------------------------------------ tracers
// Lines can't be thickened in WebGL, so tracers are thin additive cylinders -
// they read as glowing beams and shrink as they fade.
const tracers = [], flashes = [];
let FLASH_TEX = null;

function flashTexture() {
  if (FLASH_TEX) return FLASH_TEX;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0.00, 'rgba(255,255,255,1)');
  gr.addColorStop(0.30, 'rgba(255,226,160,0.9)');
  gr.addColorStop(1.00, 'rgba(255,150,40,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  FLASH_TEX = new THREE.CanvasTexture(c);
  FLASH_TEX.colorSpace = THREE.SRGBColorSpace;
  return FLASH_TEX;
}

const _up = new THREE.Vector3(0, 1, 0);

/**
 * A tracer is two coaxial additive cylinders: a near-white hot core and a
 * wider coloured halo. That reads as a glowing beam - a single line can't,
 * because WebGL ignores LineBasicMaterial.linewidth.
 */
function addTracer(from, to, color, hit) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 0.02) return;

  const base = new THREE.Color(hit ? 0xff9a9a : color);
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.030, 0.012, len, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: base.clone().lerp(new THREE.Color(0xffffff), 0.75),
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
  const halo = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.045, len, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: base, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));

  const g = new THREE.Group();
  g.add(halo, core);
  g.position.copy(from).addScaledVector(dir, 0.5);
  g.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
  scene.add(g);
  tracers.push({ g, core, halo, born: performance.now(), life: 190 });
}

/** Muzzle flash: a bright white core plus a warm bloom, both additive. */
function addFlash(pos, color) {
  const mk = (scale, col, op) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTexture(), color: col, blending: THREE.AdditiveBlending,
      transparent: true, opacity: op, depthWrite: false,
    }));
    sp.position.copy(pos);
    sp.scale.setScalar(scale);
    scene.add(sp);
    return sp;
  };
  flashes.push({
    a: mk(1.55, 0xffb347, 0.85),     // warm bloom
    b: mk(0.62, 0xffffff, 1.0),      // hot core
    born: performance.now(), life: 140,
  });
}

function fadeEffects(now) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i], age = now - t.born;
    if (age > t.life) {
      scene.remove(t.g);
      for (const m of [t.core, t.halo]) { m.geometry.dispose(); m.material.dispose(); }
      tracers.splice(i, 1);
    } else {
      const k = 1 - age / t.life;
      t.core.material.opacity = k;
      t.halo.material.opacity = 0.38 * k * k;        // halo dies faster than the core
      t.g.scale.set(0.2 + k * 0.8, 1, 0.2 + k * 0.8);
    }
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i], age = now - f.born;
    if (age > f.life) {
      scene.remove(f.a, f.b);
      f.a.material.dispose(); f.b.material.dispose();
      flashes.splice(i, 1);
    } else {
      const k = 1 - age / f.life;
      f.a.material.opacity = 0.85 * k;
      f.b.material.opacity = k;
      f.a.scale.setScalar(0.9 + k * 0.9);
      f.b.scale.setScalar(0.3 + k * 0.5);
    }
  }
}

// ------------------------------------------------------------------ net + HUD
const net = new Net();
const audio = new ArenaAudio();
const soundBtn = document.getElementById('sound');
function refreshSoundButton() {
  const on=audio.isEnabled();
  soundBtn.textContent=on?'sound on':'sound off';
  soundBtn.classList.toggle('muted',!on);
  soundBtn.setAttribute('aria-pressed',String(on));
}
refreshSoundButton();
soundBtn.addEventListener('click',()=>{ audio.setEnabled(!audio.isEnabled()); refreshSoundButton(); });
addEventListener('pointerdown',()=>audio.arm(),{passive:true});
addEventListener('keydown',()=>audio.arm(),{passive:true});
const weaponButtons=[...document.querySelectorAll('[data-weapon]')];
function refreshWeaponHud(slot=getWeapon()) {
  for (const b of weaponButtons) b.classList.toggle('active',Number(b.dataset.weapon)===slot);
  document.body.classList.toggle('weapon-shotgun',slot===2);
  const scopeButton=document.getElementById('ads');
  if (scopeButton) { scopeButton.disabled=slot===2; scopeButton.textContent=slot===2?'no scope':'scope'; }
  if (slot===2) { adsT=0; document.body.classList.remove('ads'); }
}
for (const b of weaponButtons) b.addEventListener('click',()=>setWeapon(Number(b.dataset.weapon)));
addEventListener('weaponchange',e=>refreshWeaponHud(e.detail.weapon));
refreshWeaponHud();
const teamPick = document.getElementById('teamPick');
let joiningTeam = false;
let joinedTeam = null;
const selectedCharacter='soldier';
net.onWelcome = (m) => {
  document.getElementById('name').value = m.name;
  joiningTeam = false;
  joinedTeam = null;
  teamPick.style.display = 'flex';
  net.setCharacter(selectedCharacter);
};
net.connect();
for (const b of document.querySelectorAll('[data-team]')) {
  b.addEventListener('click', () => {
    if (joiningTeam) return;
    joiningTeam = true;
    net.setCharacter(selectedCharacter);
    net.joinTeam(b.dataset.team);
    b.classList.add('joining');
  });
}
let lockBlocked = false;
attachLook(renderer.domElement, (locked) => {
  if (locked) lockBlocked = false;
  document.getElementById('lock').style.display = (locked || lockBlocked) ? 'none' : 'flex';
});
// If pointer lock never engages (embedded frames, restrictive permissions
// policy), don't leave the player clicking a prompt that can't be satisfied -
// switch to the drag-to-aim fallback and say so.
document.addEventListener('click', () => {
  setTimeout(() => {
    if (isLocked()) return;
    lockBlocked = true;
    document.getElementById('lock').style.display = 'none';
    document.getElementById('fallback').style.display = 'block';
  }, 400);
});

document.getElementById('name').addEventListener('change', e => net.setName(e.target.value));
// touch d-pad, with the same double-tap-to-roll as the keyboard
const PAD_ROLL = { up:1, down:2, left:3, right:4 };
const padTap = {};
for (const b of document.querySelectorAll('[data-dir]')) {
  const d = b.dataset.dir;
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    const now = performance.now();
    if (padTap[d] && now - padTap[d] < 280) { requestRoll(PAD_ROLL[d]); padTap[d] = 0; }
    else padTap[d] = now;
    setVirtual(d, true);
  });
  b.addEventListener('pointerup',   e => { e.preventDefault(); setVirtual(d, false); });
  b.addEventListener('pointerleave',e => { e.preventDefault(); setVirtual(d, false); });
}
const jumpBtn = document.getElementById('jump');
jumpBtn.addEventListener('pointerdown', e => { e.preventDefault(); setVirtual('jump', true); });
jumpBtn.addEventListener('pointerup',   e => { e.preventDefault(); setVirtual('jump', false); });
const fireBtn = document.getElementById('fire');
fireBtn.addEventListener('pointerdown', e => { e.preventDefault(); setFiring(true); });
fireBtn.addEventListener('pointerup',   e => { e.preventDefault(); setFiring(false); });
const adsBtn = document.getElementById('ads');
adsBtn.addEventListener('pointerdown', e => { e.preventDefault(); setAiming(true); });
adsBtn.addEventListener('pointerup',   e => { e.preventDefault(); setAiming(false); });

let hudAt = 0;
function hud(now) {
  if (now - hudAt < 120) return;
  hudAt = now;
  const me = net.self();
  const hp = me ? me.hp : 0;
  document.getElementById('hpfill').style.width = `${Math.max(0, hp / MAX_HP * 100)}%`;
  document.getElementById('hpnum').textContent = hp;
  // predicted, not raw input: matches the server's rule that you only
  // actually sneak while grounded and not mid-roll
  const ammoEl = document.getElementById('ammotxt');
  if (ammoEl && me) {
    const reloading = (me.reloadLeft || 0) > 0;
    ammoEl.textContent = reloading ? 'reloading' : `${me.ammo} / ${me.mag}`;
    ammoEl.classList.toggle('empty', !reloading && me.ammo === 0);
    const bar = document.getElementById('reloadfill');
    if (bar) bar.style.width = reloading
      ? `${Math.round((1 - me.reloadLeft / Math.max(1, me.reloadTotal)) * 100)}%` : '0%';
  }
  document.body.classList.toggle('sneaking', !!net.local.sneaking);
  const nameEl = document.getElementById('myname');
  if (me) { nameEl.textContent = me.name; nameEl.style.color = me.color; }
  const hasTeam = !!(me && me.team);
  if (hasTeam && joinedTeam !== me.team) {
    // Initial deployment faces each side toward mid instead of into a wall.
    view.yaw = me.team === 'red' ? -Math.PI/2 : Math.PI/2;
    view.pitch = 0;
    joinedTeam = me.team;
  } else if (!hasTeam) joinedTeam = null;
  if (hasTeam) {
    teamPick.style.display = 'none';
    joiningTeam = false;
    for (const b of document.querySelectorAll('[data-team]')) b.classList.remove('joining');
  }
  const counts = net.teamCounts();
  document.getElementById('redCount').textContent = counts.red;
  document.getElementById('blueCount').textContent = counts.blue;
  const badge = document.getElementById('teamBadge');
  badge.textContent = hasTeam ? me.team : 'spectating';
  badge.className = hasTeam ? `team-badge ${me.team}` : 'team-badge';

  const dead = !!(me && me.team && !me.alive);
  document.getElementById('dead').style.display = dead ? 'flex' : 'none';
  if (dead) document.getElementById('respawnIn').textContent =
    `respawning in ${(Math.max(0, me.respawnIn) / 1000).toFixed(1)}s`;
  document.getElementById('dot').style.background = net.connected ? '#3ddc84' : '#f05';

  document.getElementById('board').innerHTML = net.leaderboard().map(p =>
    `<tr><td style="color:${p.color}"><span class="team-mark ${p.team}"></span>${p.name}${p.id === net.id ? ' (you)' : ''}</td>
         <td>${p.kills}</td><td class="d">${p.deaths}</td></tr>`).join('');

  net.killfeed = net.killfeed.filter(k => now - k.at < 6000);
  document.getElementById('feed').innerHTML = net.killfeed.map(k =>
    `<div><span style="color:${k.kc}">${k.k}</span> <span class="dim">&rarr;</span> <span style="color:${k.vc}">${k.v}</span></div>`).join('');
}

// ------------------------------------------------------------------ loops
let acc = 0, prev = performance.now(), nextLocalShot = 0;
const eye = new THREE.Vector3(), fwd = new THREE.Vector3(), rightV = new THREE.Vector3();

const loop = () => {
  const now = performance.now();
  let frame = (now - prev) / 1000; prev = now;
  if (frame > 0.25) frame = 0.25;

  acc += frame;
  while (acc >= DT) { net.tick(readInput()); acc -= DT; }

  // Local cadence avoids needless packets; the server remains authoritative.
  const weapon=WEAPONS[getWeapon()]||WEAPONS[1];
  if (takeReload()) net.reload();
  if (isFiring() && now >= nextLocalShot) {
    net.shoot({yaw:view.yaw,pitch:view.pitch,ads:isAiming(),weapon:weapon.id});
    nextLocalShot=now+weapon.cooldown;
  }

  const _from = new THREE.Vector3();
  for (const d of net.takeDries()) {
    const da = avatars.get(d.p);
    audio.dryFire(da ? da.group.position : camera.position, d.p === net.id);
  }
  for (const f of net.takeFx()) {
    const shooter = avatars.get(f.p);
    if (shooter) setAvatarWeapon(shooter,f.w||1);
    const muzzleFrom = new THREE.Vector3(f.ax,f.ay,f.az);
    if (shooter && shooter.muzzle) shooter.muzzle.getWorldPosition(muzzleFrom);
    // For your scoped shot, the tracer visual follows the authoritative ray.
    // The flash and sound still originate at the physical muzzle.
    if (f.p===net.id && f.ad) _from.set(f.ax,f.ay,f.az);
    else _from.copy(muzzleFrom);
    addTracer(_from, new THREE.Vector3(f.bx, f.by, f.bz), f.c, f.h);
    if (f.first!==false) {
      addFlash(muzzleFrom,f.w===2?0xffbd72:0xffd9a0);
      audio.gunshot(muzzleFrom,f.p===net.id,f.w||1);
      const shotHit=f.wh??f.h,shotHead=f.whs??f.hs;
      if (f.p===net.id&&shotHit) {
        if (shotHead&&f.w!==2) audio.headshot();
        else audio.hit();
      }
      if (shooter) shooter.recoil=f.w===2?1.7:1;
    }
  }
  for (const impact of net.takeFalls()) {
    const a=avatars.get(impact.p);
    const pos=a?a.group.position:(impact.p===net.id
      ?new THREE.Vector3(net.local.x,net.local.y,net.local.z)
      :new THREE.Vector3());
    audio.fallImpact(pos,impact.d,impact.p===net.id);
  }
  fadeEffects(now);

  // recoil decay, applied along the barrel axis
  for (const a of avatars.values()) {
    if (!a.gunRecoil) continue;
    a.recoil = Math.max(0, a.recoil - frame * 8);

    // Reload: the muzzle dips away as the magazine is swapped, with a sharp
    // knock as the fresh mag seats. Progress comes from the server countdown,
    // so remote players animate in sync with their own reload timer.
    const rTot = a.reloadTotal || 0, rLeft = a.reloadLeft || 0;
    let dipX = 0, dipY = 0, dipZ = 0;
    if (rTot > 0 && rLeft > 0) {
      const prog = 1 - rLeft / rTot;                  // 0 -> 1 across the reload
      const dip = Math.sin(Math.PI * prog);           // eases out and back
      dipX = -0.85 * dip; dipY = -0.10 * dip; dipZ = 0.05 * dip;
      dipX += 0.22 * Math.exp(-Math.pow((prog - 0.55) / 0.07, 2));   // mag seats
    }
    a.gunRecoil.position.z = a.recoil * 0.11 + dipZ;
    a.gunRecoil.position.y = dipY;
    a.gunRecoil.rotation.x = -a.recoil * 0.28 + dipX;
  }

  for (const a of avatars.values()) {
    if (a.alive === false) {
      // Soldier.glb ships no death clip, so death is a procedural topple:
      // freeze the skeleton and rotate the body about its feet.
      a.deathT = Math.min(1, (a.deathT || 0) + frame / 0.75);
      const e = 1 - Math.pow(1 - a.deathT, 3);       // ease out - fast start, soft landing
      a.root.rotation.x = -e * Math.PI * 0.47;
      a.root.rotation.z = e * 0.22;
      continue;                                      // no mixer, no aim pose while dead
    }
    if (a.deathT) { a.deathT = 0; a.root.rotation.x = 0; a.root.rotation.z = 0; }

    // dodge roll: a full tumble about the waist over the roll's duration
    const rollT = a.id === net.id ? net.local.rollT : a.rollT;
    const kind  = a.id === net.id ? net.local.rollKind : a.rollKind;
    if (rollT > 0 && kind) {
      const ang = (1 - rollT / ROLL_TIME) * Math.PI * 2;
      a.pivot.rotation.x = kind === 1 ? -ang : kind === 2 ? ang : 0;
      a.pivot.rotation.z = kind === 3 ? ang : kind === 4 ? -ang : 0;
      a.rolling = true;
    } else if (a.rolling) {
      a.pivot.rotation.x = 0; a.pivot.rotation.z = 0; a.rolling = false;
    }

    a.mixer.update(frame);
    // NOTE: must come after mixer.update(), otherwise the clip overwrites the pose
    const want = a.id === net.id ? (isAiming() ? 1 : 0) : (a.wantAds ? 1 : 0);
    a.adsT += (want - a.adsT) * (1 - Math.pow(0.002, frame));
    a.group.updateWorldMatrix(true, true);
    aimGun(a, a.aimYaw || 0, a.aimPitch || 0);
    a.group.updateWorldMatrix(true, true);           // gun moved; grips are now authoritative
    applyWeaponGrip(a);
  }

  if (net.ready) {
    const me = net.self();
    const meA = avatar(net.id, me?.name ?? '', me?.color ?? '#fff', me?.hp ?? MAX_HP,me?.character||selectedCharacter);
    setAvatarWeapon(meA,getWeapon());
    const mySpeed = net.local.climbing ? 5.0 : Math.hypot(net.local.vx, net.local.vz);
    meA.reloadLeft = me?.reloadLeft || 0; meA.reloadTotal = me?.reloadTotal || 0;
    meA.aimYaw = view.yaw; meA.aimPitch = view.pitch;
    place(meA, net.local.x, net.local.z, view.yaw, me ? me.alive : true, mySpeed, net.local.y);
    audio.updatePlayer(net.id,{
      pos:meA.group.position, speed:mySpeed, onGround:net.local.onGround,
      vy:net.local.vy, rollT:net.local.rollT, alive:me ? me.alive : true, isSelf:true, sneaking:!!net.local.sneaking,
        reloadLeft:me?.reloadLeft||0, reloadTotal:me?.reloadTotal||0, now,
    });

    // blend between hip-fire and scoped, framerate-independently
    adsT += ((isAiming() ? 1 : 0) - adsT) * (1 - Math.pow(0.002, frame));
    document.body.classList.toggle('ads', adsT > 0.5);
    const lerp = (a, b) => a + (b - a) * adsT;
    const fov = lerp(FOV_HIP, FOV_ADS);
    if (Math.abs(camera.fov - fov) > 0.02) { camera.fov = fov; camera.updateProjectionMatrix(); }

    // over-the-shoulder camera: behind, up and to the right of the eye
    const d = lookDir(view.yaw, view.pitch);
    fwd.set(d.x, d.y, d.z);
    rightV.crossVectors(fwd, UP).normalize();
    eye.set(net.local.x, PLAYER_EYE + net.local.y, net.local.z);   // camera rides the jump
    const desiredCamera=eye.clone()
      .addScaledVector(fwd, -lerp(CAM_BACK, ADS_BACK))
      .addScaledVector(rightV, lerp(CAM_RIGHT, ADS_RIGHT))
      .addScaledVector(UP, lerp(CAM_UP, ADS_UP));
    const clippedCamera=clipCameraPosition(eye,desiredCamera);
    camera.position.set(clippedCamera.x,clippedCamera.y,clippedCamera.z);
    camera.lookAt(eye.clone().addScaledVector(fwd, 40));
    // Large-headed characters can engulf the view when a wall forces the
    // third-person camera very close. Hide only the local body at that point;
    // it reappears immediately once the camera has room again.
    const hideDistance=meA.character==='soldier'?.9:1.3;
    meA.group.visible=camera.position.distanceTo(eye)>hideDistance;
    audio.setListener(camera.position,rightV);
  }

  const live = new Set([net.id]);
  for (const r of net.remotes()) {
    live.add(r.id);
    const ra = avatar(r.id, r.name, r.color, r.hp,r.character||'soldier');
    setAvatarWeapon(ra,r.weapon||1);
    ra.wantAds = !!r.ads;
    ra.aimYaw = r.yaw; ra.aimPitch = r.pitch;
    ra.reloadLeft = r.reloadLeft || 0; ra.reloadTotal = r.reloadTotal || 0;
    ra.rollT = r.rollT || 0; ra.rollKind = r.rollKind || 0;
    const isTeammate = !!(r.team && r.team === net.self()?.team);
    place(ra, r.x, r.z, r.yaw, r.alive, r.speed, r.y || 0, isTeammate);
    audio.updatePlayer(r.id,{
      pos:ra.group.position, speed:r.speed, onGround:r.onGround,
      vy:r.vy, rollT:r.rollT, alive:r.alive, isSelf:false, sneaking:!!r.sneaking,
        reloadLeft:r.reloadLeft||0, reloadTotal:r.reloadTotal||0, now,
    });
  }
  for (const [id, a] of avatars) {
    if (!live.has(id)) { scene.remove(a.group, a.tag); avatars.delete(id); audio.removePlayer(id); }
  }

  animateEnvironment(now, frame);
  hud(now);
  renderer.render(scene, camera);
};

loadCharacters().then(() => {
  document.getElementById('loading').style.display = 'none';
  renderer.setAnimationLoop(loop);
}).catch((e) => {
  document.getElementById('loading').textContent = 'failed to load character: ' + e.message;
});
