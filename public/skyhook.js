const canvas=document.querySelector('#game');
const g=canvas.getContext('2d');
g.imageSmoothingEnabled=false;

const W=canvas.width,H=canvas.height,WORLD_W=1640,WORLD_H=440;
const platforms=[
  {x:0,y:370,w:180,h:70},{x:260,y:340,w:170,h:100},{x:455,y:285,w:20,h:155},
  {x:475,y:285,w:180,h:20},{x:630,y:255,w:70,h:20},{x:775,y:330,w:125,h:110},
  {x:920,y:205,w:20,h:235},{x:940,y:205,w:160,h:20},{x:1100,y:245,w:55,h:20},
  {x:1210,y:300,w:145,h:140},{x:1340,y:225,w:20,h:215},{x:1360,y:225,w:95,h:20},
  {x:1455,y:155,w:20,h:285},{x:1475,y:155,w:145,h:20},
  // High route: every island is reachable by the three-stage grappler, and
  // each release offers a steeper angle into the next section of sky.
  {x:155,y:275,w:76,h:15},{x:300,y:215,w:90,h:15},{x:500,y:160,w:95,h:15},
  {x:670,y:115,w:90,h:15},{x:825,y:75,w:90,h:15},{x:995,y:110,w:85,h:15},
  {x:1140,y:70,w:100,h:15},{x:1300,y:120,w:90,h:15},{x:1435,y:70,w:90,h:15}
];
const spikes=[{x:545,y:276,w:46},{x:805,y:321,w:36},{x:1245,y:291,w:38}];
const checkpoints=[{x:42,y:370},{x:650,y:255},{x:990,y:205},{x:1395,y:225}];
const goal={x:1577,y:116,w:18,h:39};
const stars=Array.from({length:80},(_,i)=>({x:(i*83)%WORLD_W,y:(i*47)%185,s:i%7===0?2:1}));
const keys={left:false,right:false,glide:false};
const p={x:42,y:350,w:9,h:15,vx:0,vy:0,face:1,onGround:false,wall:0,coyote:0,jumpBuf:0,energy:100,grapple:null,flipT:0,flipDir:1,dead:0,deaths:0,checkpoint:0,gliding:false};
const cam={x:0,y:210};
let running=false,won=false,startAt=0,elapsed=0,last=performance.now(),mouseWorld=null,shake=0;
const particles=[];
let audio=null;
let socket=null,myNetId=null,netClock=0,reconnectTimer=null,legacyRelay=false,legacyNameTimer=0,legacyNameHold=0;
const remotes=new Map();
const nameInput=document.querySelector('#climberName');
const fallbackNames=['Kite','Finch','Moth','Comet','Wren','Echo','Fox','Nova'];
try{nameInput.value=localStorage.getItem('skyhook-name')||fallbackNames[Math.floor(Math.random()*fallbackNames.length)];}catch{nameInput.value='Climber';}

function tone(freq,duration=.08,type='square',volume=.035,slide=0){
  try{
    audio ||= new (window.AudioContext||window.webkitAudioContext)();
    const o=audio.createOscillator(),gain=audio.createGain(),now=audio.currentTime;
    o.type=type;o.frequency.setValueAtTime(freq,now);o.frequency.linearRampToValueAtTime(Math.max(40,freq+slide),now+duration);
    gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration);
    o.connect(gain).connect(audio.destination);o.start(now);o.stop(now+duration);
  }catch{}
}

function sendName(){
  const name=(nameInput.value||'Climber').slice(0,14);nameInput.value=name;
  try{localStorage.setItem('skyhook-name',name);}catch{}
  if(socket?.readyState===1)socket.send(JSON.stringify(legacyRelay?{t:'name',name:`ZN${name.slice(0,12)}`}:{t:'sky-name',name}));
}

const b36=(n,w)=>Math.max(0,Math.round(n)).toString(36).padStart(w,'0').slice(-w);
const un36=s=>parseInt(s,36)||0;
function legacyState(){
  const flags=(p.face<0?1:0)|(p.gliding?2:0)|(p.grapple?4:0)|(won?8:0)|(p.flipT>0?16:0);
  const phase=p.checkpoint|(p.grapple?.mode==='pulling'?4:0);
  return `ZS${b36(p.x/2,2)}${b36(p.y,2)}${b36(flags,1)}${b36((p.grapple?.x||0)/2,2)}${b36(p.grapple?.y||0,2)}${b36(phase,1)}`;
}
function receiveLegacy(list){
  const now=performance.now();
  for(const s of list){
    if(s.i===myNetId||s.tm||typeof s.n!=='string')continue;
    const code=s.n;
    if(!code.startsWith('ZS')&&!code.startsWith('ZN'))continue;
    let r=remotes.get(s.i);
    if(!r){r={x:42,y:355,tx:42,ty:355,name:`Climber ${s.i}`,color:['#ec5578','#70def0','#ffd16a','#9a7cff','#8ee08e','#ff995e'][s.i%6]};remotes.set(s.i,r);}
    r.lastSeen=now;
    if(code.startsWith('ZN')){r.name=code.slice(2)||r.name;continue;}
    if(code.length<12)continue;
    const flags=un36(code[6]);
    const phase=un36(code[11]),flipping=!!(flags&16);
    if(flipping&&!r.flipping)r.flipStarted=now;
    Object.assign(r,{tx:un36(code.slice(2,4))*2,ty:un36(code.slice(4,6)),face:flags&1?-1:1,
      gliding:!!(flags&2),flipping,hook:flags&4?{x:un36(code.slice(7,9))*2,y:un36(code.slice(9,11)),pulling:!!(phase&4)}:null,
      finished:!!(flags&8),checkpoint:phase&3});
  }
  for(const [id,r] of remotes)if(now-(r.lastSeen||0)>2500)remotes.delete(id);
  const count=remotes.size+1;document.querySelector('#online').textContent=`${count} climber${count===1?'':'s'} online`;
}

function connectSky(){
  clearTimeout(reconnectTimer);
  const proto=location.protocol==='https:'?'wss://':'ws://';
  socket=new WebSocket(`${proto}${location.host}/?game=skyhook`);
  socket.addEventListener('open',()=>{document.querySelector('#online').textContent='connected';sendName();});
  socket.addEventListener('message',event=>{
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.t==='welcome'){
      legacyRelay=true;myNetId=m.id;legacyNameTimer=0;sendName();return;
    }
    if(m.t==='s'&&legacyRelay){receiveLegacy(m.players||[]);return;}
    if(m.t==='sky-welcome'){myNetId=m.id;if(!nameInput.value)nameInput.value=m.name;sendName();return;}
    if(m.t!=='sky-s')return;
    const seen=new Set();
    for(const s of m.players){
      if(s.i===myNetId)continue;seen.add(s.i);
      let r=remotes.get(s.i);
      if(!r){r={x:s.x,y:s.y,tx:s.x,ty:s.y};remotes.set(s.i,r);}
      const flipping=(s.fl||0)>0;if(flipping&&!r.flipping)r.flipStarted=performance.now();
      Object.assign(r,{tx:s.x,ty:s.y,vx:s.vx,vy:s.vy,face:s.f,gliding:s.g,flipping,hook:s.h,name:s.n,color:s.c,checkpoint:s.cp,finished:s.done,time:s.time});
    }
    for(const id of remotes.keys())if(!seen.has(id))remotes.delete(id);
    const count=remotes.size+1;document.querySelector('#online').textContent=`${count} climber${count===1?'':'s'} online`;
  });
  socket.addEventListener('close',()=>{myNetId=null;legacyRelay=false;remotes.clear();document.querySelector('#online').textContent='reconnecting…';reconnectTimer=setTimeout(connectSky,1200);});
  socket.addEventListener('error',()=>socket.close());
}

function networkStep(dt){
  for(const q of remotes.values()){const a=Math.min(1,dt*14);q.x+=(q.tx-q.x)*a;q.y+=(q.ty-q.y)*a;}
  netClock-=dt;if(netClock>0||socket?.readyState!==1||myNetId===null)return;netClock=.05;
  if(legacyRelay){
    legacyNameTimer-=.05;legacyNameHold-=.05;
    if(legacyNameTimer<=0){sendName();legacyNameTimer=2;legacyNameHold=.15;return;}
    if(legacyNameHold>0)return;
    socket.send(JSON.stringify({t:'name',name:legacyState()}));return;
  }
  socket.send(JSON.stringify({t:'sky-state',x:p.x,y:p.y,vx:p.vx,vy:p.vy,face:p.face,glide:p.gliding,
    flip:p.flipT,hook:p.grapple?{x:p.grapple.x,y:p.grapple.y,pulling:p.grapple.mode==='pulling'}:null,checkpoint:p.checkpoint,finished:won,time:elapsed}));
}

function reset(full=false){
  if(full){p.deaths=0;p.checkpoint=0;elapsed=0;startAt=performance.now();won=false;document.querySelector('#win').hidden=true;}
  const c=checkpoints[p.checkpoint];
  Object.assign(p,{x:c.x,y:c.y-p.h,vx:0,vy:0,face:1,onGround:false,wall:0,coyote:0,jumpBuf:0,energy:100,grapple:null,flipT:0,flipDir:1,dead:0,gliding:false});
  cam.x=Math.max(0,Math.min(WORLD_W-W,p.x-W*.35));cam.y=Math.max(0,Math.min(WORLD_H-H,p.y-H*.6));
}

function startGame(){
  sendName();document.querySelector('#start').hidden=true;running=true;reset(true);audio?.resume?.();
}

function jump(){
  if(!running||won)return;
  p.jumpBuf=.12;
}

function rayRect(ox,oy,dx,dy,r,maxDist){
  let near=0,far=maxDist;
  for(const [origin,dir,min,max] of [[ox,dx,r.x,r.x+r.w],[oy,dy,r.y,r.y+r.h]]){
    if(Math.abs(dir)<1e-6){if(origin<min||origin>max)return null;continue;}
    let a=(min-origin)/dir,b=(max-origin)/dir;if(a>b)[a,b]=[b,a];
    near=Math.max(near,a);far=Math.min(far,b);if(near>far)return null;
  }
  return near>5&&near<=maxDist?near:null;
}

// Three beats: attach, launch, release. The release converts the launch angle
// into an upward pop and a visible frontflip without discarding momentum.
function toggleGrapple(target=mouseWorld){
  if(!running||won)return;
  if(p.grapple?.mode==='latched'){
    const dx=p.grapple.x-(p.x+p.w/2),dy=p.grapple.y-(p.y+p.h/2),d=Math.hypot(dx,dy)||1;
    p.grapple.mode='pulling';p.grapple.len=Math.max(18,d);
    p.vx+=dx/d*72;p.vy+=dy/d*72;
    burst(p.x+p.w/2,p.y+p.h/2,'#71def0',8,70);tone(340,.12,'sawtooth',.045,520);return;
  }
  if(p.grapple?.mode==='pulling'){
    const dx=p.grapple.x-(p.x+p.w/2),dy=p.grapple.y-(p.y+p.h/2),d=Math.hypot(dx,dy)||1;
    const upward=Math.max(0,Math.min(1,-dy/d));
    const lift=48+upward*118;
    p.vy=Math.min(p.vy,-lift);p.vx+=dx/d*28;
    p.flipT=.68;p.flipDir=dx<0?-1:1;p.grapple=null;
    burst(p.x+p.w/2,p.y+p.h/2,'#f7d778',10,82);tone(760,.13,'triangle',.045,330);return;
  }
  const ox=p.x+p.w/2,oy=p.y+p.h/2;
  let dx,dy;
  if(target){dx=target.x-ox;dy=target.y-oy;}else{dx=p.face*.78;dy=-.62;}
  const length=Math.hypot(dx,dy)||1;dx/=length;dy/=length;
  let nearest=Infinity;
  for(const r of platforms){const t=rayRect(ox,oy,dx,dy,r,270);if(t!==null&&t<nearest)nearest=t;}
  if(nearest<Infinity){
    const x=ox+dx*nearest,y=oy+dy*nearest;
    p.grapple={x,y,len:Math.max(18,nearest),mode:'latched'};
    tone(620,.09,'square',.035,260);burst(x,y,'#ffd16a',8,55);
  }else tone(130,.05,'square',.02,-35);
}

function key(e,on){
  const k=e.code;
  if(['ArrowLeft','ArrowRight','Space','KeyA','KeyD','KeyE','ShiftLeft','ShiftRight','KeyR'].includes(k))e.preventDefault();
  if(k==='ArrowLeft'||k==='KeyA')keys.left=on;
  if(k==='ArrowRight'||k==='KeyD')keys.right=on;
  if(k==='ShiftLeft'||k==='ShiftRight')keys.glide=on;
  if(k==='Space'&&on&&!e.repeat)jump();
  if(k==='KeyE'&&on&&!e.repeat)toggleGrapple();
  if(k==='KeyR'&&on&&!e.repeat){p.deaths++;reset(false);}
}
addEventListener('keydown',e=>key(e,true));addEventListener('keyup',e=>key(e,false));
function aimFromPointer(e){
  const r=canvas.getBoundingClientRect(),scale=Math.min(r.width/W,r.height/H);
  const insetX=(r.width-W*scale)/2,insetY=(r.height-H*scale)/2;
  const x=Math.max(0,Math.min(W,(e.clientX-r.left-insetX)/scale));
  const y=Math.max(0,Math.min(H,(e.clientY-r.top-insetY)/scale));
  return {x:cam.x+x,y:cam.y+y};
}
canvas.addEventListener('pointermove',e=>{
  mouseWorld=aimFromPointer(e);
});
canvas.addEventListener('pointerdown',e=>{if(e.button===0){e.preventDefault();mouseWorld=aimFromPointer(e);toggleGrapple(mouseWorld);}});
canvas.addEventListener('contextmenu',e=>e.preventDefault());

function bindHold(id,down,up=down){
  const b=document.querySelector(id);
  b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);down(true);});
  b.addEventListener('pointerup',e=>{e.preventDefault();up(false);});b.addEventListener('pointercancel',()=>up(false));
}
bindHold('#left',v=>keys.left=v);bindHold('#right',v=>keys.right=v);bindHold('#glide',v=>keys.glide=v);
document.querySelector('#hook').addEventListener('pointerdown',e=>{e.preventDefault();toggleGrapple();});
document.querySelector('#jump').addEventListener('pointerdown',e=>{e.preventDefault();jump();});
document.querySelector('#startButton').addEventListener('click',startGame);
document.querySelector('#again').addEventListener('click',()=>{running=true;reset(true);});

const hit=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

function burst(x,y,color,count=8,speed=70){
  for(let i=0;i<count;i++){const a=(Math.PI*2*i/count)+Math.random()*.4,s=speed*(.35+Math.random()*.65);particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:.45+Math.random()*.3,color});}
}

function die(){
  if(p.dead||won)return;p.dead=.62;p.grapple=null;p.flipT=0;p.gliding=false;p.deaths++;shake=5;
  burst(p.x+p.w/2,p.y+p.h/2,'#f35d86',14,95);tone(150,.22,'sawtooth',.05,-100);
}

function moveAndCollide(dt){
  p.wall=0;
  p.x+=p.vx*dt;
  for(const r of platforms)if(hit(p,r)){
    if(p.vx>0){p.x=r.x-p.w;p.wall=1;}else if(p.vx<0){p.x=r.x+r.w;p.wall=-1;}p.vx=0;
  }
  p.x=Math.max(0,Math.min(WORLD_W-p.w,p.x));
  const wasGround=p.onGround;p.onGround=false;
  p.y+=p.vy*dt;
  for(const r of platforms)if(hit(p,r)){
    if(p.vy>0){p.y=r.y-p.h;p.vy=0;p.onGround=true;}else if(p.vy<0){p.y=r.y+r.h;p.vy=0;}
  }
  if(p.onGround&&!wasGround){p.energy=100;burst(p.x+p.w/2,p.y+p.h,'#bba7db',4,25);tone(115,.025,'square',.018,10);}
}

function update(dt){
  if(!running||won)return;
  if(p.dead){p.dead-=dt;if(p.dead<=0)reset(false);updateParticles(dt);return;}
  elapsed=(performance.now()-startAt)/1000;
  p.jumpBuf=Math.max(0,p.jumpBuf-dt);p.coyote=p.onGround?.1:Math.max(0,p.coyote-dt);
  const dir=(keys.right?1:0)-(keys.left?1:0);
  if(dir){p.face=dir;p.vx+=dir*(p.onGround?560:330)*dt;}else p.vx*=Math.pow(p.onGround?.0008:.06,dt);
  const max=p.onGround?92:105;p.vx=Math.max(-max,Math.min(max,p.vx));
  if(p.wall&&p.vy>72)p.vy=72;
  if(p.jumpBuf>0&&(p.coyote>0||p.wall)){
    if(p.wall){p.vx=-p.wall*125;p.face=-p.wall;}p.vy=-190;p.onGround=false;p.coyote=0;p.jumpBuf=0;
    burst(p.x+p.w/2,p.y+p.h,'#f5e6d3',5,44);tone(330,.08,'square',.035,160);
  }
  p.gliding=keys.glide&&!p.onGround&&p.energy>0&&(p.vy>-35||p.flipT>0);
  if(p.gliding){p.flipT=0;p.energy=Math.max(0,p.energy-29*dt);p.vy+=85*dt;p.vy=Math.min(52,p.vy);if(dir)p.vx+=dir*65*dt;}
  else p.vy=Math.min(270,p.vy+520*dt);
  p.flipT=Math.max(0,p.flipT-dt);
  if(p.grapple?.mode==='pulling'){
    const h=p.grapple,px=p.x+p.w/2,py=p.y+p.h/2,dx=h.x-px,dy=h.y-py,d=Math.hypot(dx,dy)||1;
    // Grappler propulsion: the cable retracts itself quickly while a strong
    // force accelerates the climber toward the impact point. Releasing the
    // hook does not touch velocity, so all of that speed carries into a glide.
    p.grapple.len=Math.max(18,p.grapple.len-245*dt);
    const pull=1050+Math.min(220,d)*3.2;
    p.vx+=dx/d*pull*dt;p.vy+=dy/d*pull*dt;
    const speed=Math.hypot(p.vx,p.vy),cap=340;if(speed>cap){p.vx=p.vx/speed*cap;p.vy=p.vy/speed*cap;}
    if(dir)p.vx+=dir*55*dt;
  }
  moveAndCollide(dt);
  if(p.grapple?.mode==='pulling'){
    const h=p.grapple,px=p.x+p.w/2,py=p.y+p.h/2,dx=px-h.x,dy=py-h.y,d=Math.hypot(dx,dy)||1;
    if(d>p.grapple.len+4){const fix=d-(p.grapple.len+4);p.x-=dx/d*fix;p.y-=dy/d*fix;const radial=(p.vx*dx+p.vy*dy)/d;if(radial>0){p.vx-=dx/d*radial*.9;p.vy-=dy/d*radial*.9;}}
  }
  for(const s of spikes)if(p.x+p.w>s.x&&p.x<s.x+s.w&&p.y+p.h>s.y-2&&p.y<s.y+9)die();
  if(p.y>WORLD_H+30)die();
  checkpoints.forEach((c,i)=>{if(i>p.checkpoint&&Math.hypot(p.x-c.x,p.y-c.y)<34){p.checkpoint=i;p.energy=100;burst(c.x,c.y,'#71def0',15,75);tone(500,.16,'triangle',.05,500);}});
  if(hit(p,goal))finish();
  updateParticles(dt);
  const tx=Math.max(0,Math.min(WORLD_W-W,p.x-W*.38)),ty=Math.max(0,Math.min(WORLD_H-H,p.y-H*.55));
  cam.x+=(tx-cam.x)*Math.min(1,dt*4.5);cam.y+=(ty-cam.y)*Math.min(1,dt*3.6);shake=Math.max(0,shake-dt*18);
}

function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){const q=particles[i];q.life-=dt;if(q.life<=0){particles.splice(i,1);continue;}q.x+=q.vx*dt;q.y+=q.vy*dt;q.vy+=110*dt;q.vx*=Math.pow(.2,dt);}
}

function finish(){
  if(won)return;won=true;running=false;p.grapple=null;burst(goal.x+8,goal.y,'#ffd16a',28,120);tone(440,.55,'triangle',.06,650);
  document.querySelector('#result').textContent=`time ${formatTime(elapsed)} · ${p.deaths} ${p.deaths===1?'fall':'falls'}. the beacon is lit.`;
  setTimeout(()=>document.querySelector('#win').hidden=false,500);
}

function formatTime(t){const m=Math.floor(t/60),s=(t%60).toFixed(1).padStart(4,'0');return `${String(m).padStart(2,'0')}:${s}`;}

function drawBackground(ox,oy){
  const grad=g.createLinearGradient(0,0,0,H);grad.addColorStop(0,'#21183f');grad.addColorStop(.58,'#654d8a');grad.addColorStop(1,'#e58d73');g.fillStyle=grad;g.fillRect(0,0,W,H);
  g.fillStyle='#f7d778';for(const s of stars){const x=Math.floor(s.x-ox*.08)%WORLD_W,y=Math.floor(s.y-oy*.05);if(x>-2&&x<W+2&&y<H)g.fillRect(x,y,s.s,s.s);}
  mountain(oy,ox*.13,154,'#3d365e',[0,14,38,-18,68,8,104,-42,140,0,180,-22,225,12,270,-55,320,-8,384,-35,430,12]);
  mountain(oy,ox*.28,181,'#292744',[0,12,44,-30,85,2,126,-54,170,-5,215,-32,260,8,315,-58,357,-6,405,-28,460,15]);
  g.fillStyle='#17172d';g.fillRect(0,H-20,H*3,20);
}
function mountain(oy,px,base,color,pts){g.fillStyle=color;g.beginPath();g.moveTo(-20,H);for(let i=0;i<pts.length;i+=2)g.lineTo(pts[i]-((px%90)+90)%90,base+pts[i+1]-oy*.05);g.lineTo(W+20,H);g.closePath();g.fill();}

function drawWorld(){
  const sx=shake?(Math.random()-.5)*shake:0,sy=shake?(Math.random()-.5)*shake:0,ox=Math.floor(cam.x-sx),oy=Math.floor(cam.y-sy);
  drawBackground(ox,oy);g.save();g.translate(-ox,-oy);
  g.fillStyle='#100f22';g.fillRect(0,410,WORLD_W,50);
  for(const r of platforms){g.fillStyle='#29243d';g.fillRect(r.x,r.y,r.w,r.h);g.fillStyle='#8869a5';g.fillRect(r.x,r.y,r.w,3);g.fillStyle='#4f426c';for(let x=r.x+9;x<r.x+r.w;x+=19)g.fillRect(x,r.y+9+(x%4)*5,3,3);g.fillStyle='#17162b';g.fillRect(r.x+r.w-3,r.y+5,3,r.h-5);}
  for(const s of spikes){g.fillStyle='#e8e1ec';for(let x=s.x;x<s.x+s.w;x+=8){g.beginPath();g.moveTo(x,s.y);g.lineTo(x+4,s.y-9);g.lineTo(x+8,s.y);g.fill();}}
  checkpoints.forEach((c,i)=>{g.fillStyle=i<=p.checkpoint?'#71def0':'#64577c';g.fillRect(c.x,c.y-28,2,28);g.fillRect(c.x+2,c.y-27,12,7);if(i===p.checkpoint){g.globalAlpha=.18;g.fillStyle='#71def0';g.fillRect(c.x-8,c.y-36,28,40);g.globalAlpha=1;}});
  g.fillStyle='#6a405b';g.fillRect(goal.x+8,goal.y,2,goal.h);g.fillStyle='#ffd16a';g.fillRect(goal.x-1,goal.y,10,10);g.fillStyle='#fff2ad';g.fillRect(goal.x+2,goal.y+2,4,4);g.globalAlpha=.15;g.fillStyle='#ffd16a';g.fillRect(goal.x-8,goal.y-9,28,28);g.globalAlpha=1;
  g.font='7px ui-monospace,monospace';g.fillStyle='#d9caec';g.fillText('tap e: lock · boost · flip',172,302);g.fillText('release angle sets height',273,264);g.fillText('hold shift to glide',1045,184);
  if(p.grapple){const h=p.grapple,px=p.x+p.w/2,py=p.y+p.h/2;g.strokeStyle=h.mode==='pulling'?'#ffd16a':'#71def0';g.lineWidth=h.mode==='pulling'?2:1;g.beginPath();g.moveTo(h.x,h.y);g.quadraticCurveTo((h.x+px)/2+4,(h.y+py)/2+5,px,py);g.stroke();g.fillStyle=h.mode==='pulling'?'#fff1a7':'#b8fbff';g.fillRect(Math.round(h.x)-2,Math.round(h.y)-2,5,5);g.fillStyle='#8b5357';g.fillRect(Math.round(h.x)-1,Math.round(h.y)-1,3,3);}
  for(const q of particles){g.globalAlpha=Math.min(1,q.life*2);g.fillStyle=q.color;g.fillRect(Math.round(q.x),Math.round(q.y),2,2);}g.globalAlpha=1;
  for(const r of remotes.values())drawRemote(r);
  if(!p.dead)drawPlayer();g.restore();
}

function drawPlayer(){
  const x=Math.round(p.x),y=Math.round(p.y),f=p.face;
  g.save();
  if(p.flipT>0){const turn=(1-p.flipT/.68)*Math.PI*2*p.flipDir;g.translate(x+4.5,y+7.5);g.rotate(turn);g.translate(-x-4.5,-y-7.5);}
  if(p.gliding){g.fillStyle='#69dbea';g.beginPath();g.moveTo(x+4,y+5);g.lineTo(x-9*f,y+11);g.lineTo(x+3,y+12);g.fill();g.fillStyle='#a5f0ee';g.fillRect(x-3*f,y+8,7,2);}
  g.fillStyle='#302542';g.fillRect(x+2,y+9,6,6);g.fillStyle='#ed5579';g.fillRect(x+1,y+5,8,7);g.fillStyle='#f3d9c7';g.fillRect(x+2,y+1,6,5);g.fillStyle='#36233e';g.fillRect(x+1,y,7,2);g.fillRect(x+(f>0?7:1),y+2,2,2);g.fillStyle='#fff2d6';g.fillRect(x+(f>0?6:3),y+3,1,1);g.fillStyle='#382a50';g.fillRect(x+1,y+14,3,2);g.fillRect(x+6,y+14,3,2);
  g.restore();
}

function drawRemote(r){
  const x=Math.round(r.x),y=Math.round(r.y),f=r.face||1;
  if(r.hook){g.strokeStyle=r.hook.pulling?'#ffd16a':(r.color||'#70def0');g.lineWidth=r.hook.pulling?2:1;g.beginPath();g.moveTo(r.hook.x,r.hook.y);g.lineTo(x+5,y+7);g.stroke();g.fillStyle='#fff1a7';g.fillRect(Math.round(r.hook.x)-1,Math.round(r.hook.y)-1,3,3);}
  g.save();
  if(r.flipping&&!r.gliding){const age=Math.min(.68,(performance.now()-(r.flipStarted||0))/1000);g.translate(x+4.5,y+7.5);g.rotate(age/.68*Math.PI*2*f);g.translate(-x-4.5,-y-7.5);}
  if(r.gliding){g.globalAlpha=.85;g.fillStyle='#71def0';g.beginPath();g.moveTo(x+4,y+5);g.lineTo(x-9*f,y+11);g.lineTo(x+3,y+12);g.fill();g.globalAlpha=1;}
  g.fillStyle='#29243d';g.fillRect(x+2,y+9,6,6);g.fillStyle=r.color||'#9a7cff';g.fillRect(x+1,y+5,8,7);g.fillStyle='#ead4c7';g.fillRect(x+2,y+1,6,5);g.fillStyle='#30203b';g.fillRect(x+1,y,7,2);g.fillRect(x+(f>0?7:1),y+2,2,2);g.fillStyle='#382a50';g.fillRect(x+1,y+14,3,2);g.fillRect(x+6,y+14,3,2);
  g.restore();
  g.font='6px ui-monospace,monospace';g.textAlign='center';g.fillStyle='#fff';g.fillText(r.finished?`${r.name} ✓`:r.name,x+5,y-4);g.textAlign='left';
}

function updateHud(){document.querySelector('#clock').textContent=formatTime(elapsed);document.querySelector('#energy .fill').style.width=`${p.energy}%`;document.querySelector('#checkpoint').textContent=`pass ${String(p.checkpoint+1).padStart(2,'0')} · ${p.deaths} fall${p.deaths===1?'':'s'}`;}

function frame(now){const dt=Math.min(.025,(now-last)/1000||0);last=now;update(dt);networkStep(dt);drawWorld();updateHud();requestAnimationFrame(frame);}reset(true);connectSky();requestAnimationFrame(frame);
