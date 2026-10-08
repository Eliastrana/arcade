// Lightweight procedural battlefield audio. Everything is synthesized with the
// Web Audio API, so the game needs no sound downloads and effects start fast.
export class ArenaAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.players = new Map();
    this.listener = { x:0, y:1.5, z:0, rx:1, rz:0 };
    try { this.enabled = localStorage.getItem('arena-sound') !== 'off'; }
    catch { this.enabled = true; }
  }

  isEnabled() { return this.enabled; }

  arm() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.62;
      this.master.connect(this.ctx.destination);

      const seconds = 2, data = new Float32Array(this.ctx.sampleRate * seconds);
      for (let i=0;i<data.length;i++) data[i] = Math.random()*2-1;
      this.noise = this.ctx.createBuffer(1,data.length,this.ctx.sampleRate);
      this.noise.copyToChannel(data,0);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{});
  }

  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem('arena-sound', this.enabled ? 'on' : 'off'); } catch {}
    if (this.enabled) this.arm();
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(this.enabled ? .62 : 0, this.ctx.currentTime, .025);
    }
  }

  setListener(pos, right) {
    this.listener.x=pos.x; this.listener.y=pos.y; this.listener.z=pos.z;
    this.listener.rx=right.x; this.listener.rz=right.z;
  }

  _route(pos, volume, isSelf=false) {
    if (!this.ctx || !this.enabled || this.ctx.state !== 'running') return null;
    const dx=pos.x-this.listener.x, dy=(pos.y||0)-this.listener.y, dz=pos.z-this.listener.z;
    const dist=Math.hypot(dx,dy,dz);
    const attenuation=isSelf ? 1 : 1/(1+Math.max(0,dist-2)*.085);
    const gain=this.ctx.createGain();
    gain.gain.value=volume*attenuation;
    if (this.ctx.createStereoPanner) {
      const pan=this.ctx.createStereoPanner();
      const side=dx*this.listener.rx+dz*this.listener.rz;
      pan.pan.value=isSelf ? 0 : Math.max(-.85,Math.min(.85,side/Math.max(5,dist)));
      gain.connect(pan).connect(this.master);
    } else gain.connect(this.master);
    return gain;
  }

  _noiseBurst(route, { duration=.1, frequency=900, type='bandpass', attack=.003, delay=0 }={}) {
    if (!route) return;
    const t=this.ctx.currentTime+delay;
    const src=this.ctx.createBufferSource(); src.buffer=this.noise;
    const filter=this.ctx.createBiquadFilter(); filter.type=type; filter.frequency.value=frequency;
    const env=this.ctx.createGain();
    env.gain.setValueAtTime(.001,t);
    env.gain.exponentialRampToValueAtTime(1,t+attack);
    env.gain.exponentialRampToValueAtTime(.001,t+duration);
    src.connect(filter).connect(env).connect(route);
    src.start(t,Math.random()*1.5,duration+.02); src.stop(t+duration+.03);
  }

  _tone(route, { from=120, to=55, duration=.12, volume=.25, wave='triangle', delay=0 }={}) {
    if (!route) return;
    const t=this.ctx.currentTime+delay, osc=this.ctx.createOscillator(), env=this.ctx.createGain();
    osc.type=wave; osc.frequency.setValueAtTime(from,t); osc.frequency.exponentialRampToValueAtTime(to,t+duration);
    env.gain.setValueAtTime(volume,t); env.gain.exponentialRampToValueAtTime(.001,t+duration);
    osc.connect(env).connect(route); osc.start(t); osc.stop(t+duration+.02);
  }

  gunshot(pos, isSelf=false, weapon=1) {
    const shotgun=weapon===2;
    const route=this._route(pos,isSelf?(shotgun ? .92 : .72):(shotgun ? .78 : .62),isSelf); if (!route) return;
    this._noiseBurst(route,{duration:shotgun ? .18 : .115,frequency:shotgun?1050:1450,type:'bandpass',attack:.001});
    this._noiseBurst(route,{duration:shotgun ? .34 : .21,frequency:shotgun?270:380,type:'lowpass',attack:.001});
    this._tone(route,{from:shotgun?118:145,to:shotgun?38:48,duration:shotgun ? .28 : .17,
      volume:shotgun ? .56 : .38,wave:'sawtooth'});
    if (shotgun) this._noiseBurst(route,{duration:.07,frequency:1850,type:'bandpass',attack:.002,delay:.19});
  }

  // Shooter-only body-hit confirmation. It starts after the loudest part of
  // the weapon report and occupies a higher band, making it easy to hear.
  hit() {
    const pos={x:this.listener.x,y:this.listener.y,z:this.listener.z};
    const route=this._route(pos,.82,true); if (!route) return;
    const delay=.065;
    this._noiseBurst(route,{duration:.038,frequency:3200,type:'bandpass',attack:.001,delay});
    this._tone(route,{from:760,to:510,duration:.14,volume:.54,wave:'square',delay});
    this._tone(route,{from:190,to:82,duration:.17,volume:.34,wave:'sine',delay:.072});
  }

  // Shooter-only headshot confirmation: an actual bell-like ding built from
  // a fundamental and inharmonic sine partials, with a bright strike and a
  // long decay. It begins after the gunshot transient so it cannot be masked.
  headshot() {
    const pos={x:this.listener.x,y:this.listener.y,z:this.listener.z};
    const route=this._route(pos,.98,true); if (!route) return;
    const delay=.072;
    this._noiseBurst(route,{duration:.032,frequency:5600,type:'highpass',attack:.001,delay});
    const t=this.ctx.currentTime+delay;
    for (const [freq,vol,dur] of [
      [1046.5,.76,.82], [1055,.24,.72], [2104,.38,.58],
      [3075,.22,.43], [4350,.12,.30], [523.25,.18,.48],
    ]) {
      const osc=this.ctx.createOscillator(), env=this.ctx.createGain();
      osc.type='sine';
      osc.frequency.setValueAtTime(freq,t);
      env.gain.setValueAtTime(.001,t);
      env.gain.exponentialRampToValueAtTime(vol,t+.0025);
      env.gain.exponentialRampToValueAtTime(.001,t+dur);
      osc.connect(env).connect(route); osc.start(t); osc.stop(t+dur+.02);
    }
  }

  /** Trigger pulled on an empty or reloading weapon. */
  dryFire(pos, isSelf=false) {
    const route=this._route(pos,isSelf ? .5 : .3,isSelf); if (!route) return;
    this._noiseBurst(route,{duration:.028,frequency:2700,type:'bandpass',attack:.001});
    this._tone(route,{from:330,to:170,duration:.05,volume:.2,wave:'square'});
  }

  // Three clacks - magazine out, magazine in, bolt - spaced across the real
  // reload duration so the audio lines up with the animation for any weapon.
  reload(pos, isSelf=false, totalMs=1900) {
    const route=this._route(pos,isSelf ? .46 : .3,isSelf); if (!route) return;
    const s=Math.max(.3,totalMs/1000);
    for (const [at,freq,from,to,vol] of [
      [.06,1500,270,150,.20],   // magazine released
      [.55, 900,185,105,.26],   // fresh magazine seated
      [.86,2100,430,235,.20],   // bolt released
    ]) {
      this._noiseBurst(route,{duration:.055,frequency:freq,type:'bandpass',attack:.001,delay:s*at});
      this._tone(route,{from,to,duration:.075,volume:vol,wave:'square',delay:s*at});
    }
  }

  footstep(pos, sprint=false, isSelf=false) {
    const route=this._route(pos,sprint ? .23 : .16,isSelf); if (!route) return;
    this._noiseBurst(route,{duration:sprint?.075:.06,frequency:sprint?1050:760,type:'lowpass',attack:.002});
    this._tone(route,{from:sprint?105:82,to:48,duration:.075,volume:.24,wave:'sine'});
  }

  jump(pos, isSelf=false) {
    const route=this._route(pos,.22,isSelf); if (!route) return;
    this._noiseBurst(route,{duration:.14,frequency:720,type:'bandpass',attack:.004});
    this._tone(route,{from:72,to:118,duration:.11,volume:.18,wave:'triangle'});
  }

  roll(pos, isSelf=false) {
    const route=this._route(pos,.28,isSelf); if (!route) return;
    const t=this.ctx.currentTime, src=this.ctx.createBufferSource(); src.buffer=this.noise;
    const filter=this.ctx.createBiquadFilter(); filter.type='bandpass';
    filter.frequency.setValueAtTime(420,t); filter.frequency.exponentialRampToValueAtTime(1500,t+.18);
    const env=this.ctx.createGain();
    env.gain.setValueAtTime(.001,t); env.gain.exponentialRampToValueAtTime(.8,t+.025);
    env.gain.exponentialRampToValueAtTime(.001,t+.29);
    src.connect(filter).connect(env).connect(route); src.start(t,Math.random()*1.4,.31); src.stop(t+.32);
  }

  fallImpact(pos, damage=0, isSelf=false) {
    const strength=Math.max(.25,Math.min(1,damage/75));
    const route=this._route(pos,.28+.34*strength,isSelf); if (!route) return;
    this._noiseBurst(route,{duration:.10+.10*strength,frequency:260,type:'lowpass',attack:.001});
    this._tone(route,{from:105,to:38,duration:.16+.10*strength,volume:.34+.28*strength,wave:'sine'});
  }

  updatePlayer(id, { pos, speed, onGround, vy=0, rollT=0, alive=true, isSelf=false, sneaking=false,
                     reloadLeft=0, reloadTotal=0, now }) {
    let p=this.players.get(id);
    if (!p) {
      p={ ground:onGround, rolling:rollT>0, reloading:reloadLeft>0, nextStep:now+120 };
      this.players.set(id,p);
    }
    if (!alive) {
      p.ground=false; p.rolling=false; p.reloading=false; p.nextStep=now+160;
      return;
    }

    const rolling=rollT>0;
    if (p.ground && !onGround && vy>.5) this.jump(pos,isSelf);
    if (!p.rolling && rolling) this.roll(pos,isSelf);

    // Fires once on the transition, so it works for remote players too - we
    // only ever see their reload as a countdown in the snapshot.
    const reloading=reloadLeft>0;
    if (!p.reloading && reloading) this.reload(pos,isSelf,reloadTotal||1900);
    p.reloading=reloading;

    // Sneaking is the whole point of the mechanic: no footsteps at all, for
    // anyone. The flag is authoritative and networked, so a sneaking player is
    // silent on EVERY client, not just their own.
    if (sneaking) p.nextStep = now + 200;
    else if (onGround && !rolling && speed>1.15 && now>=p.nextStep) {
      const sprint=speed>7.4;
      this.footstep(pos,sprint,isSelf);
      p.nextStep=now+(sprint?255:430)*(0.94+Math.random()*.12);
    } else if (speed<=1.15) p.nextStep=Math.max(p.nextStep,now+90);

    p.ground=onGround; p.rolling=rolling;
  }

  removePlayer(id) { this.players.delete(id); }
}
