/**
 * Three.js rendering. Reads sim state, never writes it (NFR-7). World
 * geometry is derived from the same TrackRuntime the sim collides against,
 * converted to floats at this boundary. The world is a swappable, fully
 * disposed THREE.Group so rooms can change tracks freely.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  getTrack,
  fxToFloat,
  isItemActive,
  MAX_SHELLS,
  MAX_OILS,
  SHELL_RADIUS,
  OIL_RADIUS,
  SPIN_OUT_TICKS,
  type GameState,
  type TrackRuntime,
  type Vec2Fx,
} from '@mk/sim';
import { lerpAngle, type KartRender } from './game.js';
import { Terrain } from './terrain.js';
import { sponsorFor, titleSponsor, type Sponsor } from './sponsors.js';

export const KART_COLORS = ['#ff4757', '#2e86ff', '#ffd23f', '#3fd06b'];

const toV3 = (x: number, y: number) => new THREE.Vector3(fxToFloat(x), 0, -fxToFloat(y));
const yawOf = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(-(b.z - a.z), b.x - a.x);

// every texture slot a kart material can hold; disposed with the mesh unless the
// texture is shared and scene-owned (env/detail maps live longer than any kart)
const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
] as const;

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as Partial<THREE.Mesh & THREE.Sprite>;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const slots = m as unknown as Record<string, THREE.Texture | null | undefined>;
        for (const slot of TEXTURE_SLOTS) {
          const tex = slots[slot];
          // shared scene-owned textures (env, detail maps) outlive any one kart
          if (tex && !tex.userData?.shared) tex.dispose();
        }
        m.dispose();
      }
    }
  });
}

function checkerTexture(cols: number, rows: number, a = '#ffffff', b = '#111111'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = cols * 16;
  c.height = rows * 16;
  const g = c.getContext('2d')!;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? a : b;
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function chevronTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20, 26, 40, 0.75)';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffd23f';
  for (const off of [8, 56]) {
    g.beginPath();
    g.moveTo(off, 20);
    g.lineTo(off + 36, 64);
    g.lineTo(off, 108);
    g.lineTo(off + 22, 108);
    g.lineTo(off + 58, 64);
    g.lineTo(off + 22, 20);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cloudTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  // overlapping soft blobs read as one cumulus puff
  const blobs: [number, number, number][] = [
    [70, 80, 38],
    [110, 64, 46],
    [150, 78, 40],
    [185, 88, 30],
    [120, 92, 50],
  ];
  for (const [x, y, r] of blobs) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// shared soft-edged dot for every Points system (square points read as confetti
// even when they aren't); lazy so module import never touches the DOM early
let softDot: THREE.Texture | null = null;
function softDotTexture(): THREE.Texture {
  if (softDot) return softDot;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  softDot = new THREE.CanvasTexture(c);
  return softDot;
}

function kerbTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8483f';
  g.fillRect(0, 0, 32, 16);
  g.fillStyle = '#f2efe6';
  g.fillRect(32, 0, 32, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

interface SurfaceMaps {
  map: THREE.Texture;
  normal: THREE.Texture;
}
const SURFACE_CACHE = new Map<string, SurfaceMaps>();

/**
 * Shared, scene-owned surface textures (lazy, cached by URL, reused across every
 * world/decor rebuild). Higgsfield ships only the colour map; the tangent-space
 * normal map is derived in-canvas from luminance height, so the surface actually
 * catches the sun. Marked `userData.shared` so `disposeTree` never frees these
 * when a track's world group is torn down between races.
 *
 * `lift` raises the colour toward white (0 = untouched, 1 = pure white): a dark
 * photographic albedo multiplied by a theme tint would crush every track to the
 * same near-black, so we lift the colour and let the *normal* map carry the
 * relief while the theme colour keeps the palette. `repeat`/`repeatY` is the UV
 * tiling — world-coordinate UVs on the ground (small values), 0..1 on decor.
 */
function surfaceMaps(
  url: string,
  opts: { repeat?: number; repeatY?: number; lift?: number; normalStrength?: number } = {},
): SurfaceMaps | null {
  if (typeof document === 'undefined') return null; // node/test: no DOM
  const hit = SURFACE_CACHE.get(url);
  if (hit) return hit;
  const mapCanvas = document.createElement('canvas');
  const nrmCanvas = document.createElement('canvas');
  const map = new THREE.CanvasTexture(mapCanvas);
  const normal = new THREE.CanvasTexture(nrmCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  normal.colorSpace = THREE.NoColorSpace;
  const rx = opts.repeat ?? 1;
  const ry = opts.repeatY ?? rx;
  for (const t of [map, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = 8;
    t.userData.shared = true;
  }
  const img = new Image();
  img.onload = () => {
    const size = img.width || 512;
    mapCanvas.width = mapCanvas.height = size;
    const mg = mapCanvas.getContext('2d');
    if (!mg) return;
    mg.drawImage(img, 0, 0, size, size);
    const src = mg.getImageData(0, 0, size, size);

    // normal map from luminance height — computed at <=512 (cheap, one-shot) and
    // wrapped at the edges so it stays tileable like the colour map
    const nsize = Math.min(size, 512);
    nrmCanvas.width = nrmCanvas.height = nsize;
    const ng = nrmCanvas.getContext('2d');
    if (ng) {
      ng.drawImage(img, 0, 0, nsize, nsize);
      const ndata = ng.getImageData(0, 0, nsize, nsize).data;
      const lum = new Float32Array(nsize * nsize);
      for (let i = 0; i < nsize * nsize; i++) {
        lum[i] = (ndata[i * 4]! * 0.299 + ndata[i * 4 + 1]! * 0.587 + ndata[i * 4 + 2]! * 0.114) / 255;
      }
      const strength = opts.normalStrength ?? 2;
      const at = (x: number, y: number) => lum[((y + nsize) % nsize) * nsize + ((x + nsize) % nsize)]!;
      const out = ng.createImageData(nsize, nsize);
      for (let y = 0; y < nsize; y++) {
        for (let x = 0; x < nsize; x++) {
          const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
          // +Y points up in OpenGL tangent space (THREE's convention), so the
          // green channel encodes -dh/dV — invert the row difference accordingly
          const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
          const inv = 1 / Math.hypot(dx, dy, 1);
          const j = (y * nsize + x) * 4;
          out.data[j] = (dx * inv * 0.5 + 0.5) * 255;
          out.data[j + 1] = (dy * inv * 0.5 + 0.5) * 255;
          out.data[j + 2] = (inv * 0.5 + 0.5) * 255;
          out.data[j + 3] = 255;
        }
      }
      ng.putImageData(out, 0, 0);
      normal.needsUpdate = true;
    }

    // lift the colour toward white so a theme-tinted surface keeps its palette
    if (opts.lift) {
      const k = opts.lift;
      for (let i = 0; i < src.data.length; i += 4) {
        src.data[i] = 255 - (255 - src.data[i]!) * (1 - k);
        src.data[i + 1] = 255 - (255 - src.data[i + 1]!) * (1 - k);
        src.data[i + 2] = 255 - (255 - src.data[i + 2]!) * (1 - k);
      }
      mg.putImageData(src, 0, 0);
    }
    map.needsUpdate = true;
  };
  img.src = url;
  const result = { map, normal };
  SURFACE_CACHE.set(url, result);
  return result;
}

/** Procedural sponsor lockup: accent disc with the initial + the wordmark. */
function sponsorTexture(s: Sponsor, w = 512, h = 96): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = s.color;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = s.accent;
  g.lineWidth = Math.max(3, h * 0.05);
  g.strokeRect(4, 4, w - 8, h - 8);
  g.font = `italic 900 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  const r = h * 0.27;
  const tw = g.measureText(s.name).width;
  const x0 = (w - (tw + r * 2.7)) / 2;
  g.fillStyle = s.accent;
  g.beginPath();
  g.arc(x0 + r, h / 2, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = s.color;
  g.font = `900 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText(s.name[0]!, x0 + r, h / 2 + 1);
  g.fillStyle = s.accent;
  g.font = `italic 900 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  g.textAlign = 'left';
  // tall surfaces fit the tagline under the wordmark
  if (s.tagline && h >= 140) {
    g.fillText(s.name, x0 + r * 2.7, h * 0.42);
    g.font = `600 ${Math.round(h * 0.16)}px system-ui, sans-serif`;
    g.fillStyle = '#cfd4de';
    g.fillText(s.tagline, x0 + r * 2.7, h * 0.72);
  } else {
    g.fillText(s.name, x0 + r * 2.7, h / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Faded paint-on-asphalt wordmark (transparent background). */
function roadLogoTexture(name: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.font = 'italic 900 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillText(name, 256, 80);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function gridSlotTexture(num: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 7;
  g.strokeRect(6, 6, 116, 68);
  g.font = '900 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText(String(num), 64, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function nameSprite(name: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '900 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(4.2, 1.05, 1);
  sprite.position.y = 2.0;
  return sprite;
}

interface KartVisual {
  group: THREE.Group;
  bodyTilt: THREE.Group; // chassis-only lean/squash (wheels stay grounded)
  wheels: { mesh: THREE.Object3D; front: boolean }[]; // Group: tire + rim + spokes
  flame: THREE.Mesh;
  sparkL: THREE.Mesh;
  sparkR: THREE.Mesh;
  sparkMat: THREE.MeshBasicMaterial;
  skidAcc: number;
  pitch: number; // smoothed slope tilt (rad)
  lean: number; // smoothed body roll (rad)
  steer: number; // smoothed front-wheel yaw (rad)
  squash: number; // landing suspension squash (1 = rest)
  prevHeading: number;
  airborne: boolean; // was off the ground last frame (landing detection)
  balloons: THREE.Mesh[]; // battle-mode lives, shown while balloons remain
  prevBalloons: number;
  wasFinished: boolean; // confetti fires on the finish edge
}

/** Render-only cosmetic colors for one kart (resolved from a PlayerStyle). */
export interface KartLook {
  primary: string;
  accent: string;
  flame: string;
}

export function defaultLook(seat: number): KartLook {
  const c = KART_COLORS[seat % KART_COLORS.length]!;
  return { primary: c, accent: c, flame: '#ff9b2f' };
}

/**
 * Shared, scene-owned detail textures (lazy, loaded once, reused by every
 * kart). Marked `userData.shared` so the per-kart `disposeTree` never frees
 * them. The carbon weave dresses the dark structural parts (diffuser, wing
 * uprights, cockpit halo) — it carries no color, so it never fights the
 * per-player paint tint.
 */
/**
 * Shared reflection env (PMREM-filtered). Applied per-material on kart paint
 * only — assigning it to `scene.environment` would light the whole track via
 * IBL and wash the scene out. Null until the studio image finishes loading.
 */
let ENV_MAP: THREE.Texture | null = null;

let DETAIL: { carbon: THREE.Texture; decal: THREE.Texture } | null = null;
function detailMaps(): { carbon: THREE.Texture; decal: THREE.Texture } | null {
  if (DETAIL) return DETAIL;
  if (typeof document === 'undefined') return null; // node/test: no DOM, skip
  const carbon = new THREE.TextureLoader().load('/textures/paint_carbon.png');
  carbon.colorSpace = THREE.SRGBColorSpace;
  carbon.wrapS = carbon.wrapT = THREE.RepeatWrapping;
  carbon.repeat.set(2, 2);
  carbon.anisotropy = 8; // clamped to the GPU max; crisp at grazing angles
  carbon.userData.shared = true;
  // the livery decal ships as an SVG; the browser rasterizes it (alpha intact)
  // when drawn to a canvas, so we wrap it in a CanvasTexture instead of a PNG
  const decal = svgTexture('/textures/decal_stripe.svg', 512);
  decal.userData.shared = true;
  DETAIL = { carbon, decal };
  return DETAIL;
}

/** Rasterize an SVG (transparent background preserved) into a CanvasTexture. */
function svgTexture(url: string, size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const img = new Image();
  img.onload = () => {
    const g = canvas.getContext('2d');
    if (!g) return;
    const ar = img.width / img.height || 1; // fit, centered, aspect-preserved
    const w = ar > 1 ? size : size * ar;
    const h = ar > 1 ? size / ar : size;
    g.clearRect(0, 0, size, size);
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    tex.needsUpdate = true; // canvas filled async; push the pixels to the GPU
  };
  img.src = url;
  return tex;
}

function buildKart(look: KartLook, name: string | null): KartVisual {
  const group = new THREE.Group();
  group.rotation.order = 'YZX'; // yaw, then slope pitch in the kart's frame

  // automotive clearcoat paint: a dielectric base under a glossy coat that
  // reflects the studio env map (scene.environment). Per-call materials — the
  // time-trial ghost mutates these to opacity 0.35, so they must NOT be shared.
  const paintOpts = {
    metalness: 0.0,
    roughness: 0.42,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.85, // capped <1 so bright liveries don't bloom-blow out
  } as const;
  const paint = new THREE.MeshPhysicalMaterial({ color: look.primary, ...paintOpts });
  const accentPaint = new THREE.MeshPhysicalMaterial({ color: look.accent, ...paintOpts });
  const trim = new THREE.MeshStandardMaterial({ color: '#1c1f26', roughness: 0.85, metalness: 0.1 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#13151b', roughness: 0.92, metalness: 0 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#cdd3dd', roughness: 0.28, metalness: 0.95, envMapIntensity: 1.0 });
  const carbon = new THREE.MeshStandardMaterial({
    color: '#3a3d44', roughness: 0.55, metalness: 0.2, map: detailMaps()?.carbon ?? null,
  });
  // reflections live on the kart materials only (null until the env loads;
  // applyEnvToKarts patches karts built before then) — never scene.environment
  for (const m of [paint, accentPaint, chrome, carbon]) m.envMap = ENV_MAP;

  // chassis subgroup: lean/squash animate this, wheels stay on the road
  const bodyTilt = new THREE.Group();
  group.add(bodyTilt);

  // low wide floor pan + a rear engine cowl give a planted, sleek silhouette
  const floor = new THREE.Mesh(new RoundedBoxGeometry(1.78, 0.2, 1.0, 4, 0.06), paint);
  floor.position.y = 0.34;
  bodyTilt.add(floor);
  const cowl = new THREE.Mesh(new RoundedBoxGeometry(0.92, 0.3, 0.62, 4, 0.09), paint);
  cowl.position.set(-0.28, 0.52, 0);
  bodyTilt.add(cowl);

  // pointed nose: a 4-sided pyramid flattened into a wedge
  const noseGeo = new THREE.ConeGeometry(0.4, 0.82, 4);
  noseGeo.rotateY(Math.PI / 4); // square faces aligned to the axes
  noseGeo.rotateZ(-Math.PI / 2); // apex -> +x (forward)
  const nose = new THREE.Mesh(noseGeo, accentPaint);
  nose.scale.set(1, 0.5, 0.95);
  nose.position.set(1.0, 0.34, 0);
  bodyTilt.add(nose);

  // side pods flanking the cockpit — the shape that kills the "shoebox" read
  for (const sz of [0.5, -0.5]) {
    const pod = new THREE.Mesh(new RoundedBoxGeometry(0.66, 0.22, 0.24, 3, 0.07), paint);
    pod.position.set(0.06, 0.33, sz);
    bodyTilt.add(pod);
  }

  // carbon cockpit halo, rear wing on uprights, raked diffuser
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 8, 20), carbon);
  halo.rotation.x = Math.PI / 2;
  halo.position.set(0.04, 0.5, 0);
  bodyTilt.add(halo);
  const wing = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.04, 1.04, 2, 0.02), accentPaint);
  wing.position.set(-0.86, 0.74, 0);
  bodyTilt.add(wing);
  for (const sz of [0.34, -0.34]) {
    const up = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.05), carbon);
    up.position.set(-0.84, 0.56, sz);
    bodyTilt.add(up);
  }
  const diffuser = new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.14, 0.92, 2, 0.04), carbon);
  diffuser.rotation.z = -0.22;
  diffuser.position.set(-0.84, 0.2, 0);
  bodyTilt.add(diffuser);

  // wheels: rubber tire + chrome rim + a spoke bar so the spin reads. Each is a
  // Group (the rig only sets .rotation.z/.y on it) kept in `group`, not
  // `bodyTilt`, so the suspension squash never lifts the wheels off the road.
  const R = 0.32; // larger wheels; the roll-rate divisor in updateRace matches
  const tireGeo = new THREE.CylinderGeometry(R, R, 0.3, 20);
  tireGeo.rotateX(Math.PI / 2); // axle along local z; spin = rotation.z
  const rimGeo = new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.32, 20);
  rimGeo.rotateX(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(R * 1.25, 0.06, 0.34);
  const wheels: { mesh: THREE.Object3D; front: boolean }[] = [];
  for (const [wx, wz] of [
    [0.55, 0.52],
    [0.55, -0.52],
    [-0.55, 0.52],
    [-0.55, -0.52],
  ] as const) {
    const w = new THREE.Group();
    w.rotation.order = 'YZX'; // steer yaw first, then roll about the axle
    w.position.set(wx, R, wz);
    w.add(new THREE.Mesh(tireGeo, rubber));
    w.add(new THREE.Mesh(rimGeo, chrome));
    w.add(new THREE.Mesh(spokeGeo, chrome)); // spoke bar makes the spin visible
    group.add(w);
    wheels.push({ mesh: w, front: wx > 0 });
  }

  // driver: smaller and lower than before so the kart, not the driver, is hero
  const headMat = new THREE.MeshStandardMaterial({ color: '#f2c8a0', roughness: 0.8 });
  const torso = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.34, 0.44, 2, 0.06), trim);
  torso.position.set(-0.1, 0.62, 0);
  bodyTilt.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 12), headMat);
  head.position.set(-0.1, 0.92, 0);
  bodyTilt.add(head);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    paint,
  );
  helmet.position.set(-0.1, 0.93, 0);
  bodyTilt.add(helmet);

  // real shadows from the sun replace the old blob-shadow disc
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });

  // livery side decals — skipped on the classic single-tone look (accent ==
  // primary). Flat overlays tinted by the accent color; added after the shadow
  // traverse so they neither cast shadow nor z-fight the side pods.
  const decalTex = look.accent !== look.primary ? detailMaps()?.decal : null;
  if (decalTex) {
    const decalMat = new THREE.MeshStandardMaterial({
      map: decalTex,
      color: look.accent,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      roughness: 0.6,
      metalness: 0,
      envMapIntensity: 0,
    });
    for (const sz of [0.63, -0.63] as const) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.42), decalMat);
      d.position.set(0.06, 0.4, sz);
      d.rotation.y = sz > 0 ? 0 : Math.PI; // face outward on each flank
      bodyTilt.add(d);
    }
  }

  // colors pushed past 1.0 render as HDR and pick up bloom
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.95, 10),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(look.flame).multiplyScalar(2.2),
      transparent: true,
      opacity: 0.92,
    }),
  );
  flame.rotation.z = Math.PI / 2; // apex points -x (backwards)
  flame.position.set(-1.05, 0.45, 0);
  flame.visible = false;
  bodyTilt.add(flame);

  const sparkMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#9bd6ff').multiplyScalar(2.2),
    transparent: true,
    opacity: 0.95,
  });
  const sparkGeo = new THREE.SphereGeometry(0.13, 8, 6);
  const sparkL = new THREE.Mesh(sparkGeo, sparkMat);
  sparkL.position.set(-0.62, 0.12, 0.55);
  sparkL.visible = false;
  group.add(sparkL);
  const sparkR = new THREE.Mesh(sparkGeo, sparkMat);
  sparkR.position.set(-0.62, 0.12, -0.55);
  sparkR.visible = false;
  group.add(sparkR);

  // battle balloons bob above the spoiler; hidden outside battle mode
  const balloons: THREE.Mesh[] = [];
  const balloonColors = ['#ff4757', '#ffd23f', '#3fd06b'];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshStandardMaterial({ color: balloonColors[i], roughness: 0.4 }),
    );
    b.position.set((i - 1) * 0.45, 1.7, -0.35);
    b.visible = false;
    group.add(b);
    balloons.push(b);
  }

  if (name) group.add(nameSprite(name, look.primary));
  return {
    group,
    bodyTilt,
    wheels,
    flame,
    sparkL,
    sparkR,
    sparkMat,
    skidAcc: 0,
    pitch: 0,
    lean: 0,
    steer: 0,
    squash: 1,
    prevHeading: 0,
    airborne: false,
    balloons,
    prevBalloons: 3,
    wasFinished: false,
  };
}

function loopShapePoints(loop: Vec2Fx[]): THREE.Vector2[] {
  return loop.map((p) => new THREE.Vector2(fxToFloat(p.x), fxToFloat(p.y)));
}

/**
 * Pooled additive point particles (drift sparks, boost embers, dirt dust).
 * One Points mesh, fixed-size ring buffer; fade is base color → black, which
 * under additive blending reads as fade-out. HDR base colors pick up bloom.
 */
class ParticlePool {
  readonly points: THREE.Points;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseCol: Float32Array;
  private readonly floorY: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private head = 0;

  constructor(private readonly n: number, size: number) {
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.baseCol = new Float32Array(n * 3);
    this.floorY = new Float32Array(n);
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1000), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const mat = new THREE.PointsMaterial({
      size,
      map: softDotTexture(),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false; // positions stream every frame
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: THREE.Color, life: number, floor = 0,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    const j = i * 3;
    const pos = this.posAttr.array as Float32Array;
    pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.baseCol[j] = color.r; this.baseCol[j + 1] = color.g; this.baseCol[j + 2] = color.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.floorY[i] = floor;
  }

  update(dt: number): void {
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      const li = (this.life[i]! -= dt);
      const j = i * 3;
      if (li <= 0) {
        col[j] = col[j + 1] = col[j + 2] = 0;
        pos[j + 1] = -1000;
        continue;
      }
      this.vel[j + 1]! -= 18 * dt; // gravity
      pos[j]! += this.vel[j]! * dt;
      pos[j + 1]! += this.vel[j + 1]! * dt;
      pos[j + 2]! += this.vel[j + 2]! * dt;
      const floor = this.floorY[i]! + 0.04;
      if (pos[j + 1]! < floor) {
        pos[j + 1] = floor;
        this.vel[j + 1]! *= -0.35; // ground bounce, damped
        this.vel[j]! *= 0.7;
        this.vel[j + 2]! *= 0.7;
      }
      const f = li / this.maxLife[i]!;
      col[j] = this.baseCol[j]! * f;
      col[j + 1] = this.baseCol[j + 1]! * f;
      col[j + 2] = this.baseCol[j + 2]! * f;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    (this.colAttr.array as Float32Array).fill(0);
    (this.posAttr.array as Float32Array).fill(-1000);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
}

/** Pooled skid-mark decals stamped flat on the asphalt, fading over ~4.5s. */
class SkidPool {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly life: number[] = [];
  private head = 0;

  constructor(scene: THREE.Scene, private readonly n: number) {
    const geo = new THREE.PlaneGeometry(0.17, 0.6);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: '#0d0f13', transparent: true, opacity: 0 }),
      );
      mesh.visible = false;
      mesh.position.y = 0.018; // above asphalt (0.015), below pads/shadows
      scene.add(mesh);
      this.meshes.push(mesh);
      this.life.push(0);
    }
  }

  stamp(x: number, z: number, yaw: number, y = 0.018): void {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    const m = this.meshes[i]!;
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    m.visible = true;
    this.life[i] = 1;
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      const li = (this.life[i]! -= dt / 4.5);
      const m = this.meshes[i]!;
      if (li <= 0) {
        m.visible = false;
        continue;
      }
      (m.material as THREE.MeshBasicMaterial).opacity = 0.5 * Math.min(1, li * 3);
    }
  }

  clear(): void {
    for (let i = 0; i < this.n; i++) {
      this.life[i] = 0;
      this.meshes[i]!.visible = false;
    }
  }
}

/**
 * Ambient particle field that follows the camera — snow falls, dust drifts
 * on the wind, fireflies wander. Particles wrap into a box around the camera
 * so a small pool covers the whole track.
 */
class WeatherField {
  readonly points: THREE.Points;
  private readonly speed: Float32Array;
  private readonly phase: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly halfBox = 46;
  private readonly height: number;
  private t = 0;

  constructor(private readonly kind: 'snow' | 'dust' | 'fireflies') {
    const n = kind === 'snow' ? 700 : kind === 'dust' ? 260 : 200;
    this.height = kind === 'snow' ? 26 : 12;
    const pos = new Float32Array(n * 3);
    this.speed = new Float32Array(n);
    this.phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.halfBox * 2;
      pos[i * 3 + 1] = Math.random() * this.height;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.halfBox * 2;
      this.speed[i] = 0.5 + Math.random();
      this.phase[i] = Math.random() * Math.PI * 2;
    }
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.posAttr);
    const color =
      kind === 'snow'
        ? new THREE.Color('#ffffff')
        : kind === 'dust'
          ? new THREE.Color('#d8b97c').multiplyScalar(0.5)
          : new THREE.Color('#7df0d8').multiplyScalar(1.7); // HDR fireflies bloom
    const mat = new THREE.PointsMaterial({
      color,
      map: softDotTexture(),
      size: kind === 'snow' ? 0.18 : kind === 'dust' ? 0.13 : 0.21,
      transparent: true,
      opacity: kind === 'snow' ? 0.9 : 0.75,
      blending: kind === 'snow' ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  update(dt: number, cx: number, cz: number): void {
    this.t += dt;
    const p = this.posAttr.array as Float32Array;
    const n = this.speed.length;
    const w = this.halfBox * 2;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const ph = this.phase[i]!;
      const sp = this.speed[i]!;
      if (this.kind === 'snow') {
        p[j + 1]! -= sp * 2.2 * dt;
        p[j]! += Math.sin(this.t * 0.8 + ph) * dt * 0.8;
        p[j + 2]! += Math.cos(this.t * 0.7 + ph) * dt * 0.8;
        if (p[j + 1]! < 0) p[j + 1]! += this.height;
      } else if (this.kind === 'dust') {
        p[j + 1]! += sp * 0.4 * dt;
        p[j]! += (1.4 + Math.sin(this.t + ph)) * dt; // steady wind
        p[j + 2]! += Math.cos(this.t * 0.6 + ph) * dt * 0.6;
        if (p[j + 1]! > this.height) p[j + 1]! -= this.height;
      } else {
        p[j]! += Math.sin(this.t * 0.9 + ph) * dt * 1.4;
        p[j + 1]! += Math.cos(this.t * 0.5 + ph * 1.7) * dt * 0.5;
        p[j + 2]! += Math.cos(this.t * 0.8 + ph) * dt * 1.4;
        if (p[j + 1]! < 0.3) p[j + 1] = 0.3;
        if (p[j + 1]! > this.height) p[j + 1] = this.height;
      }
      // wrap into the box centred on the camera
      p[j]! -= Math.floor((p[j]! - (cx - this.halfBox)) / w) * w;
      p[j + 2]! -= Math.floor((p[j + 2]! - (cz - this.halfBox)) / w) * w;
    }
    this.posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Radial speed lines, intensity-driven; segments flicker around the screen edge. */
const SpeedLinesShader = {
  uniforms: {
    tDiffuse: { value: null },
    uIntensity: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uTime;
    uniform float uAspect;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      d.x *= uAspect;
      float dist = length(d);
      float a = atan(d.y, d.x) / 6.28318530718 + 0.5;
      float seg = floor(a * 56.0);
      float r1 = hash(seg);
      float r2 = hash(seg + 61.0);
      // each radial segment blinks on/off at its own rate
      float flick = step(0.62, fract(r1 + uTime * (1.5 + r2 * 2.0)));
      // thin line core inside the segment
      float line = smoothstep(0.13, 0.02, abs(fract(a * 56.0) - 0.5));
      // confined to the screen edge ring, staggered per segment
      float ring = smoothstep(0.40 + r2 * 0.12, 0.68, dist);
      float lines = line * flick * ring * uIntensity;
      gl_FragColor = vec4(c.rgb + vec3(lines * 0.45), c.a);
    }
  `,
};

const EMBER_COLOR = new THREE.Color('#ff9b2f').multiplyScalar(2.4); // HDR — blooms
const DUST_COLOR = new THREE.Color('#8a7355').multiplyScalar(0.55); // dim: subtle under additive
const CONFETTI = ['#ffd23f', '#ff4757', '#21e6c1', '#3fd06b', '#f2efe6', '#c879e0'].map((c) =>
  new THREE.Color(c).multiplyScalar(1.5),
);

/** Item pickup: a shield badge — flat top, straight sides, point at the bottom. */
function shieldGeometry(): THREE.ExtrudeGeometry {
  const w = 0.52; // half-width
  const top = 0.62;
  const shoulder = -0.1; // where the straight sides end and the taper begins
  const tip = -0.66;
  const shape = new THREE.Shape();
  shape.moveTo(-w, top);
  shape.lineTo(w, top);
  shape.lineTo(w, shoulder);
  shape.lineTo(0, tip);
  shape.lineTo(-w, shoulder);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.26,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.06,
    bevelSegments: 2,
  });
  geo.center();
  return geo;
}

export class GameScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private speedLines: ShaderPass;
  private speedLineLevel = 0;
  private particles = new ParticlePool(512, 0.24);
  private skids: SkidPool;
  private weather: WeatherField | null = null;
  private cloudSpin: THREE.Group | null = null;
  private neonMats: THREE.MeshStandardMaterial[] = [];
  private shake = 0;
  private prevLocalSpin = 0;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /** PMREM-filtered studio env for clearcoat reflections; shared, scene-owned. */
  private envTexture: THREE.Texture | null = null;

  private world: THREE.Group | null = null;
  private worldTrackId: string | null = null;
  private track: TrackRuntime = getTrack(undefined);
  private terrain = new Terrain(getTrack(undefined));

  private karts: KartVisual[] = [];
  private itemMeshes: THREE.Mesh[] = [];
  private itemBaseY: number[] = [];
  private itemWasActive: boolean[] = [];
  private itemPop: number[] = [];
  private padMeshes: THREE.Mesh[] = [];
  private shellMeshes: THREE.Mesh[] = [];
  private oilMeshes: THREE.Mesh[] = [];
  private shards: {
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    life: number;
    floor: number;
  }[] = [];
  private shardGeo = new THREE.BoxGeometry(0.26, 0.26, 0.26);

  private ghost: KartVisual | null = null;
  private orbit = { cx: 0, cz: 0, radius: 95, height: 42 };
  private idleAngle = 0;
  private camInit = false;
  /** look-behind camera while true (set per frame from held key) */
  rearview = false;
  private prevRearview = false;
  private camRoll = 0;
  private camDip = 0;
  /** low-passed camera yaw: filters per-tick steering dither out of the view */
  private camYaw = 0;
  private t = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // filmic curve: rich mids, soft highlight rolloff; OutputPass applies it
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.camera = new THREE.PerspectiveCamera(64, 1, 0.1, 900);

    // bloom: threshold 1 means only HDR-bright pixels glow (boosted emissives
    // and overdriven basic-material colors), so the base look stays untouched
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.7,
      0.4,
      1.0,
    );
    this.composer.addPass(this.bloom);
    this.speedLines = new ShaderPass(SpeedLinesShader);
    this.speedLines.enabled = false;
    this.composer.addPass(this.speedLines);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.particles.points);
    this.skids = new SkidPool(this.scene, 128);

    this.hemi = new THREE.HemisphereLight('#cfe6ff', '#3e6b3a', 1.05);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3d6', 1.6);
    this.sun.position.set(60, 90, 40);
    this.scene.add(this.sun);

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6; // low-poly: keep big flat faces acne-free
    this.scene.add(this.sun.target);

    // projectile/hazard pools live outside the swappable world group
    const shellRimMat = new THREE.MeshStandardMaterial({ color: '#f4f7ef', roughness: 0.6 });
    for (let i = 0; i < MAX_SHELLS; i++) {
      // per-shell material: homing shells tint red while live
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(fxToFloat(SHELL_RADIUS), 14, 10),
        new THREE.MeshStandardMaterial({ color: '#3fd06b', roughness: 0.35, metalness: 0.2 }),
      );
      shell.castShadow = true;
      const rim = new THREE.Mesh(
        new THREE.SphereGeometry(fxToFloat(SHELL_RADIUS) * 0.92, 14, 10, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38),
        shellRimMat,
      );
      shell.add(rim);
      shell.visible = false;
      this.shellMeshes.push(shell);
      this.scene.add(shell);
    }
    for (let i = 0; i < MAX_OILS; i++) {
      // per-mesh material: opacity animates independently per slick
      const oilMat = new THREE.MeshStandardMaterial({
        color: '#14161c',
        roughness: 0.25,
        metalness: 0.4,
        transparent: true,
        opacity: 0.9,
      });
      const oil = new THREE.Mesh(new THREE.CircleGeometry(fxToFloat(OIL_RADIUS), 18), oilMat);
      oil.rotation.x = -Math.PI / 2;
      oil.visible = false;
      this.oilMeshes.push(oil);
      this.scene.add(oil);
    }

    this.loadEnvironment();
    this.setTrack(getTrack(undefined));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Soft studio environment for clearcoat kart reflections. Loaded once and
   * reused across every track/race — marked `userData.shared` so the per-kart
   * `disposeTree` never frees it. It's applied per-material to the kart paint
   * (see buildKart / applyEnvToKarts), NOT to `scene.environment`: a global
   * env would light the entire track via IBL and wash the scene out. Async —
   * paint reads matte until it lands, which looks fine.
   */
  private loadEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    new THREE.TextureLoader().load(
      '/textures/env_studio.png',
      (eq) => {
        eq.mapping = THREE.EquirectangularReflectionMapping;
        eq.colorSpace = THREE.SRGBColorSpace;
        const rt = pmrem.fromEquirectangular(eq);
        rt.texture.userData.shared = true;
        ENV_MAP = rt.texture;
        this.envTexture = rt.texture;
        this.applyEnvToKarts(); // patch karts/ghost built before the env loaded
        eq.dispose();
        pmrem.dispose();
      },
      undefined,
      () => pmrem.dispose(), // asset missing in dev: skip reflections, no crash
    );
  }

  /**
   * Assign the reflection env to existing kart materials. New karts pick it up
   * in buildKart; this only covers karts/the ghost built before the async env
   * finished loading. Confined to karts so the track lighting is untouched.
   */
  private applyEnvToKarts(): void {
    const patch = (root: THREE.Object3D | undefined): void => {
      root?.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        if (!mm) return;
        for (const mat of Array.isArray(mm) ? mm : [mm]) {
          if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            (mat as THREE.MeshStandardMaterial).envMap = ENV_MAP;
            mat.needsUpdate = true;
          }
        }
      });
    };
    for (const k of this.karts) patch(k.group);
    patch(this.ghost?.group);
  }

  get currentTrackId(): string {
    return this.track.def.id;
  }

  /** Swap the whole world to another track (no-op if already showing it). */
  setTrack(track: TrackRuntime): void {
    if (this.worldTrackId === track.def.id) return;
    if (this.world) {
      this.scene.remove(this.world);
      disposeTree(this.world);
    }
    this.track = track;
    this.terrain = new Terrain(track);
    this.worldTrackId = track.def.id;
    this.itemMeshes = [];
    this.itemBaseY = [];
    this.itemWasActive = [];
    this.itemPop = [];
    this.padMeshes = [];
    for (const s of this.shards) {
      this.scene.remove(s.mesh);
      (s.mesh.material as THREE.Material).dispose();
    }
    this.shards = [];
    this.particles.clear();
    this.skids.clear();
    this.cloudSpin = null;
    // theme + orbit first: the sky dome and sun disc are built from them
    this.applyTheme(track);
    this.computeOrbit(track);
    this.world = this.buildWorld(track);
    this.scene.add(this.world);
    this.camInit = false;
  }

  private applyTheme(track: TrackRuntime): void {
    const th = track.def.theme;
    this.scene.background = new THREE.Color(th.fog); // dome covers this; fallback only
    this.scene.fog = new THREE.Fog(th.fog, 150, 680);
    this.bloom.strength = th.night ? 1.05 : 0.7;
    this.renderer.toneMappingExposure = th.exposure ?? 1.15;
    if (this.weather) {
      this.scene.remove(this.weather.points);
      this.weather.dispose();
      this.weather = null;
    }
    if (th.weather) {
      this.weather = new WeatherField(th.weather);
      this.scene.add(this.weather.points);
    }
    // lighting personality: theme overrides on top of day/night defaults
    this.sun.intensity = th.sunIntensity ?? (th.night ? 0.95 : 1.6);
    this.sun.color.set(th.sunColor ?? (th.night ? '#aabfff' : '#fff3d6'));
    this.hemi.intensity = th.hemiIntensity ?? (th.night ? 1.0 : 1.05);
    this.hemi.color.set(th.hemiSky ?? (th.night ? '#5a6a9e' : '#cfe6ff'));
    this.hemi.groundColor.set(th.hemiGround ?? (th.night ? '#1a1e36' : th.ground));
  }

  private computeOrbit(track: TrackRuntime): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of track.centerline) {
      const x = fxToFloat(p.x);
      const y = fxToFloat(p.y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.orbit.cx = (minX + maxX) / 2;
    this.orbit.cz = -(minY + maxY) / 2;
    const extent = Math.max(maxX - minX, maxY - minY);
    this.orbit.radius = extent * 0.62 + 36;
    this.orbit.height = extent * 0.3 + 18;

    // aim the sun (and its shadow box) at this track; the theme picks the
    // angle — low sun means long dramatic shadows
    const th = track.def.theme;
    const el = ((th.sunElevation ?? 55) * Math.PI) / 180;
    const az = ((th.sunAzimuth ?? 35) * Math.PI) / 180;
    const r = extent * 0.75 + 30;
    this.sun.position.set(
      this.orbit.cx + Math.cos(az) * Math.cos(el) * r,
      Math.max(Math.sin(el), 0.08) * r,
      this.orbit.cz + Math.sin(az) * Math.cos(el) * r,
    );
    this.sun.target.position.set(this.orbit.cx, 0, this.orbit.cz);
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = r * 3;
    cam.updateProjectionMatrix();
  }

  /** Sky dome + celestials, sized to swallow the whole world (camera far 900). */
  private buildSky(track: TrackRuntime): THREE.Group {
    const th = track.def.theme;
    const sky = new THREE.Group();
    const cx = this.orbit.cx;
    const cz = this.orbit.cz;
    const R = 760;

    // zenith -> horizon gradient; the horizon IS the fog color, so distance
    // fog and sky meet seamlessly
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(R, 32, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(th.skyTop ?? th.sky) },
          uHorizon: { value: new THREE.Color(th.fog) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          varying vec3 vPos;
          void main() {
            float h = clamp(normalize(vPos).y, 0.0, 1.0);
            gl_FragColor = vec4(mix(uHorizon, uTop, pow(h, 0.65)), 1.0);
          }
        `,
      }),
    );
    dome.position.set(cx, 0, cz);
    dome.renderOrder = -3;
    sky.add(dome);

    // the sun — or at night the moon — as an HDR disc that picks up bloom
    const sunDir = this.sun.position.clone().sub(this.sun.target.position).normalize();
    const discCol = new THREE.Color(th.sunColor ?? (th.night ? '#dfe8ff' : '#fff6d8'));
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(th.night ? 18 : 26, 24),
      new THREE.MeshBasicMaterial({
        color: discCol.multiplyScalar(th.night ? 1.4 : 3),
        fog: false,
      }),
    );
    disc.position.set(cx + sunDir.x * R * 0.93, sunDir.y * R * 0.93, cz + sunDir.z * R * 0.93);
    disc.lookAt(cx, 0, cz);
    disc.renderOrder = -2;
    sky.add(disc);

    if (th.night) {
      // starfield on the upper dome (deterministic LCG — same sky every load)
      const N = 420;
      const pos = new Float32Array(N * 3);
      let s = 1234567;
      const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = 0; i < N; i++) {
        const a = rnd() * Math.PI * 2;
        const y = 0.12 + rnd() * 0.85;
        const rh = Math.sqrt(Math.max(0, 1 - y * y));
        pos[i * 3] = Math.cos(a) * rh * R * 0.98;
        pos[i * 3 + 1] = y * R * 0.98;
        pos[i * 3 + 2] = Math.sin(a) * rh * R * 0.98;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: '#cfd8ff',
          size: 1.7,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.85,
          fog: false,
          depthWrite: false,
        }),
      );
      stars.position.set(cx, 0, cz);
      stars.renderOrder = -2;
      sky.add(stars);
    } else {
      // cumulus ring, drifting slowly around the dome
      const tex = cloudTexture();
      const spin = new THREE.Group();
      spin.position.set(cx, 0, cz);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + ((i * 37) % 5) * 0.13;
        const elv = 0.16 + ((i * 53) % 7) * 0.05;
        const d = R * 0.9;
        const y = d * elv;
        const rh = Math.sqrt(d * d - y * y);
        const cloud = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
            fog: false,
            opacity: 0.45 + ((i * 29) % 4) * 0.12,
          }),
        );
        cloud.position.set(Math.cos(a) * rh, y, Math.sin(a) * rh);
        const w = 110 + ((i * 41) % 80);
        cloud.scale.set(w, w * 0.45, 1);
        spin.add(cloud);
      }
      sky.add(spin);
      this.cloudSpin = spin;
    }
    return sky;
  }

  private buildWorld(track: TrackRuntime): THREE.Group {
    const g = new THREE.Group();
    const th = track.def.theme;
    g.add(this.buildSky(track));

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(700, 48),
      new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    ground.name = 'ground';
    g.add(ground);

    // PBR surface textures (shared, normal-mapped). Both geometry paths emit
    // world-coordinate UVs, so texture .repeat sets the real-world tile size.
    // The albedo is lifted toward white (see surfaceMaps) so the per-theme tint
    // survives the multiply; the derived normal map carries the actual relief.
    const asph = surfaceMaps('/textures/surf_asphalt.png', { repeat: 0.16, lift: 0.85, normalStrength: 2.4 });
    const drt = surfaceMaps('/textures/surf_dirt.png', { repeat: 0.13, lift: 0.8, normalStrength: 2.8 });
    const dirtMat = new THREE.MeshStandardMaterial({
      color: th.dirt,
      roughness: 1,
      map: drt?.map ?? null,
      normalMap: drt?.normal ?? null,
      normalScale: new THREE.Vector2(0.7, 0.7),
    });
    const asphaltMat = new THREE.MeshStandardMaterial({
      color: th.asphalt,
      roughness: 0.92,
      map: asph?.map ?? null,
      normalMap: asph?.normal ?? null,
      normalScale: new THREE.Vector2(0.55, 0.55),
    });

    if (track.hasHills) {
      // hill track: corridor surfaces are triangle strips between two rims
      // that follow the per-vertex elevation; the sim's height field is
      // linear along segments and constant across the width, so loop-vertex
      // resolution reproduces it exactly
      const hOf = (i: number) => fxToFloat(track.heights[i]!);
      type Rim = [number, number, number][];
      const strip = (a: Rim, b: Rim, mat: THREE.MeshStandardMaterial): THREE.Mesh => {
        const n = a.length;
        const pos = new Float32Array(n * 6);
        const uv = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          pos[i * 6] = a[i]![0]; pos[i * 6 + 1] = a[i]![1]; pos[i * 6 + 2] = a[i]![2];
          pos[i * 6 + 3] = b[i]![0]; pos[i * 6 + 4] = b[i]![1]; pos[i * 6 + 5] = b[i]![2];
          // world-coordinate UVs, same convention as the flat ShapeGeometry path
          uv[i * 4] = a[i]![0]; uv[i * 4 + 1] = a[i]![2];
          uv[i * 4 + 2] = b[i]![0]; uv[i * 4 + 3] = b[i]![2];
        }
        const idx: number[] = [];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          idx.push(i * 2, i * 2 + 1, j * 2, i * 2 + 1, j * 2 + 1, j * 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'ground';
        return mesh;
      };
      const rim = (loop: Vec2Fx[], lift: number): Rim =>
        loop.map((p, i) => [fxToFloat(p.x), hOf(i) + lift, -fxToFloat(p.y)]);

      if (track.hasDirt) g.add(strip(rim(track.fenceInner, 0), rim(track.fenceOuter, 0), dirtMat));
      g.add(strip(rim(track.inner, 0.015), rim(track.outer, 0.015), asphaltMat));

      // ground aprons: corridor elevation falls off smoothly to the valley
      // floor on both sides (same cosine the Terrain sampler uses, so decor
      // placed on it stands flush)
      const apronMat = new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 });
      const apron = (fence: Vec2Fx[], outward: boolean, reach: number): void => {
        const dirs = fence.map((p, i) => {
          const c = track.centerline[i]!;
          const dx = fxToFloat(p.x) - fxToFloat(c.x);
          const dz = -fxToFloat(p.y) + fxToFloat(c.y);
          const l = Math.hypot(dx, dz) || 1;
          return [dx / l, dz / l] as const;
        });
        const ringAt = (u: number): Rim =>
          fence.map((p, i) => [
            fxToFloat(p.x) + dirs[i]![0] * reach * u,
            (hOf(i) * (Math.cos(Math.PI * u) + 1)) / 2 - 0.02,
            -fxToFloat(p.y) + dirs[i]![1] * reach * u,
          ]);
        const RINGS = 4;
        for (let k = 0; k < RINGS; k++) {
          const a = ringAt(k / RINGS);
          const b = ringAt((k + 1) / RINGS);
          g.add(outward ? strip(a, b, apronMat) : strip(b, a, apronMat));
        }
      };
      apron(track.fenceOuter, true, 26);
      apron(track.fenceInner, false, 13);
    } else {
      // flat track: 2D loop shapes laid on the ground plane (original path)
      if (track.hasDirt) {
        const dirtShape = new THREE.Shape(loopShapePoints(track.fenceOuter));
        dirtShape.holes.push(new THREE.Path(loopShapePoints(track.fenceInner)));
        const dirtGeo = new THREE.ShapeGeometry(dirtShape, 4);
        dirtGeo.rotateX(-Math.PI / 2);
        const dirt = new THREE.Mesh(dirtGeo, dirtMat);
        dirt.position.y = 0.0;
        dirt.name = 'ground';
        g.add(dirt);
      }

      const shape = new THREE.Shape(loopShapePoints(track.outer));
      shape.holes.push(new THREE.Path(loopShapePoints(track.inner)));
      const trackGeo = new THREE.ShapeGeometry(shape, 4);
      trackGeo.rotateX(-Math.PI / 2);
      const asphalt = new THREE.Mesh(trackGeo, asphaltMat);
      asphalt.position.y = 0.015;
      asphalt.name = 'ground';
      g.add(asphalt);
    }

    // walls along the fence — the exact segments the sim collides with.
    // shared concrete-barrier detail, tinted per theme: lifted high so the
    // vivid wall colours survive the multiply, normal map adds panel relief.
    const wallTex = surfaceMaps('/textures/wall_barrier.png', {
      repeat: 2, repeatY: 1, lift: 0.45, normalStrength: 1.6,
    });
    const wallMatA = new THREE.MeshStandardMaterial({
      color: th.wallA,
      roughness: 0.7,
      map: wallTex?.map ?? null,
      normalMap: wallTex?.normal ?? null,
      emissive: th.night ? th.wallA : '#000000',
      emissiveIntensity: th.night ? 0.55 : 0,
    });
    const wallMatB = new THREE.MeshStandardMaterial({
      color: th.wallB,
      roughness: 0.7,
      map: wallTex?.map ?? null,
      normalMap: wallTex?.normal ?? null,
      emissive: th.night ? th.wallB : '#000000',
      emissiveIntensity: th.night ? 0.55 : 0,
    });
    track.walls.forEach((w, i) => {
      const a = toV3(w.x0, w.y0);
      const b = toV3(w.x1, w.y1);
      a.y = this.terrain.heightAt(a.x, a.z);
      b.y = this.terrain.heightAt(b.x, b.z);
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(a.distanceTo(b) + 0.3, 0.85, 0.55),
        i % 2 === 0 ? wallMatA : wallMatB,
      );
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.position.y += 0.42;
      mesh.rotation.order = 'YZX'; // yaw, then pitch along the fence slope
      mesh.rotation.y = yawOf(a, b);
      mesh.rotation.z = Math.atan2(b.y - a.y, run);
      g.add(mesh);
    });

    // start/finish anchored to the ASPHALT edge (gates span the dirt fence)
    const startVert = track.def.checkpointVerts[0]!;
    const g0 = toV3(track.inner[startVert]!.x, track.inner[startVert]!.y);
    const g1 = toV3(track.outer[startVert]!.x, track.outer[startVert]!.y);
    const gateLen = g0.distanceTo(g1);
    const gateMid = g0.clone().add(g1).multiplyScalar(0.5);
    const gateYaw = yawOf(g0, g1);
    const gateH = this.terrain.heightAt(gateMid.x, gateMid.z);

    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(gateLen, 2.2),
      new THREE.MeshBasicMaterial({ map: checkerTexture(16, 3) }),
    );
    strip.rotation.x = -Math.PI / 2;
    strip.rotation.z = gateYaw;
    strip.position.copy(gateMid).setY(gateH + 0.03);
    g.add(strip);

    const postGeo = new THREE.BoxGeometry(0.35, 5.6, 0.35);
    const postMat = new THREE.MeshStandardMaterial({ color: '#22252e', roughness: 0.6 });
    for (const end of [g0, g1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.copy(end).setY(gateH + 2.8);
      g.add(post);
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(gateLen, 1.4),
      new THREE.MeshBasicMaterial({ map: checkerTexture(20, 2), side: THREE.DoubleSide }),
    );
    banner.position.copy(gateMid).setY(gateH + 5.0);
    banner.rotation.y = gateYaw;
    g.add(banner);

    // title sponsor strip hanging under the checkered banner
    const titleStrip = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(gateLen * 0.62, 9), 0.7),
      new THREE.MeshBasicMaterial({
        map: sponsorTexture(titleSponsor(), 512, 56),
        side: THREE.DoubleSide,
      }),
    );
    titleStrip.position.copy(gateMid).setY(gateH + 4.0);
    titleStrip.rotation.y = gateYaw;
    g.add(titleStrip);

    // boost pads: chevron planes pointing along the direction of travel
    const chevron = chevronTexture();
    for (const p of track.boostPads) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(fxToFloat(p.halfLen) * 2, fxToFloat(p.halfWid) * 2),
        new THREE.MeshBasicMaterial({
          map: chevron,
          color: new THREE.Color(1.6, 1.6, 1.6), // overdrive so the gold chevrons bloom
          transparent: true,
          opacity: 0.85,
        }),
      );
      mesh.geometry.rotateX(-Math.PI / 2);
      const px = fxToFloat(p.cx);
      const pz = -fxToFloat(p.cy);
      const yaw = Math.atan2(fxToFloat(p.dy), fxToFloat(p.dx));
      mesh.position.set(px, this.terrain.heightAt(px, pz) + 0.025, pz);
      mesh.rotation.order = 'YZX'; // yaw, then pitch with the road
      mesh.rotation.y = yaw;
      mesh.rotation.z = Math.atan(this.terrain.slopeAlong(px, pz, yaw));
      g.add(mesh);
      this.padMeshes.push(mesh);
    }

    // jump ramps: solid wedges rising along the direction of travel
    for (const r of track.ramps) {
      const L = fxToFloat(r.halfLen);
      const W = fxToFloat(r.halfWid);
      const wedge = new THREE.Shape();
      wedge.moveTo(-L, 0);
      wedge.lineTo(L, 0);
      wedge.lineTo(L, L * 0.55);
      wedge.closePath();
      const geo = new THREE.ExtrudeGeometry(wedge, { depth: W * 2, bevelEnabled: false });
      geo.translate(0, 0, -W);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: th.wallA, roughness: 0.6 }),
      );
      const px = fxToFloat(r.cx);
      const pz = -fxToFloat(r.cy);
      const yaw = Math.atan2(fxToFloat(r.dy), fxToFloat(r.dx));
      mesh.position.set(px, this.terrain.heightAt(px, pz) + 0.01, pz);
      mesh.rotation.order = 'YZX';
      mesh.rotation.y = yaw;
      mesh.rotation.z = Math.atan(this.terrain.slopeAlong(px, pz, yaw));
      g.add(mesh);
    }

    const kerbs = this.buildKerbs(track);
    if (kerbs) g.add(kerbs);
    g.add(this.buildLaneDashes(track));
    this.buildGridSlots(g, track);
    this.buildTrackside(g, track);

    // item pickups: shield badges, point down
    const itemMat = new THREE.MeshStandardMaterial({
      color: '#ffd23f',
      emissive: '#ffd23f',
      emissiveIntensity: 1.1,
      metalness: 0.7,
      roughness: 0.25,
      transparent: true,
      opacity: 0.95,
    });
    const shieldGeo = shieldGeometry();
    for (const spawn of track.itemSpawns) {
      const mesh = new THREE.Mesh(shieldGeo, itemMat);
      const base = this.terrain.heightAt(fxToFloat(spawn.x), -fxToFloat(spawn.y));
      mesh.position.copy(toV3(spawn.x, spawn.y)).setY(base + 0.95);
      g.add(mesh);
      this.itemMeshes.push(mesh);
      this.itemBaseY.push(base);
      this.itemWasActive.push(true);
      this.itemPop.push(1);
    }

    this.buildDecor(g, track);

    // shadow flags: lit meshes cast and receive; ground planes only receive
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (!m.isMeshStandardMaterial) return;
      mesh.castShadow = mesh.name !== 'ground';
      mesh.receiveShadow = true;
    });
    return g;
  }

  /**
   * Striped kerbs on the apex side of every sharp corner. One merged mesh;
   * stripe UVs ride the cumulative edge length so they run continuously.
   */
  private buildKerbs(track: TrackRuntime): THREE.Mesh | null {
    const n = track.centerline.length;
    const W = 0.95;
    const cl = (i: number) => track.centerline[((i % n) + n) % n]!;
    const hOf = (i: number) => fxToFloat(track.heights[((i % n) + n) % n]!);
    const cumOf = (loop: Vec2Fx[]) => {
      const out = [0];
      for (let i = 0; i < n; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % n]!;
        out.push(
          out[i]! + Math.hypot(fxToFloat(b.x) - fxToFloat(a.x), fxToFloat(b.y) - fxToFloat(a.y)),
        );
      }
      return out;
    };
    const cums = { i: cumOf(track.inner), o: cumOf(track.outer) };

    // a corner earns a kerb when the centerline bends sharply at its vertex;
    // the kerb hugs the apex-side asphalt edge over both adjacent segments
    const segs = new Map<string, { j: number; side: 'i' | 'o' }>();
    for (let i = 0; i < n; i++) {
      const d1x = fxToFloat(cl(i).x) - fxToFloat(cl(i - 1).x);
      const d1y = fxToFloat(cl(i).y) - fxToFloat(cl(i - 1).y);
      const d2x = fxToFloat(cl(i + 1).x) - fxToFloat(cl(i).x);
      const d2y = fxToFloat(cl(i + 1).y) - fxToFloat(cl(i).y);
      const l1 = Math.hypot(d1x, d1y) || 1;
      const l2 = Math.hypot(d2x, d2y) || 1;
      const cross = (d1x * d2y - d1y * d2x) / (l1 * l2);
      const dot = (d1x * d2x + d1y * d2y) / (l1 * l2);
      if (Math.atan2(Math.abs(cross), dot) < 0.3) continue;
      const side: 'i' | 'o' = cross > 0 ? 'i' : 'o'; // CCW: left turn apexes inner
      segs.set(`${(i + n - 1) % n}:${side}`, { j: (i + n - 1) % n, side });
      segs.set(`${i}:${side}`, { j: i, side });
    }
    if (segs.size === 0) return null;

    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const { j, side } of segs.values()) {
      const loop = side === 'i' ? track.inner : track.outer;
      const cum = cums[side];
      for (const [k, vtx] of [j, (j + 1) % n].entries()) {
        const e = loop[vtx]!;
        const ex = fxToFloat(e.x);
        const ez = -fxToFloat(e.y);
        const cx = fxToFloat(cl(vtx).x);
        const cz = -fxToFloat(cl(vtx).y);
        const dl = Math.hypot(cx - ex, cz - ez) || 1;
        const y = hOf(vtx) + 0.022;
        const u = cum[j + k]! / 1.3;
        pos.push(ex, y, ez, ex + ((cx - ex) / dl) * W, y, ez + ((cz - ez) / dl) * W);
        uv.push(u, 0, u, 1);
      }
      const b = pos.length / 3 - 4;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        map: kerbTexture(),
        roughness: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    mesh.name = 'ground';
    return mesh;
  }

  /** Faded centerline dashes — road-marking flavor, fully cosmetic. */
  private buildLaneDashes(track: TrackRuntime): THREE.Mesh {
    const n = track.centerline.length;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = track.centerline[i]!;
      const b = track.centerline[(i + 1) % n]!;
      const ax = fxToFloat(a.x);
      const az = -fxToFloat(a.y);
      const bx = fxToFloat(b.x);
      const bz = -fxToFloat(b.y);
      const ha = fxToFloat(track.heights[i]!);
      const hb = fxToFloat(track.heights[(i + 1) % n]!);
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      // perpendicular for dash width
      const px = -dz * 0.09;
      const pz = dx * 0.09;
      for (let t = 3; t + 2 < len; t += 7) {
        const f0 = t / len;
        const f1 = (t + 2) / len;
        const y0 = ha + (hb - ha) * f0 + 0.02;
        const y1 = ha + (hb - ha) * f1 + 0.02;
        const x0 = ax + dx * t;
        const z0 = az + dz * t;
        const x1 = ax + dx * (t + 2);
        const z1 = az + dz * (t + 2);
        const b0 = pos.length / 3;
        pos.push(x0 - px, y0, z0 - pz, x0 + px, y0, z0 + pz, x1 - px, y1, z1 - pz, x1 + px, y1, z1 + pz);
        idx.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: '#e8e4cf',
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.name = 'ground';
    return mesh;
  }

  /** Painted starting-grid slots, numbered per seat. */
  private buildGridSlots(g: THREE.Group, track: TrackRuntime): void {
    track.spawns.forEach((s, i) => {
      const x = fxToFloat(s.x);
      const z = -fxToFloat(s.y);
      const geo = new THREE.PlaneGeometry(2.6, 1.5);
      geo.rotateX(-Math.PI / 2);
      const slot = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          map: gridSlotTexture(i + 1),
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
        }),
      );
      slot.position.set(x, this.terrain.heightAt(x, z) + 0.018, z);
      slot.rotation.y = (s.heading / 65536) * Math.PI * 2;
      g.add(slot);
    });
  }

  /** Grandstand + crowd at the start, billboards on the longest straights,
   *  floodlights on night tracks. All procedural, all deterministic. */
  private buildTrackside(g: THREE.Group, track: TrackRuntime): void {
    const th = track.def.theme;
    const n = track.centerline.length;
    const worldOf = (p: Vec2Fx) => new THREE.Vector3(fxToFloat(p.x), 0, -fxToFloat(p.y));

    // grandstand: three rising steps of spectators behind the start gate
    const sv = track.def.checkpointVerts[0]!;
    const cS = worldOf(track.centerline[sv]!);
    const fS = worldOf(track.fenceOuter[sv]!);
    const out = fS.clone().sub(cS).setY(0).normalize();
    const standPos = fS.clone().addScaledVector(out, 9);
    standPos.y = this.terrain.groundHeightAt(standPos.x, standPos.z);
    const stand = new THREE.Group();
    const standMat = new THREE.MeshStandardMaterial({ color: '#3a4150', roughness: 0.9 });
    const crowdMats = ['#e74a4a', '#ffd23f', '#3fd06b', '#5ea2ef', '#f2efe6', '#c879e0'].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }),
    );
    const headGeo = new THREE.BoxGeometry(0.34, 0.42, 0.3);
    for (let s = 0; s < 3; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(14, 0.9 + s * 0.85, 1.5), standMat);
      step.position.set(0, (0.9 + s * 0.85) / 2, -s * 1.5);
      stand.add(step);
      for (let i = 0; i < 18; i++) {
        if ((i * 31 + s * 17) % 5 === 0) continue; // empty seats read as real
        const fan = new THREE.Mesh(headGeo, crowdMats[(i * 7 + s * 11) % crowdMats.length]!);
        fan.position.set(-6.4 + i * 0.75, 0.9 + s * 0.85 + 0.22, -s * 1.5 + ((i * 13) % 3) * 0.06);
        stand.add(fan);
      }
    }
    // fascia: the sponsor banner across the grandstand's front edge
    const fascia = new THREE.Mesh(
      new THREE.PlaneGeometry(13.6, 0.55),
      new THREE.MeshBasicMaterial({ map: sponsorTexture(sponsorFor(track.def.id, 7), 512, 56) }),
    );
    fascia.position.set(0, 0.5, 0.77);
    stand.add(fascia);
    stand.position.copy(standPos);
    stand.lookAt(cS.x, standPos.y, cS.z);
    g.add(stand);

    // sponsor billboards on the two longest straights
    const segLen = (j: number) => {
      const a = track.centerline[j]!;
      const b = track.centerline[(j + 1) % n]!;
      return Math.hypot(fxToFloat(b.x) - fxToFloat(a.x), fxToFloat(b.y) - fxToFloat(a.y));
    };
    const order = Array.from({ length: n }, (_, j) => j).sort((a, b) => segLen(b) - segLen(a));
    order.slice(0, 2).forEach((j, bi) => {
      const mid = worldOf(track.centerline[j]!).lerp(worldOf(track.centerline[(j + 1) % n]!), 0.5);
      const fm = worldOf(track.fenceOuter[j]!).lerp(worldOf(track.fenceOuter[(j + 1) % n]!), 0.5);
      const dir = fm.clone().sub(mid).setY(0).normalize();
      const pos = fm.clone().addScaledVector(dir, 6.5);
      pos.y = this.terrain.groundHeightAt(pos.x, pos.z);
      const board = new THREE.Group();
      const postMat = new THREE.MeshStandardMaterial({ color: '#2a2e3a', roughness: 0.8 });
      for (const px of [-2.9, 2.9]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 4.4, 8), postMat);
        post.position.set(px, 2.2, 0);
        board.add(post);
      }
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(7.4, 3),
        new THREE.MeshBasicMaterial({
          map: sponsorTexture(sponsorFor(track.def.id, 10 + bi), 512, 208),
        }),
      );
      panel.position.set(0, 4.6, 0);
      board.add(panel);
      board.position.copy(pos);
      board.lookAt(mid.x, pos.y, mid.z);
      g.add(board);
    });

    // barrier ads: tiled sponsor panels hugging the outer fence along the
    // longest segments — the classic racing-barrier look
    order.slice(0, 6).forEach((j, k) => {
      const a = worldOf(track.fenceOuter[j]!);
      const b = worldOf(track.fenceOuter[(j + 1) % n]!);
      const segL = a.distanceTo(b);
      if (segL < 12) return;
      const sponsor = sponsorFor(track.def.id, k);
      const panelW = Math.min(segL * 0.62, 14);
      const mid = a.clone().lerp(b, 0.5);
      const cMid = worldOf(track.centerline[j]!).lerp(worldOf(track.centerline[(j + 1) % n]!), 0.5);
      const inwards = cMid.clone().sub(mid).setY(0).normalize();
      const tex = sponsorTexture(sponsor, 512, 80);
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = Math.max(1, Math.round(panelW / 4.5));
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(panelW, 0.58),
        new THREE.MeshBasicMaterial({ map: tex }),
      );
      panel.name = 'sponsor-barrier';
      panel.position.copy(mid).addScaledVector(inwards, 0.32);
      panel.position.y = this.terrain.heightAt(mid.x, mid.z) + 0.44;
      panel.lookAt(panel.position.clone().add(inwards));
      g.add(panel);
    });

    // painted sponsor on the asphalt just past the starting grid
    const gate0 = track.gates[0]!;
    const fwd = new THREE.Vector3(fxToFloat(gate0.nx), 0, -fxToFloat(gate0.ny));
    const paintPos = new THREE.Vector3(fxToFloat(gate0.cx), 0, -fxToFloat(gate0.cy)).addScaledVector(
      fwd,
      9,
    );
    const paintGeo = new THREE.PlaneGeometry(7.5, 2.4);
    paintGeo.rotateX(-Math.PI / 2);
    const paint = new THREE.Mesh(
      paintGeo,
      new THREE.MeshBasicMaterial({
        map: roadLogoTexture(sponsorFor(track.def.id, 8).name),
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    paint.position.set(
      paintPos.x,
      this.terrain.heightAt(paintPos.x, paintPos.z) + 0.019,
      paintPos.z,
    );
    paint.rotation.y = Math.atan2(-fwd.z, fwd.x);
    g.add(paint);

    // night tracks get floodlight gantries (the glow is bloom, not real light)
    if (th.night) {
      const poleMat = new THREE.MeshStandardMaterial({ color: '#222631', roughness: 0.7 });
      const headMat = new THREE.MeshStandardMaterial({
        color: '#eaf2ff',
        emissive: '#dfe8ff',
        emissiveIntensity: 2.4,
      });
      for (let k = 0; k < 4; k++) {
        const i = Math.floor((k * n) / 4);
        const cV = worldOf(track.centerline[i]!);
        const fV = worldOf(track.fenceOuter[i]!);
        const dir = fV.clone().sub(cV).setY(0).normalize();
        const pos = fV.clone().addScaledVector(dir, 4.5);
        pos.y = this.terrain.groundHeightAt(pos.x, pos.z);
        const rig = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 9.4, 8), poleMat);
        pole.position.y = 4.7;
        rig.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.7), headMat);
        head.position.set(0, 9.4, 0.4);
        head.rotation.x = 0.5; // tipped toward the track
        rig.add(head);
        rig.position.copy(pos);
        rig.lookAt(cV.x, pos.y, cV.z);
        g.add(rig);
      }
    }
  }

  /** Theme decor scattered just outside the fence, deterministically per vertex. */
  private buildDecor(g: THREE.Group, track: TrackRuntime): void {
    const th = track.def.theme;
    // textured decor: colour comes from the photo (material colour ~white so the
    // map shows natural), relief from the derived normal map. Snow foliage keeps
    // a tinted white material and borrows only the leaf normal (frosted, not green).
    const bark = surfaceMaps('/textures/decor_bark.png', { repeat: 2, repeatY: 2, normalStrength: 2.2 });
    const foliage = surfaceMaps('/textures/decor_foliage.png', { repeat: 1.6, normalStrength: 1.4 });
    const cactusTex = surfaceMaps('/textures/decor_cactus.png', { repeat: 2, repeatY: 3, normalStrength: 1.6 });
    const rockTex = surfaceMaps('/textures/decor_rock.png', { repeat: 1.4, normalStrength: 2.6 });
    const mats = {
      trunk: new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 0.95, map: bark?.map ?? null, normalMap: bark?.normal ?? null,
      }),
      leafGreen: new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 0.85, map: foliage?.map ?? null, normalMap: foliage?.normal ?? null,
      }),
      leafSnow: new THREE.MeshStandardMaterial({
        color: '#e8f1fb', roughness: 0.7, normalMap: foliage?.normal ?? null,
      }),
      cactus: new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 0.7, map: cactusTex?.map ?? null, normalMap: cactusTex?.normal ?? null,
      }),
      neonA: new THREE.MeshStandardMaterial({
        color: '#ff2e88',
        emissive: '#ff2e88',
        emissiveIntensity: 2.6,
      }),
      neonB: new THREE.MeshStandardMaterial({
        color: '#21e6c1',
        emissive: '#21e6c1',
        emissiveIntensity: 2.6,
      }),
      rock: new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 1, map: rockTex?.map ?? null, normalMap: rockTex?.normal ?? null,
      }),
    };
    this.neonMats = [mats.neonA, mats.neonB]; // pulsed each frame on night tracks

    const n = track.centerline.length;
    for (let i = 0; i < n; i++) {
      const c = track.centerline[i]!;
      const f = track.fenceOuter[i]!;
      const cx = fxToFloat(c.x);
      const cy = fxToFloat(c.y);
      const fx2 = fxToFloat(f.x);
      const fy2 = fxToFloat(f.y);
      let ox = fx2 - cx;
      let oy = fy2 - cy;
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol;
      oy /= ol;
      const dist = 7 + ((i * 37) % 13);
      const px = fx2 + ox * dist;
      const py = fy2 + oy * dist;
      const s = 0.9 + ((i * 13) % 8) / 9;

      const obj = new THREE.Group();
      switch (th.decor) {
        case 'trees':
        case 'snow': {
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * s, 0.34 * s, 2.6 * s, 9), mats.trunk);
          trunk.position.y = 1.3 * s;
          // overlapping faceted blobs read as a full, organic canopy — the
          // single cone looked like a toy Christmas tree
          const leafMat = th.decor === 'snow' ? mats.leafSnow : mats.leafGreen;
          const blob = (r: number, x: number, y: number, z: number): THREE.Mesh => {
            const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1), leafMat);
            m.position.set(x * s, y * s, z * s);
            m.rotation.set(i, i * 0.7, 0); // hide the shared facet seam per instance
            return m;
          };
          obj.add(trunk, blob(1.9, 0, 4.3, 0), blob(1.25, 1.1, 3.5, 0.4), blob(1.2, -1.0, 3.7, -0.5));
          break;
        }
        case 'cacti': {
          if (i % 3 === 0) {
            // lumpy boulder, squashed and rotated per instance for variety
            const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4 * s, 1), mats.rock);
            rock.scale.set(1, 0.72, 0.9 + ((i * 7) % 5) / 20);
            rock.rotation.set(i * 0.3, i, i * 0.2);
            rock.position.y = 0.85 * s;
            obj.add(rock);
          } else {
            // rounded cap so the body doesn't read as a cut pipe
            const cap = (r: number, y: number): THREE.Mesh => {
              const m = new THREE.Mesh(
                new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
                mats.cactus,
              );
              m.position.y = y;
              return m;
            };
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * s, 0.62 * s, 4.2 * s, 12), mats.cactus);
            body.position.y = 2.1 * s;
            obj.add(body, cap(0.5 * s, 4.2 * s));
            // saguaro arm: an elbow that turns up, capped — not a stick poking out
            const arm = (dir: number, baseY: number): THREE.Group => {
              const a = new THREE.Group();
              const horiz = new THREE.Mesh(new THREE.CylinderGeometry(0.24 * s, 0.27 * s, 1.1 * s, 10), mats.cactus);
              horiz.rotation.z = Math.PI / 2;
              horiz.position.set(dir * 0.55 * s, 0, 0);
              const vert = new THREE.Mesh(new THREE.CylinderGeometry(0.24 * s, 0.24 * s, 1.5 * s, 10), mats.cactus);
              vert.position.set(dir * 1.05 * s, 0.75 * s, 0);
              const tip = cap(0.24 * s, 1.5 * s);
              tip.position.x = dir * 1.05 * s;
              a.add(horiz, vert, tip);
              a.position.y = baseY;
              return a;
            };
            obj.add(arm(1, 2.7 * s), arm(-1, 2.0 * s));
          }
          break;
        }
        case 'neon': {
          const pylon = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 7 * s, 0.5),
            i % 2 === 0 ? mats.neonA : mats.neonB,
          );
          pylon.position.y = 3.5 * s;
          obj.add(pylon);
          break;
        }
      }
      obj.position.set(px, this.terrain.groundHeightAt(px, -py), -py);
      g.add(obj);
    }
  }

  /** Create kart visuals for a race. names[i] === null hides the name tag (local kart). */
  setupKarts(names: (string | null)[], looks?: KartLook[]): void {
    this.removeGhost(); // stale time-trial ghosts never leak into a new race
    for (const k of this.karts) {
      this.scene.remove(k.group);
      disposeTree(k.group);
    }
    this.karts = [];
    names.forEach((name, i) => {
      const visual = buildKart(looks?.[i] ?? defaultLook(i), name);
      const spawn = this.track.spawns[i]!;
      visual.group.position.copy(toV3(spawn.x, spawn.y));
      visual.group.position.y = this.terrain.heightAt(
        visual.group.position.x,
        visual.group.position.z,
      );
      visual.group.rotation.y = (spawn.heading / 65536) * Math.PI * 2;
      this.karts.push(visual);
      this.scene.add(visual.group);
    });
    this.camInit = false;
  }

  /** Park the demo karts on the grid (home/lobby backdrop). */
  setupIdleKarts(): void {
    this.setupKarts([null, null, null, null]);
  }

  /** Translucent ghost kart for time trials (label floats above it). */
  setupGhost(label: string): void {
    this.removeGhost();
    const v = buildKart({ primary: '#dfe7f5', accent: '#9fb4d8', flame: '#9fd0ff' }, label);
    v.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        m.transparent = true;
        m.opacity = 0.35;
        m.depthWrite = false;
      }
    });
    v.group.visible = false;
    this.ghost = v;
    this.scene.add(v.group);
  }

  removeGhost(): void {
    if (!this.ghost) return;
    this.scene.remove(this.ghost.group);
    disposeTree(this.ghost.group);
    this.ghost = null;
  }

  /** Pose the ghost for this frame; null hides it (pre-start, post-finish). */
  updateGhost(k: KartRender | null): void {
    const v = this.ghost;
    if (!v) return;
    v.group.visible = k !== null;
    if (!k) return;
    v.group.position.set(k.x, this.terrain.heightAt(k.x, k.z) + k.jump, k.z);
    v.group.rotation.y = k.headingRad;
    v.group.rotation.z = Math.atan(this.terrain.slopeAlong(k.x, k.z, k.headingRad));
    v.flame.visible = k.boosting;
    v.sparkL.visible = false;
    v.sparkR.visible = false;
  }

  updateRace(karts: KartRender[], state: GameState, localIdx: number, dt: number): void {
    this.t += dt;
    karts.forEach((k, i) => {
      const v = this.karts[i];
      if (!v) return;
      const gy = this.terrain.heightAt(k.x, k.z) + k.jump;
      v.group.position.set(k.x, gy, k.z);
      // spin-out: two full visual turns over the spin duration
      const spinYaw =
        k.spinTicks > 0 ? ((SPIN_OUT_TICKS - k.spinTicks) / SPIN_OUT_TICKS) * Math.PI * 4 : 0;
      v.group.rotation.y = k.headingRad + spinYaw;
      // nose follows the road grade; airborne karts hold a slight nose-up
      const targetPitch =
        k.jump > 0.05 ? 0.12 : Math.atan(this.terrain.slopeAlong(k.x, k.z, k.headingRad));
      v.pitch += (targetPitch - v.pitch) * Math.min(1, dt * 8);
      v.group.rotation.z = v.pitch;

      // wheels roll with speed; the front pair steers with the yaw rate
      let dYaw = k.headingRad - v.prevHeading;
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      v.prevHeading = k.headingRad;
      const yawRate = dYaw / Math.max(dt, 1 / 240);
      const roll = (k.speed * 60 * dt) / 0.32; // radians of wheel this frame (wheel radius)
      const steerTarget = THREE.MathUtils.clamp(yawRate / 3.4, -0.42, 0.42);
      v.steer += (steerTarget - v.steer) * Math.min(1, dt * 12);
      for (const w of v.wheels) {
        w.mesh.rotation.z -= roll;
        if (w.front) w.mesh.rotation.y = v.steer;
      }

      // chassis rolls outward through corners (more in a drift), and the
      // suspension squashes on touchdown
      const leanTarget = THREE.MathUtils.clamp(
        yawRate * k.speed * 1.0 + (k.driftDir !== 0 ? k.driftDir * 0.05 : 0),
        -0.14,
        0.14,
      );
      v.lean += (leanTarget - v.lean) * Math.min(1, dt * 7);
      v.bodyTilt.rotation.x = v.lean;
      v.squash += (1 - v.squash) * Math.min(1, dt * 9);
      v.bodyTilt.scale.set(1 + (1 - v.squash) * 0.5, v.squash, 1 + (1 - v.squash) * 0.5);
      // battle balloons: show what's left, burst on every pop
      if (state.cfg.mode === 'battle') {
        const bal = state.karts[i]?.balloons ?? 0;
        v.balloons.forEach((m, bi) => {
          m.visible = bi < bal;
        });
        if (bal < v.prevBalloons) {
          this.spawnBurst(new THREE.Vector3(k.x, gy + 1.7, k.z));
        }
        v.prevBalloons = bal;
      }
      // crossing the line pops confetti (race mode; battle "finish" = elimination)
      if (k.finished && !v.wasFinished && state.cfg.mode !== 'battle') {
        for (let ci = 0; ci < 70; ci++) {
          const a = (ci / 70) * Math.PI * 2;
          const sp = 1 + Math.random() * 2.2;
          this.particles.emit(
            k.x + (Math.random() - 0.5) * 1.6, gy + 1.4, k.z + (Math.random() - 0.5) * 1.6,
            Math.cos(a) * sp, 5 + Math.random() * 4.5, Math.sin(a) * sp,
            CONFETTI[ci % CONFETTI.length]!, 0.9 + Math.random() * 0.5, gy,
          );
        }
      }
      v.wasFinished = k.finished;
      // touchdown: dust poof, suspension squash, a kick for the local camera
      const airNow = k.jump > 0.02;
      if (v.airborne && !airNow) {
        const ground = gy - k.jump;
        for (let n = 0; n < 10; n++) {
          const a = (n / 10) * Math.PI * 2;
          this.particles.emit(
            k.x + Math.cos(a) * 0.5, ground + 0.06, k.z + Math.sin(a) * 0.5,
            Math.cos(a) * 2.4, 0.9, Math.sin(a) * 2.4,
            DUST_COLOR, 0.35, ground,
          );
        }
        v.squash = 0.68;
        if (i === localIdx) this.shake = Math.max(this.shake, 0.32);
      }
      v.airborne = airNow;
      v.flame.visible = k.boosting;
      if (k.boosting) {
        const s = 0.85 + Math.random() * 0.5;
        v.flame.scale.set(s, s, s);
      }
      const drifting = k.driftDir !== 0;
      v.sparkL.visible = drifting;
      v.sparkR.visible = drifting;
      if (drifting) {
        v.sparkMat.color
          .set(k.driftCharge >= 110 ? '#ff9b2f' : k.driftCharge >= 50 ? '#5ee1ff' : '#cfd8e3')
          .multiplyScalar(2.2); // HDR so the sparks bloom
        const s = 0.7 + Math.random() * 0.9;
        v.sparkL.scale.set(s, s, s);
        v.sparkR.scale.set(s, s, s);
      }

      // particle emission, in the kart's frame (rotation.y maps local → world)
      const yaw = v.group.rotation.y;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const worldX = (lx: number, lz: number) => k.x + lx * cy + lz * sy;
      const worldZ = (lx: number, lz: number) => k.z - lx * sy + lz * cy;

      if (drifting && k.speed > 0.08) {
        // spark spray off the rear wheels, tier-colored like the wheel glow
        for (let n = 0; n < 3; n++) {
          const side = n % 2 === 0 ? 0.55 : -0.55;
          const lvx = -(1.5 + Math.random() * 2.5);
          const lvz = side * (0.6 + Math.random() * 1.6);
          this.particles.emit(
            worldX(-0.62, side), gy + 0.12, worldZ(-0.62, side),
            lvx * cy + lvz * sy, 1.2 + Math.random() * 2.2, -lvx * sy + lvz * cy,
            v.sparkMat.color, 0.22 + Math.random() * 0.18, gy,
          );
        }
        // skid marks under both rear wheels at a fixed cadence
        v.skidAcc += dt;
        while (v.skidAcc > 0.034) {
          v.skidAcc -= 0.034;
          this.skids.stamp(worldX(-0.62, 0.55), worldZ(-0.62, 0.55), yaw, gy + 0.018);
          this.skids.stamp(worldX(-0.62, -0.55), worldZ(-0.62, -0.55), yaw, gy + 0.018);
        }
      } else {
        v.skidAcc = 0;
      }

      if (k.boosting && !k.finished) {
        // ember trail streaming out of the exhaust flame
        for (let n = 0; n < 2; n++) {
          const lvx = -(3.5 + Math.random() * 3);
          const lvz = (Math.random() - 0.5) * 1.2;
          this.particles.emit(
            worldX(-1.1, (Math.random() - 0.5) * 0.3),
            gy + 0.45 + (Math.random() - 0.5) * 0.2,
            worldZ(-1.1, (Math.random() - 0.5) * 0.3),
            lvx * cy + lvz * sy, 0.4 + Math.random(), -lvx * sy + lvz * cy,
            EMBER_COLOR, 0.28, gy,
          );
        }
      }

      if (k.onDirt && k.speed > 0.18 && !k.boosting) {
        // dust kicked up while ploughing through the dirt margin
        const lz = (Math.random() - 0.5) * 0.9;
        const lvx = -(0.5 + Math.random());
        this.particles.emit(
          worldX(-0.8, lz), gy + 0.08, worldZ(-0.8, lz),
          lvx * cy, 1.2 + Math.random() * 1.5, -lvx * sy,
          DUST_COLOR, 0.45 + Math.random() * 0.3, gy,
        );
      }
    });
    this.particles.update(dt);
    this.skids.update(dt);
    this.pulseNeon();
    if (this.cloudSpin) this.cloudSpin.rotation.y += dt * 0.004;

    this.updateItems(state, dt);
    this.updateShards(dt);
    this.updatePads();
    this.updateProjectiles(state);

    // chase camera on the local kart; rearview mirrors it to the nose,
    // looking back (snap on toggle — lerping would sweep through the kart)
    const me = karts[localIdx];
    if (me) {
      if (this.rearview !== this.prevRearview) {
        this.prevRearview = this.rearview;
        this.camInit = false;
      }
      const facing = this.rearview ? -1 : 1;
      // low-pass the yaw the camera is built from, so the bot's per-tick
      // steering dither (and twitchy human input) doesn't swing the whole
      // view — sustained turns pass through, the high-frequency dither filters
      // out. Shares the position lerp's time constant so the camera's position
      // and orientation move coherently; snaps on (re)init like the position.
      const f = 1 - Math.pow(0.0008, dt);
      if (!this.camInit) this.camYaw = me.headingRad;
      else this.camYaw = lerpAngle(this.camYaw, me.headingRad, f);
      const dir = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
      const desired = new THREE.Vector3(me.x, 0, me.z).addScaledVector(dir, -7.6 * facing);
      // ride the terrain: sample under the camera so crests drop away ahead;
      // boosting pulls the camera lower for a sense of speed
      this.camDip += ((me.boosting ? 0.6 : 0) - this.camDip) * Math.min(1, dt * 4);
      desired.y = this.terrain.heightAt(desired.x, desired.z) + 4.1 - this.camDip;
      const meY = this.terrain.heightAt(me.x, me.z);
      const look = new THREE.Vector3(me.x, meY + 1.1, me.z).addScaledVector(dir, 4.0 * facing);
      if (!this.camInit) {
        this.camera.position.copy(desired);
        this.camInit = true;
      } else {
        this.camera.position.lerp(desired, f);
      }
      this.camera.lookAt(look);
      // bank gently into drifts
      this.camRoll += ((me.driftDir !== 0 ? me.driftDir * 0.045 : 0) - this.camRoll) * Math.min(1, dt * 5);
      this.camera.rotateZ(this.camRoll);
      const targetFov = me.boosting ? 76 : 64;
      if (Math.abs(this.camera.fov - targetFov) > 0.1) {
        this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 6);
        this.camera.updateProjectionMatrix();
      }

      // spin-out: one hard camera-shake impulse, decaying
      if (me.spinTicks > 0 && this.prevLocalSpin === 0) this.shake = 1;
      this.prevLocalSpin = me.spinTicks;
      if (this.shake > 0) {
        this.shake = Math.max(0, this.shake - dt * 1.7);
        const s = this.shake * this.shake * 0.5;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
        this.camera.position.z += (Math.random() - 0.5) * s;
      }

      // radial speed lines: faint near top speed (0.42), strong while boosting
      const target = me.finished
        ? 0
        : Math.max(me.boosting ? 0.9 : 0, Math.min(1, (me.speed - 0.36) / 0.19) * 0.4);
      this.speedLineLevel += (target - this.speedLineLevel) * Math.min(1, dt * 5);
      this.speedLines.uniforms.uIntensity!.value = this.speedLineLevel;
      this.speedLines.uniforms.uTime!.value = this.t;
      this.speedLines.enabled = this.speedLineLevel > 0.02;
    }
    this.weather?.update(dt, this.camera.position.x, this.camera.position.z);
    this.composer.render();
  }

  private updateProjectiles(state: GameState | null): void {
    this.shellMeshes.forEach((mesh, i) => {
      const s = state?.shells[i];
      mesh.visible = !!s && s.ttl > 0;
      if (s && s.ttl > 0) {
        const sx = fxToFloat(s.x);
        const sz = -fxToFloat(s.y);
        mesh.position.set(sx, this.terrain.heightAt(sx, sz) + fxToFloat(SHELL_RADIUS), sz);
        mesh.rotation.y = this.t * 9; // menacing wobble-spin
        (mesh.material as THREE.MeshStandardMaterial).color.set(
          s.homing === 1 ? '#ff4757' : '#3fd06b',
        );
      }
    });
    this.oilMeshes.forEach((mesh, i) => {
      const o = state?.oils[i];
      mesh.visible = !!o && o.ttl > 0;
      if (o && o.ttl > 0) {
        const ox = fxToFloat(o.x);
        const oz = -fxToFloat(o.y);
        mesh.position.set(ox, this.terrain.heightAt(ox, oz) + 0.03, oz);
        const m = mesh.material as THREE.MeshStandardMaterial;
        m.opacity = Math.min(0.9, o.ttl / 90); // fade out as it expires
      }
    });
  }

  private updatePads(): void {
    this.padMeshes.forEach((mesh, i) => {
      const m = mesh.material as THREE.MeshBasicMaterial;
      m.opacity = 0.65 + Math.sin(this.t * 4.5 + i * 1.7) * 0.25;
    });
  }

  /** Box-break burst: gold shards thrown from the pickup point. */
  private spawnBurst(pos: THREE.Vector3): void {
    for (let n = 0; n < 8; n++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ffd23f').multiplyScalar(2), // HDR: shards bloom
        transparent: true,
      });
      const mesh = new THREE.Mesh(this.shardGeo, mat);
      mesh.position.copy(pos);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      const a = (n / 8) * Math.PI * 2 + Math.random() * 0.5;
      this.shards.push({
        mesh,
        vx: Math.cos(a) * (2.5 + Math.random() * 2),
        vz: Math.sin(a) * (2.5 + Math.random() * 2),
        vy: 3.5 + Math.random() * 2.5,
        life: 0.6,
        floor: pos.y - 0.9, // roughly the road under the floating pickup
      });
      this.scene.add(mesh);
    }
  }

  private updateShards(dt: number): void {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        this.shards.splice(i, 1);
        continue;
      }
      s.vy -= 14 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y = Math.max(s.floor + 0.1, s.mesh.position.y + s.vy * dt);
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += dt * 7;
      s.mesh.rotation.y += dt * 9;
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = s.life / 0.6;
    }
  }

  private updateItems(state: GameState | null, dt: number): void {
    this.itemMeshes.forEach((mesh, i) => {
      const active = state ? isItemActive(state, i) : true;
      if (active && !this.itemWasActive[i]) this.itemPop[i] = 0;
      // someone just took this box: break it apart where it floats
      if (!active && this.itemWasActive[i]) this.spawnBurst(mesh.position);
      this.itemWasActive[i] = active;
      mesh.visible = active;
      if (active) {
        this.itemPop[i] = Math.min(1, this.itemPop[i]! + dt * 3.5);
        const pop = this.itemPop[i]!;
        const s = pop * (1 + Math.sin(this.t * 2.1 + i) * 0.05);
        mesh.scale.set(s, s, s);
        // spin around y only so the badge keeps its point-down silhouette
        mesh.rotation.y += dt * 1.4;
        mesh.position.y = this.itemBaseY[i]! + 0.95 + Math.sin(this.t * 1.7 + i * 1.3) * 0.12;
      }
    });
  }

  updateIdle(dt: number): void {
    this.t += dt;
    this.idleAngle += dt * 0.07;
    this.camera.position.set(
      this.orbit.cx + Math.cos(this.idleAngle) * this.orbit.radius,
      this.orbit.height,
      this.orbit.cz + Math.sin(this.idleAngle) * this.orbit.radius,
    );
    this.camera.lookAt(this.orbit.cx, 0, this.orbit.cz);
    if (Math.abs(this.camera.fov - 58) > 0.1) {
      this.camera.fov = 58;
      this.camera.updateProjectionMatrix();
    }
    this.updateItems(null, dt);
    this.updateShards(dt);
    this.updatePads();
    this.updateProjectiles(null);
    this.particles.update(dt);
    this.skids.update(dt);
    this.pulseNeon();
    if (this.cloudSpin) this.cloudSpin.rotation.y += dt * 0.004;
    this.weather?.update(dt, this.camera.position.x, this.camera.position.z);
    this.speedLineLevel = 0;
    this.speedLines.enabled = false;
    this.composer.render();
  }

  /** Night-track neon pylons breathe across the bloom threshold. */
  private pulseNeon(): void {
    this.neonMats.forEach((m, i) => {
      m.emissiveIntensity = 2.4 + Math.sin(this.t * 2.6 + i * 2.4) * 0.9;
    });
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.speedLines.uniforms.uAspect!.value = w / h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Change effective render resolution. DPR-only; safe to call any frame (no recompiles). */
  setRenderScale(dpr: number): void {
    const d = Math.min(dpr, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(d);
    this.composer.setPixelRatio(d); // MUST also scale the offscreen targets the composer renders into
    this.resize(); // commit to the drawing buffer (setPixelRatio alone doesn't resize)
  }

  effectiveDpr(): number {
    return this.renderer.getPixelRatio();
  }
}
