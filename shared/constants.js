// Single source of truth. Imported by BOTH server and browser so client
// prediction can never drift from the authoritative sim.
export const TICK_HZ      = 30;
export const DT           = 1 / TICK_HZ;

export const ARENA_HALF   = 25;          // flat plain, -25..25 on X and Z
export const WALL_HEIGHT  = 8.5;         // tall urban boundary: players feel inside a map

export const TEAM_COLORS = Object.freeze({
  red: '#ff5f69',
  blue: '#55a9ff',
});

// Shared arena layout. These values are imported by the browser for rendering
// and by the deterministic simulation/server for collision and bullet blocking.
// `w` and `d` are full dimensions; boxes sit on the ground at y=0.
export const OBSTACLES = Object.freeze([
  // Northern and southern skylines. The gaps between these blocks form long.
  { x:-14.5,z:-18.2,w:8.5,d:8.2,h:8.2,kind:'house' },
  { x: -2.0,z:-19.2,w:9.0,d:5.2,h:9.4,kind:'house' },
  { x: 14.5,z:-18.2,w:8.5,d:8.2,h:7.8,kind:'house' },
  { x:-14.5,z: 18.2,w:8.5,d:8.2,h:7.8,kind:'house' },
  { x:  2.0,z: 19.2,w:9.0,d:5.2,h:9.0,kind:'house' },
  { x: 14.5,z: 18.2,w:8.5,d:8.2,h:8.5,kind:'house' },

  // Offset central blocks create a bent mid lane instead of one open sightline.
  { x:-7.5,z:-5.2,w:7.0,d:7.2,h:8.0,kind:'house' },
  { x: 7.5,z: 5.2,w:7.0,d:7.2,h:8.0,kind:'house' },

  // Spawn-courtyard walls: centre, upper and lower exits stay open.
  { x:-17.8,z:-6.2,w:1.1,d:7.2,h:5.6,kind:'wall' },
  { x:-17.8,z: 6.2,w:1.1,d:7.2,h:5.6,kind:'wall' },
  { x: 17.8,z:-6.2,w:1.1,d:7.2,h:5.6,kind:'wall' },
  { x: 17.8,z: 6.2,w:1.1,d:7.2,h:5.6,kind:'wall' },

  // Chicanes break the two long routes into contestable corners.
  { x:-1.0,z:-11.1,w:1.1,d:4.0,h:5.2,kind:'wall' },
  { x: 5.0,z:-10.0,w:1.1,d:3.8,h:5.2,kind:'wall' },
  { x: 1.0,z: 11.1,w:1.1,d:4.0,h:5.2,kind:'wall' },
  { x:-5.0,z: 10.0,w:1.1,d:3.8,h:5.2,kind:'wall' },
  { x:-1.0,z: -1.0,w:4.8,d:1.0,h:4.7,kind:'wall' },
  { x: 1.0,z:  1.0,w:4.8,d:1.0,h:4.7,kind:'wall' },

  // Jumpable cover marks the approaches without closing them.
  { x:-12.2,z:0,w:2.5,d:2.5,h:1.45,kind:'crate' },
  { x: 12.2,z:0,w:2.5,d:2.5,h:1.45,kind:'crate' },
  { x: 0,z:-13.7,w:2.2,d:2.2,h:1.35,kind:'crate' },
  { x: 0,z: 13.7,w:2.2,d:2.2,h:1.35,kind:'crate' },
]);

// Wedges rise along `axis` in the sign given by `dir`. `width` is across the
// slope, `length` is along it, and `height` is the tall edge.
export const RAMPS = Object.freeze([
  { x:-17.0,z:0,width:3.4,length:4.8,height:1.35,axis:'x',dir: 1 },
  { x: 17.0,z:0,width:3.4,length:4.8,height:1.35,axis:'x',dir:-1 },
  { x: 9.0,z:-10.4,width:3.2,length:4.8,height:1.45,axis:'x',dir: 1 },
  { x:-9.0,z: 10.4,width:3.2,length:4.8,height:1.45,axis:'x',dir:-1 },
]);

// Climbable wall ladders. x/z sit on the house face; nx/nz point away from
// the wall. Every solid house has one route to its roof.
export const LADDERS = Object.freeze([
  { x:-14.5,z:-14.1,nx: 0,nz: 1,width:1.35,height:8.2 },
  { x: -2.0,z:-16.6,nx: 0,nz: 1,width:1.35,height:9.4 },
  { x: 14.5,z:-14.1,nx: 0,nz: 1,width:1.35,height:7.8 },
  { x:-14.5,z: 14.1,nx: 0,nz:-1,width:1.35,height:7.8 },
  { x:  2.0,z: 16.6,nx: 0,nz:-1,width:1.35,height:9.0 },
  { x: 14.5,z: 14.1,nx: 0,nz:-1,width:1.35,height:8.5 },
  { x: -4.0,z: -5.2,nx: 1,nz: 0,width:1.35,height:8.0 },
  { x:  4.0,z:  5.2,nx:-1,nz: 0,width:1.35,height:8.0 },
]);

export const PLAYER_RADIUS  = 0.5;
export const PLAYER_SPEED   = 6;         // walking pace
export const SPRINT_MULT    = 1.75;      // shift -> 10.5 u/s
export const ADS_MULT       = 0.5;       // scoping slows you down
export const SNEAK_MULT     = 0.42;      // ctrl/C -> 2.52 u/s, and silent
export const MAX_SPEED      = PLAYER_SPEED * SPRINT_MULT;
// Velocity eases toward a target rather than accel-vs-friction, so the speeds
// above are the speeds you actually get. These are rates (1/s), not forces.
export const ACCEL_RATE     = 14;        // how fast you reach top speed on the ground
export const AIR_RATE       = 2.2;       // much slower airborne -> momentum carries
export const PLAYER_EYE     = 1.5;       // where shots leave from
// Fully-scoped third-person camera. The server uses these same values to turn
// the centre of the scope into an authoritative world-space aim point.
export const ADS_CAMERA_BACK  = 2.9;
export const ADS_CAMERA_RIGHT = 0.78;
export const ADS_CAMERA_UP    = 0.30;
export const AIM_CONVERGENCE  = 40;
// Two server-side hit zones. The body stays forgiving, while the smaller head
// volume sits over the Soldier model's skull and enables precise headshots.
export const BODY_CENTER    = 0.86;
export const BODY_RADIUS    = 0.70;
export const HEAD_CENTER    = 1.62;
export const HEAD_RADIUS    = 0.30;

// Tuned so the arc reads at walking pace: ~0.9s of airtime rather than 0.7s.
// Real gravity looks wrong at this character scale - game jumps float.
// Dodge roll: double-tap a movement key. Fast, brief, and on a cooldown so it
// can't be spammed as a movement upgrade.
export const ROLL_SPEED     = 15;
export const ROLL_TIME      = 0.42;      // seconds of travel
export const ROLL_CD        = 1.1;       // seconds before you can roll again
export const ROLL_LAND_BUFFER = 0.24;    // roll this early before impact still counts
export const ROLL_LAND_GRACE  = 0.24;    // or this late after impact

export const GRAVITY        = 15;        // units/s^2
export const JUMP_SPEED     = 6.8;       // ~1.54 units apex, ~0.91s airtime
export const LADDER_SPEED   = 4.2;
export const FALL_SAFE_SPEED = 9;        // normal jumps and crate drops are safe
export const FALL_DAMAGE_SCALE = 10;     // roof falls hurt badly but are survivable

// Authoritative loadout. Rifle ADS is an exact ray; the shotgun keeps a pellet
// cone while scoped, but it tightens substantially. Damage is per pellet.
export const WEAPONS = Object.freeze({
  1: Object.freeze({ id:1, key:'rifle',   name:'RIFLE', canAds:true, pellets:1, damage:20, headDamage:100,
                     range:70, cooldown:150, spreadHip:.055, spreadAds:0,
                     mag:30, reloadMs:1900 }),
  2: Object.freeze({ id:2, key:'shotgun', name:'SHOTGUN', canAds:false, pellets:9, damage:12, headDamage:24,
                     range:32, cooldown:850, spreadHip:.115, spreadAds:.065,
                     mag:6, reloadMs:2400 }),
});
export const DEFAULT_WEAPON = 1;
export const SPREAD_HIP     = WEAPONS[1].spreadHip;
export const SPREAD_ADS     = WEAPONS[1].spreadAds;
export const SPREAD_MOVE    = 0.030;     // added, scaled by how fast you're going
export const SPREAD_AIR     = 0.045;     // added while off the ground

export const MAX_HP         = 100;
export const GUN_DAMAGE     = WEAPONS[1].damage;       // compatibility aliases
export const HEADSHOT_DAMAGE= WEAPONS[1].headDamage;
export const GUN_RANGE      = WEAPONS[1].range;
export const GUN_COOLDOWN   = WEAPONS[1].cooldown;
export const RESPAWN_MS     = 5000;

export const PITCH_MIN = -1.15;          // radians, looking up/down limits
export const PITCH_MAX =  0.95;

export const INTERP_DELAY_MS = 100;
export const MAX_INPUT_QUEUE = 10;
