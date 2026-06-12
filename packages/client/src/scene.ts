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
import type { KartRender } from './game.js';

export const KART_COLORS = ['#ff4757', '#2e86ff', '#ffd23f', '#3fd06b'];

const toV3 = (x: number, y: number) => new THREE.Vector3(fxToFloat(x), 0, -fxToFloat(y));
const yawOf = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(-(b.z - a.z), b.x - a.x);

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as Partial<THREE.Mesh & THREE.Sprite>;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const tex = (m as THREE.MeshBasicMaterial).map;
        if (tex) tex.dispose();
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
  flame: THREE.Mesh;
  sparkL: THREE.Mesh;
  sparkR: THREE.Mesh;
  sparkMat: THREE.MeshBasicMaterial;
  skidAcc: number;
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

function buildKart(look: KartLook, name: string | null): KartVisual {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: look.primary, roughness: 0.5, metalness: 0.15 });
  const accentMat = new THREE.MeshStandardMaterial({ color: look.accent, roughness: 0.5, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1c1f26', roughness: 0.9 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.42, 0.92), mat);
  body.position.y = 0.42;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.55), accentMat);
  nose.position.set(0.95, 0.38, 0);
  group.add(nose);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.95), accentMat);
  spoiler.position.set(-0.78, 0.72, 0);
  group.add(spoiler);

  const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.24, 14);
  for (const [wx, wz] of [
    [0.55, 0.52],
    [0.55, -0.52],
    [-0.55, 0.52],
    [-0.55, -0.52],
  ] as const) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.x = Math.PI / 2;
    w.position.set(wx, 0.28, wz);
    group.add(w);
  }

  const headMat = new THREE.MeshStandardMaterial({ color: '#f2c8a0', roughness: 0.8 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.5), dark);
  torso.position.set(-0.15, 0.78, 0);
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), headMat);
  head.position.set(-0.15, 1.12, 0);
  group.add(head);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6),
    mat,
  );
  helmet.position.set(-0.15, 1.14, 0);
  group.add(helmet);

  // real shadows from the sun replace the old blob-shadow disc
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });

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
  group.add(flame);

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

  if (name) group.add(nameSprite(name, look.primary));
  return { group, flame, sparkL, sparkR, sparkMat, skidAcc: 0 };
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
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private head = 0;

  constructor(private readonly n: number, size: number) {
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.baseCol = new Float32Array(n * 3);
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1000), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const mat = new THREE.PointsMaterial({
      size,
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
    color: THREE.Color, life: number,
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
      if (pos[j + 1]! < 0.04) {
        pos[j + 1] = 0.04;
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

  stamp(x: number, z: number, yaw: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    const m = this.meshes[i]!;
    m.position.x = x;
    m.position.z = z;
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
      size: kind === 'snow' ? 0.14 : kind === 'dust' ? 0.1 : 0.17,
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
  private particles = new ParticlePool(512, 0.17);
  private skids: SkidPool;
  private weather: WeatherField | null = null;
  private neonMats: THREE.MeshStandardMaterial[] = [];
  private shake = 0;
  private prevLocalSpin = 0;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;

  private world: THREE.Group | null = null;
  private worldTrackId: string | null = null;
  private track: TrackRuntime = getTrack(undefined);

  private karts: KartVisual[] = [];
  private itemMeshes: THREE.Mesh[] = [];
  private itemWasActive: boolean[] = [];
  private itemPop: number[] = [];
  private padMeshes: THREE.Mesh[] = [];
  private shellMeshes: THREE.Mesh[] = [];
  private oilMeshes: THREE.Mesh[] = [];
  private shards: { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number }[] = [];
  private shardGeo = new THREE.BoxGeometry(0.26, 0.26, 0.26);

  private ghost: KartVisual | null = null;
  private orbit = { cx: 0, cz: 0, radius: 95, height: 42 };
  private idleAngle = 0;
  private camInit = false;
  private t = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    const shellMat = new THREE.MeshStandardMaterial({ color: '#3fd06b', roughness: 0.35, metalness: 0.2 });
    const shellRimMat = new THREE.MeshStandardMaterial({ color: '#f4f7ef', roughness: 0.6 });
    for (let i = 0; i < MAX_SHELLS; i++) {
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(fxToFloat(SHELL_RADIUS), 14, 10),
        shellMat,
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

    this.setTrack(getTrack(undefined));
    this.resize();
    window.addEventListener('resize', () => this.resize());
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
    this.worldTrackId = track.def.id;
    this.itemMeshes = [];
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
    this.world = this.buildWorld(track);
    this.scene.add(this.world);
    this.applyTheme(track);
    this.computeOrbit(track);
    this.camInit = false;
  }

  private applyTheme(track: TrackRuntime): void {
    const th = track.def.theme;
    this.scene.background = new THREE.Color(th.sky);
    this.scene.fog = new THREE.Fog(th.fog, 150, 680);
    this.bloom.strength = th.night ? 1.05 : 0.7;
    if (this.weather) {
      this.scene.remove(this.weather.points);
      this.weather.dispose();
      this.weather = null;
    }
    if (th.weather) {
      this.weather = new WeatherField(th.weather);
      this.scene.add(this.weather.points);
    }
    if (th.night) {
      this.sun.intensity = 0.95;
      this.sun.color.set('#aabfff');
      this.hemi.intensity = 1.0;
      this.hemi.color.set('#5a6a9e');
      this.hemi.groundColor.set('#1a1e36');
    } else {
      this.sun.intensity = 1.6;
      this.sun.color.set('#fff3d6');
      this.hemi.intensity = 1.05;
      this.hemi.color.set('#cfe6ff');
      this.hemi.groundColor.set(th.ground);
    }
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

    // aim the sun (and its shadow box) at this track
    const r = extent * 0.75 + 30;
    this.sun.position.set(this.orbit.cx + r * 0.5, r * 0.95, this.orbit.cz + r * 0.35);
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

  private buildWorld(track: TrackRuntime): THREE.Group {
    const g = new THREE.Group();
    const th = track.def.theme;

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(700, 48),
      new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    ground.name = 'ground';
    g.add(ground);

    // dirt corridor (fence to fence) under the asphalt — only if the track has dirt
    if (track.hasDirt) {
      const dirtShape = new THREE.Shape(loopShapePoints(track.fenceOuter));
      dirtShape.holes.push(new THREE.Path(loopShapePoints(track.fenceInner)));
      const dirtGeo = new THREE.ShapeGeometry(dirtShape, 4);
      dirtGeo.rotateX(-Math.PI / 2);
      const dirt = new THREE.Mesh(
        dirtGeo,
        new THREE.MeshStandardMaterial({ color: th.dirt, roughness: 1 }),
      );
      dirt.position.y = 0.0;
      dirt.name = 'ground';
      g.add(dirt);
    }

    // asphalt ribbon on top
    const shape = new THREE.Shape(loopShapePoints(track.outer));
    shape.holes.push(new THREE.Path(loopShapePoints(track.inner)));
    const trackGeo = new THREE.ShapeGeometry(shape, 4);
    trackGeo.rotateX(-Math.PI / 2);
    const asphalt = new THREE.Mesh(
      trackGeo,
      new THREE.MeshStandardMaterial({ color: th.asphalt, roughness: 0.95 }),
    );
    asphalt.position.y = 0.015;
    asphalt.name = 'ground';
    g.add(asphalt);

    // walls along the fence — the exact segments the sim collides with
    const wallMatA = new THREE.MeshStandardMaterial({
      color: th.wallA,
      roughness: 0.7,
      emissive: th.night ? th.wallA : '#000000',
      emissiveIntensity: th.night ? 0.55 : 0,
    });
    const wallMatB = new THREE.MeshStandardMaterial({
      color: th.wallB,
      roughness: 0.7,
      emissive: th.night ? th.wallB : '#000000',
      emissiveIntensity: th.night ? 0.55 : 0,
    });
    track.walls.forEach((w, i) => {
      const a = toV3(w.x0, w.y0);
      const b = toV3(w.x1, w.y1);
      const lenW = a.distanceTo(b);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(lenW + 0.3, 0.85, 0.55),
        i % 2 === 0 ? wallMatA : wallMatB,
      );
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.position.y = 0.42;
      mesh.rotation.y = yawOf(a, b);
      g.add(mesh);
    });

    // start/finish anchored to the ASPHALT edge (gates span the dirt fence)
    const startVert = track.def.checkpointVerts[0]!;
    const g0 = toV3(track.inner[startVert]!.x, track.inner[startVert]!.y);
    const g1 = toV3(track.outer[startVert]!.x, track.outer[startVert]!.y);
    const gateLen = g0.distanceTo(g1);
    const gateMid = g0.clone().add(g1).multiplyScalar(0.5);
    const gateYaw = yawOf(g0, g1);

    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(gateLen, 2.2),
      new THREE.MeshBasicMaterial({ map: checkerTexture(16, 3) }),
    );
    strip.rotation.x = -Math.PI / 2;
    strip.rotation.z = gateYaw;
    strip.position.copy(gateMid).setY(0.03);
    g.add(strip);

    const postGeo = new THREE.BoxGeometry(0.35, 5.6, 0.35);
    const postMat = new THREE.MeshStandardMaterial({ color: '#22252e', roughness: 0.6 });
    for (const end of [g0, g1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.copy(end).setY(2.8);
      g.add(post);
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(gateLen, 1.4),
      new THREE.MeshBasicMaterial({ map: checkerTexture(20, 2), side: THREE.DoubleSide }),
    );
    banner.position.copy(gateMid).setY(5.0);
    banner.rotation.y = gateYaw;
    g.add(banner);

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
      mesh.position.set(fxToFloat(p.cx), 0.025, -fxToFloat(p.cy));
      mesh.rotation.y = Math.atan2(fxToFloat(p.dy), fxToFloat(p.dx));
      g.add(mesh);
      this.padMeshes.push(mesh);
    }

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
      mesh.position.copy(toV3(spawn.x, spawn.y)).setY(0.95);
      g.add(mesh);
      this.itemMeshes.push(mesh);
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

  /** Theme decor scattered just outside the fence, deterministically per vertex. */
  private buildDecor(g: THREE.Group, track: TrackRuntime): void {
    const th = track.def.theme;
    const mats = {
      trunk: new THREE.MeshStandardMaterial({ color: '#6b4a2c', roughness: 1 }),
      leafGreen: new THREE.MeshStandardMaterial({ color: '#2f7a3a', roughness: 1 }),
      leafSnow: new THREE.MeshStandardMaterial({ color: '#dfeaf4', roughness: 1 }),
      cactus: new THREE.MeshStandardMaterial({ color: '#4e8f3c', roughness: 0.9 }),
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
      rock: new THREE.MeshStandardMaterial({ color: '#8d7a5c', roughness: 1 }),
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
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, 0.4 * s, 2.2 * s, 8), mats.trunk);
          trunk.position.y = 1.1 * s;
          const leaf = new THREE.Mesh(
            new THREE.ConeGeometry(1.8 * s, 4.4 * s, 10),
            th.decor === 'snow' ? mats.leafSnow : mats.leafGreen,
          );
          leaf.position.y = 4.0 * s;
          obj.add(trunk, leaf);
          break;
        }
        case 'cacti': {
          if (i % 3 === 0) {
            const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.4 * s, 0), mats.rock);
            rock.position.y = 0.7 * s;
            obj.add(rock);
          } else {
            const bodyC = new THREE.Mesh(new THREE.CylinderGeometry(0.55 * s, 0.65 * s, 4.4 * s, 8), mats.cactus);
            bodyC.position.y = 2.2 * s;
            const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, 0.3 * s, 1.6 * s, 8), mats.cactus);
            armL.position.set(0.85 * s, 2.6 * s, 0);
            const armR = armL.clone();
            armR.position.set(-0.85 * s, 1.9 * s, 0);
            obj.add(bodyC, armL, armR);
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
      obj.position.set(px, 0, -py);
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
    v.group.position.set(k.x, 0, k.z);
    v.group.rotation.y = k.headingRad;
    v.flame.visible = k.boosting;
    v.sparkL.visible = false;
    v.sparkR.visible = false;
  }

  updateRace(karts: KartRender[], state: GameState, localIdx: number, dt: number): void {
    this.t += dt;
    karts.forEach((k, i) => {
      const v = this.karts[i];
      if (!v) return;
      v.group.position.set(k.x, 0, k.z);
      // spin-out: two full visual turns over the spin duration
      const spinYaw =
        k.spinTicks > 0 ? ((SPIN_OUT_TICKS - k.spinTicks) / SPIN_OUT_TICKS) * Math.PI * 4 : 0;
      v.group.rotation.y = k.headingRad + spinYaw;
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
            worldX(-0.62, side), 0.12, worldZ(-0.62, side),
            lvx * cy + lvz * sy, 1.2 + Math.random() * 2.2, -lvx * sy + lvz * cy,
            v.sparkMat.color, 0.22 + Math.random() * 0.18,
          );
        }
        // skid marks under both rear wheels at a fixed cadence
        v.skidAcc += dt;
        while (v.skidAcc > 0.034) {
          v.skidAcc -= 0.034;
          this.skids.stamp(worldX(-0.62, 0.55), worldZ(-0.62, 0.55), yaw);
          this.skids.stamp(worldX(-0.62, -0.55), worldZ(-0.62, -0.55), yaw);
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
            0.45 + (Math.random() - 0.5) * 0.2,
            worldZ(-1.1, (Math.random() - 0.5) * 0.3),
            lvx * cy + lvz * sy, 0.4 + Math.random(), -lvx * sy + lvz * cy,
            EMBER_COLOR, 0.28,
          );
        }
      }

      if (k.onDirt && k.speed > 0.18 && !k.boosting) {
        // dust kicked up while ploughing through the dirt margin
        const lz = (Math.random() - 0.5) * 0.9;
        const lvx = -(0.5 + Math.random());
        this.particles.emit(
          worldX(-0.8, lz), 0.08, worldZ(-0.8, lz),
          lvx * cy, 1.2 + Math.random() * 1.5, -lvx * sy,
          DUST_COLOR, 0.45 + Math.random() * 0.3,
        );
      }
    });
    this.particles.update(dt);
    this.skids.update(dt);
    this.pulseNeon();

    this.updateItems(state, dt);
    this.updateShards(dt);
    this.updatePads();
    this.updateProjectiles(state);

    // chase camera on the local kart
    const me = karts[localIdx];
    if (me) {
      const dir = new THREE.Vector3(Math.cos(me.headingRad), 0, -Math.sin(me.headingRad));
      const desired = new THREE.Vector3(me.x, 0, me.z)
        .addScaledVector(dir, -7.6)
        .add(new THREE.Vector3(0, 4.1, 0));
      const look = new THREE.Vector3(me.x, 1.1, me.z).addScaledVector(dir, 4.0);
      if (!this.camInit) {
        this.camera.position.copy(desired);
        this.camInit = true;
      } else {
        const f = 1 - Math.pow(0.0008, dt);
        this.camera.position.lerp(desired, f);
      }
      this.camera.lookAt(look);
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
        mesh.position.set(fxToFloat(s.x), fxToFloat(SHELL_RADIUS), -fxToFloat(s.y));
        mesh.rotation.y = this.t * 9; // menacing wobble-spin
      }
    });
    this.oilMeshes.forEach((mesh, i) => {
      const o = state?.oils[i];
      mesh.visible = !!o && o.ttl > 0;
      if (o && o.ttl > 0) {
        mesh.position.set(fxToFloat(o.x), 0.03, -fxToFloat(o.y));
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
      s.mesh.position.y = Math.max(0.1, s.mesh.position.y + s.vy * dt);
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
        mesh.position.y = 0.95 + Math.sin(this.t * 1.7 + i * 1.3) * 0.12;
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
}
