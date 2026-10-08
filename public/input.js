// Keyboard, mouse-look and fire state. Knows nothing about rendering or the net.
import { PITCH_MIN, PITCH_MAX } from '/shared/constants.js';

const KEYS = {
  KeyW:'up', ArrowUp:'up', KeyS:'down', ArrowDown:'down',
  KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
  Space:'jump', ShiftLeft:'sprint', ShiftRight:'sprint',
  ControlLeft:'sneak', ControlRight:'sneak', KeyC:'sneak',
};
const held = { up:false, down:false, left:false, right:false, jump:false, sprint:false, sneak:false };
export const view = { yaw: 0, pitch: 0 };
const SENS = 0.0022;
let firing = false;
let locked = false;
let aiming = false;
let weapon = 1;

const chooseWeapon = (slot) => {
  if (slot !== 1 && slot !== 2) return;
  weapon = slot;
  if (weapon === 2) aiming = false;
  dispatchEvent(new CustomEvent('weaponchange', { detail:{ weapon } }));
};

// double-tap a movement key to roll
const ROLL_CODE = { up:1, down:2, left:3, right:4 };
const TAP_WINDOW = 280;                 // ms
const lastTap = {};
let rollReq = 0;
let reloadReq = false;

addEventListener('keydown', e => {
  const k = KEYS[e.code];
  if (k) {
    if (!e.repeat && ROLL_CODE[k]) {    // ignore auto-repeat, or holding a key would roll
      const now = performance.now();
      if (lastTap[k] && now - lastTap[k] < TAP_WINDOW) { rollReq = ROLL_CODE[k]; lastTap[k] = 0; }
      else lastTap[k] = now;
    }
    held[k] = true; e.preventDefault();
  }
  if (e.code === 'KeyR' && !e.repeat) { reloadReq = true; e.preventDefault(); }
  if (e.code === 'KeyF') { firing = true; e.preventDefault(); }   // fallback fire
  if (e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1') { chooseWeapon(1); e.preventDefault(); }
  if (e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2') { chooseWeapon(2); e.preventDefault(); }
});
addEventListener('keyup', e => {
  const k = KEYS[e.code]; if (k) { held[k] = false; e.preventDefault(); }
  if (e.code === 'KeyF') { firing = false; e.preventDefault(); }
});
addEventListener('blur', () => { for (const k in held) held[k] = false; firing = false; aiming = false; });
addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) < 1) return;
  // Direction maps to a slot rather than toggling on every wheel event, so a
  // Mac trackpad's inertial tail cannot flicker rapidly between both weapons.
  chooseWeapon(e.deltaY > 0 ? 2 : 1);
  e.preventDefault();
}, { passive:false });

const clampPitch = () => { view.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, view.pitch)); };

/** Wire mouse-look + firing to the canvas. Pointer lock is requested on click. */
export function attachLook(el, onLockChange = () => {}) {
  // Listen on the document, not just the canvas: overlays and future HUD
  // layers sit on top, and the click still has to reach pointer lock.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.hud, button, input, a')) return;   // leave real controls alone
    if (document.pointerLockElement !== el) {
      const r = el.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});   // Safari rejects; ignore
    }
  });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === el;
    if (!locked) firing = false;
    onLockChange(locked);
  });
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    const s = SENS * (aiming ? 0.45 : 1);     // finer control while scoped
    // yaw decreases as the mouse moves right, because forward = (-sin,-cos)
    view.yaw   -= e.movementX * s;
    view.pitch -= e.movementY * s;
    clampPitch();
  });
  addEventListener('mousedown', e => {
    if (e.button === 0 && locked) firing = true;
    if (e.button === 2) { aiming = weapon === 1; e.preventDefault(); }
  });
  addEventListener('mouseup', e => {
    if (e.button === 0) firing = false;
    if (e.button === 2) aiming = false;
  });
  // right-drag must not open the browser menu mid-firefight
  el.addEventListener('contextmenu', e => e.preventDefault());

  // Fallback for contexts that forbid pointer lock (embedded frames, some
  // policies): drag with the left button to aim, Space to shoot.
  let drag = null;
  el.addEventListener('mousedown', e => { if (!locked && e.button === 0) drag = e; });
  addEventListener('mousemove', (e) => {
    if (locked || !drag) return;
    view.yaw   -= (e.clientX - drag.clientX) * SENS * 1.4;
    view.pitch -= (e.clientY - drag.clientY) * SENS * 1.4;
    clampPitch();
    drag = e;
  });
  addEventListener('mouseup', () => { drag = null; });

  // touch: drag anywhere on the canvas to look
  let last = null;
  el.addEventListener('touchstart', e => { last = e.touches[0]; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (last) {
      view.yaw   -= (t.clientX - last.clientX) * SENS * 1.7;
      view.pitch -= (t.clientY - last.clientY) * SENS * 1.7;
      clampPitch();
    }
    last = t;
  }, { passive: true });
  el.addEventListener('touchend', () => { last = null; }, { passive: true });
}

/**
 * Consumed once per tick: the roll is an edge-triggered event, not a held
 * state, so reading it clears it. Prediction replays it safely because the
 * server's cooldown is part of the shared sim.
 */
export const readInput = () => {
  const roll = rollReq; rollReq = 0;
  return { ...held, yaw: view.yaw, pitch: view.pitch, ads: aiming && weapon === 1, roll, weapon };
};
export const isFiring  = () => firing;
export const isLocked  = () => locked;
export const isAiming  = () => aiming && weapon === 1;
export const isSneaking = () => held.sneak;
export const getWeapon = () => weapon;
export const setWeapon = (slot) => chooseWeapon(slot);
export const setAiming  = (on) => { aiming = !!on && weapon === 1; };
export const setVirtual = (dir, on) => { if (dir in held) held[dir] = on; };
export const setFiring  = (on) => { firing = on; };
export const requestRoll = (kind) => { rollReq = kind; };   // touch button hook
/** Edge-triggered like the roll: reading it clears it. */
export const takeReload = () => { const r = reloadReq; reloadReq = false; return r; };
export const requestReload = () => { reloadReq = true; };
