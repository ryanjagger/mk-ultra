/**
 * Three.js rendering. Reads sim state, never writes it (NFR-7). World
 * geometry is derived from the same TrackRuntime the sim collides against,
 * converted to floats at this boundary. The world is a swappable, fully
 * disposed THREE.Group so rooms can change tracks freely.
 */
import * as THREE from 'three';
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

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.0, 18),
    new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.3 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.95, 10),
    new THREE.MeshBasicMaterial({ color: look.flame, transparent: true, opacity: 0.92 }),
  );
  flame.rotation.z = Math.PI / 2; // apex points -x (backwards)
  flame.position.set(-1.05, 0.45, 0);
  flame.visible = false;
  group.add(flame);

  const sparkMat = new THREE.MeshBasicMaterial({ color: '#9bd6ff', transparent: true, opacity: 0.95 });
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
  return { group, flame, sparkL, sparkR, sparkMat };
}

function loopShapePoints(loop: Vec2Fx[]): THREE.Vector2[] {
  return loop.map((p) => new THREE.Vector2(fxToFloat(p.x), fxToFloat(p.y)));
}

export class GameScene {
  private renderer: THREE.WebGLRenderer;
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

  private orbit = { cx: 0, cz: 0, radius: 95, height: 42 };
  private idleAngle = 0;
  private camInit = false;
  private t = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(64, 1, 0.1, 900);

    this.hemi = new THREE.HemisphereLight('#cfe6ff', '#3e6b3a', 1.05);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3d6', 1.6);
    this.sun.position.set(60, 90, 40);
    this.scene.add(this.sun);

    // projectile/hazard pools live outside the swappable world group
    const shellMat = new THREE.MeshStandardMaterial({ color: '#3fd06b', roughness: 0.35, metalness: 0.2 });
    const shellRimMat = new THREE.MeshStandardMaterial({ color: '#f4f7ef', roughness: 0.6 });
    for (let i = 0; i < MAX_SHELLS; i++) {
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(fxToFloat(SHELL_RADIUS), 14, 10),
        shellMat,
      );
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
        new THREE.MeshBasicMaterial({ map: chevron, transparent: true, opacity: 0.85 }),
      );
      mesh.geometry.rotateX(-Math.PI / 2);
      mesh.position.set(fxToFloat(p.cx), 0.025, -fxToFloat(p.cy));
      mesh.rotation.y = Math.atan2(fxToFloat(p.dy), fxToFloat(p.dx));
      g.add(mesh);
      this.padMeshes.push(mesh);
    }

    // item boxes
    const itemMat = new THREE.MeshStandardMaterial({
      color: '#ffd23f',
      emissive: '#7a5500',
      metalness: 0.7,
      roughness: 0.25,
      transparent: true,
      opacity: 0.95,
    });
    for (const spawn of track.itemSpawns) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 1.05), itemMat);
      mesh.position.copy(toV3(spawn.x, spawn.y)).setY(0.95);
      g.add(mesh);
      this.itemMeshes.push(mesh);
      this.itemWasActive.push(true);
      this.itemPop.push(1);
    }

    this.buildDecor(g, track);
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
        emissiveIntensity: 1.4,
      }),
      neonB: new THREE.MeshStandardMaterial({
        color: '#21e6c1',
        emissive: '#21e6c1',
        emissiveIntensity: 1.4,
      }),
      rock: new THREE.MeshStandardMaterial({ color: '#8d7a5c', roughness: 1 }),
    };

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
        v.sparkMat.color.set(k.driftCharge >= 110 ? '#ff9b2f' : k.driftCharge >= 50 ? '#5ee1ff' : '#cfd8e3');
        const s = 0.7 + Math.random() * 0.9;
        v.sparkL.scale.set(s, s, s);
        v.sparkR.scale.set(s, s, s);
      }
    });

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
    }
    this.renderer.render(this.scene, this.camera);
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
      const mat = new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true });
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
        mesh.rotation.y += dt * 1.4;
        mesh.rotation.x += dt * 0.6;
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
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
