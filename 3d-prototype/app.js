import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('scene');
const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({canvas, antialias : true, powerPreference : 'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6f9fc4);
scene.fog = new THREE.FogExp2(0x84aac7, 0.012);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.05, 180);
camera.position.set(29, 17, 31);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.target.set(0, 4.7, 0);
controls.minDistance = 8;
controls.maxDistance = 85;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xc9e8ff, 0x314029, 2.35));
const sun = new THREE.DirectionalLight(0xfff4da, 3.1);
sun.position.set(-18, 26, 12);
scene.add(sun);

const WORLD_X = 32; // km
const WORLD_Z = 32; // km
const WORLD_Y = 12; // km
const NX = 40;
const NZ = 40;
const NY = 24;
const DX = WORLD_X / NX;
const DZ = WORLD_Z / NZ;
const DY = WORLD_Y / NY;
const CELL_COUNT = NX * NZ * NY;
const MODEL_DT_SECONDS = 2.5;
const BASE_STEPS_PER_SECOND = 12;
const MAX_CLOUD_POINTS = 18000;
const MAX_RAIN = 9000;

const idx = (x, y, z) => (y * NZ + z) * NX + x;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const mix = (a, b, t) => a + (b - a) * t;

let temp = new Float32Array(CELL_COUNT);       // K anomaly-ish
let moisture = new Float32Array(CELL_COUNT);   // normalized water vapor
let cloud = new Float32Array(CELL_COUNT);      // normalized cloud condensate
let w = new Float32Array(CELL_COUNT);          // vertical velocity m/s
let tempNext = new Float32Array(CELL_COUNT);
let moistureNext = new Float32Array(CELL_COUNT);
let cloudNext = new Float32Array(CELL_COUNT);
let wNext = new Float32Array(CELL_COUNT);
let groundCell = new Int16Array(NX * NZ);

const jitterX = new Float32Array(CELL_COUNT);
const jitterY = new Float32Array(CELL_COUNT);
const jitterZ = new Float32Array(CELL_COUNT);
let rngState = 0x1234abcd;
function rand()
{
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return ((rngState >>> 0) % 1000000) / 1000000;
}
for (let i = 0; i < CELL_COUNT; i++) {
  jitterX[i] = (rand() - 0.5) * DX * 0.55;
  jitterY[i] = (rand() - 0.5) * DY * 0.42;
  jitterZ[i] = (rand() - 0.5) * DZ * 0.55;
}

const state = {
  paused : false,
  modelMinutes : 0,
  moisture : 0.78,
  instability : 1.45,
  shear : 0.90,
  rotation : 0.85,
  relief : 0.35,
  speed : 1,
  preset : 'supercell',
};

function terrainHeightAt(x, z)
{
  const nx = x / WORLD_X + 0.5;
  const nz = z / WORLD_Z + 0.5;
  const ridge = Math.exp(-(((nx - 0.74) / 0.18) ** 2 + ((nz - 0.58) / 0.35) ** 2));
  const hill = Math.exp(-(((nx - 0.26) / 0.17) ** 2 + ((nz - 0.32) / 0.20) ** 2));
  const waves = 0.18 * Math.sin(nx * Math.PI * 4.3) * Math.cos(nz * Math.PI * 3.2);
  return Math.max(0, state.relief * (0.09 + ridge * 0.62 + hill * 0.28 + waves * 0.16));
}

const terrainGeometry = new THREE.PlaneGeometry(WORLD_X, WORLD_Z, 79, 79);
terrainGeometry.rotateX(-Math.PI / 2);
const terrainMaterial = new THREE.MeshStandardMaterial({color : 0x31573c, roughness : 0.96, metalness : 0.0});
const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
scene.add(terrainMesh);

const grid = new THREE.GridHelper(WORLD_X, 16, 0xb5d5e8, 0x41667b);
grid.position.y = 0.025;
grid.material.transparent = true;
grid.material.opacity = 0.24;
scene.add(grid);

const domainEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(WORLD_X, WORLD_Y, WORLD_Z)),
  new THREE.LineBasicMaterial({color : 0xb9d9ec, transparent : true, opacity : 0.18})
);
domainEdges.position.y = WORLD_Y / 2;
scene.add(domainEdges);

function rebuildTerrain()
{
  const p = terrainGeometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    p.setY(i, terrainHeightAt(x, z));
  }
  p.needsUpdate = true;
  terrainGeometry.computeVertexNormals();

  for (let z = 0; z < NZ; z++) {
    for (let x = 0; x < NX; x++) {
      const wx = (x + 0.5) * DX - WORLD_X / 2;
      const wz = (z + 0.5) * DZ - WORLD_Z / 2;
      groundCell[z * NX + x] = clamp(Math.floor(terrainHeightAt(wx, wz) / DY), 0, NY - 2);
    }
  }
}
rebuildTerrain();

const cloudPositions = new Float32Array(MAX_CLOUD_POINTS * 3);
const cloudColors = new Float32Array(MAX_CLOUD_POINTS * 3);
const cloudAlpha = new Float32Array(MAX_CLOUD_POINTS);
const cloudSize = new Float32Array(MAX_CLOUD_POINTS);
const cloudGeometry = new THREE.BufferGeometry();
cloudGeometry.setAttribute('position', new THREE.BufferAttribute(cloudPositions, 3).setUsage(THREE.DynamicDrawUsage));
cloudGeometry.setAttribute('color', new THREE.BufferAttribute(cloudColors, 3).setUsage(THREE.DynamicDrawUsage));
cloudGeometry.setAttribute('alpha', new THREE.BufferAttribute(cloudAlpha, 1).setUsage(THREE.DynamicDrawUsage));
cloudGeometry.setAttribute('size', new THREE.BufferAttribute(cloudSize, 1).setUsage(THREE.DynamicDrawUsage));
cloudGeometry.setDrawRange(0, 0);

const cloudMaterial = new THREE.ShaderMaterial({
  transparent : true,
  depthWrite : false,
  vertexColors : true,
  uniforms : {},
  vertexShader : `
    attribute float alpha;
    attribute float size;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vAlpha = alpha;
      vColor = color;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = clamp(size * (250.0 / max(-mvPosition.z, 1.0)), 3.0, 74.0);
    }
  `,
  fragmentShader : `
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vec2 p = gl_PointCoord - vec2(0.5);
      float d = length(p) * 2.0;
      float soft = 1.0 - smoothstep(0.38, 1.0, d);
      float core = 1.0 - smoothstep(0.0, 0.72, d);
      float a = soft * vAlpha;
      if (a < 0.015) discard;
      vec3 col = vColor * (0.90 + core * 0.18);
      gl_FragColor = vec4(col, a);
    }
  `,
});
const cloudPoints = new THREE.Points(cloudGeometry, cloudMaterial);
cloudPoints.renderOrder = 2;
scene.add(cloudPoints);

const rainX = new Float32Array(MAX_RAIN);
const rainY = new Float32Array(MAX_RAIN);
const rainZ = new Float32Array(MAX_RAIN);
const rainVX = new Float32Array(MAX_RAIN);
const rainVZ = new Float32Array(MAX_RAIN);
const rainPositions = new Float32Array(MAX_RAIN * 3);
let rainCount = 0;

const rainGeometry = new THREE.BufferGeometry();
rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3).setUsage(THREE.DynamicDrawUsage));
rainGeometry.setDrawRange(0, 0);
const rainMaterial = new THREE.PointsMaterial({color : 0x9cc6dc, size : 0.055, transparent : true, opacity : 0.58, depthWrite : false, sizeAttenuation : true});
const rainPoints = new THREE.Points(rainGeometry, rainMaterial);
scene.add(rainPoints);

function environmentalMoisture(y)
{
  const altitude = (y + 0.5) * DY;
  return 0.02 + state.moisture * 0.72 * Math.exp(-altitude / 6.0);
}

function saturationThreshold(y, tempAnomaly)
{
  const altitude = (y + 0.5) * DY;
  return clamp(0.82 * Math.exp(-0.055 * altitude) + tempAnomaly * 0.023, 0.12, 0.94);
}

function prescribedWind(x, y, z)
{
  const yn = y / (NY - 1);
  const wx = (x + 0.5) * DX - WORLD_X / 2;
  const wz = (z + 0.5) * DZ - WORLD_Z / 2;

  let u = 3.0 + state.shear * (21.0 * yn);
  let v = -1.0 + state.shear * (-7.0 + 19.0 * yn);

  if (state.rotation > 0) {
    const r2 = wx * wx + wz * wz;
    const swirl = state.rotation * 7.0 * Math.exp(-r2 / 75.0) * (0.25 + yn * 0.75);
    const r = Math.sqrt(r2) + 0.8;
    u += -wz / r * swirl;
    v += wx / r * swirl;
  }
  return [u, v];
}

function sampleNearest(field, xf, yf, zf)
{
  const x = clamp(Math.round(xf), 0, NX - 1);
  const z = clamp(Math.round(zf), 0, NZ - 1);
  const minY = groundCell[z * NX + x] + 1;
  const y = clamp(Math.round(yf), minY, NY - 1);
  return field[idx(x, y, z)];
}

function clearRain()
{
  rainCount = 0;
  rainGeometry.setDrawRange(0, 0);
}

function resetAtmosphere()
{
  temp.fill(0);
  cloud.fill(0);
  w.fill(0);
  tempNext.fill(0);
  cloudNext.fill(0);
  wNext.fill(0);
  state.modelMinutes = 0;
  clearRain();

  for (let y = 0; y < NY; y++) {
    for (let z = 0; z < NZ; z++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y, z);
        const g = groundCell[z * NX + x];
        if (y <= g) {
          moisture[i] = 0;
          continue;
        }
        moisture[i] = environmentalMoisture(y) * (0.985 + rand() * 0.03);
      }
    }
  }

  if (state.preset === 'supercell') {
    triggerBubble(1.25, -3.0, 0.0);
    triggerBubble(0.70, -6.0, -2.5);
  } else if (state.preset === 'pulse') {
    triggerBubble(1.10, 0, 0);
  } else if (state.preset === 'multicell') {
    triggerBubble(0.85, -8, -1.5);
    triggerBubble(0.95, -3, 1.5);
    triggerBubble(0.80, 3, -1.0);
    triggerBubble(0.75, 8, 1.0);
  } else {
    triggerBubble(0.70, 0, 0);
  }

  updateCloudGeometry();
  setStatus('Atmosphere reset. Drag the scene to orbit around the storm.');
}

function triggerBubble(strength = 1, worldX = 0, worldZ = 0)
{
  const cx = clamp(Math.floor((worldX + WORLD_X / 2) / DX), 2, NX - 3);
  const cz = clamp(Math.floor((worldZ + WORLD_Z / 2) / DZ), 2, NZ - 3);
  const radius = 4.5;

  for (let z = Math.max(0, cz - 7); z <= Math.min(NZ - 1, cz + 7); z++) {
    for (let x = Math.max(0, cx - 7); x <= Math.min(NX - 1, cx + 7); x++) {
      const dx = x - cx;
      const dz = z - cz;
      for (let y = 1; y < Math.min(NY, 12); y++) {
        const g = groundCell[z * NX + x];
        if (y <= g)
          continue;
        const dy = (y - (g + 3.5)) * 0.8;
        const d2 = dx * dx + dz * dz + dy * dy;
        const weight = Math.exp(-d2 / (radius * radius));
        if (weight < 0.025)
          continue;
        const i = idx(x, y, z);
        temp[i] += 2.8 * strength * weight;
        moisture[i] = Math.max(moisture[i], state.moisture * (0.90 + 0.08 * strength) * weight + environmentalMoisture(y) * (1 - weight));
        w[i] += 3.6 * strength * weight;
        if (y > g + 4)
          cloud[i] += 0.08 * strength * weight;
      }
    }
  }
  setStatus('Warm moist bubble triggered. Watch for condensation and vertical growth.');
}

function addSurfaceForcing()
{
  if (state.preset === 'dry')
    return;

  const centers = state.preset === 'multicell' ? [-8, -3, 3, 8] : [0];
  for (const worldX of centers) {
    const cx = clamp(Math.floor((worldX + WORLD_X / 2) / DX), 1, NX - 2);
    const cz = Math.floor(NZ / 2);
    for (let z = Math.max(0, cz - 3); z <= Math.min(NZ - 1, cz + 3); z++) {
      for (let x = Math.max(0, cx - 3); x <= Math.min(NX - 1, cx + 3); x++) {
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        const weight = Math.exp(-d2 / 7.0);
        const g = groundCell[z * NX + x];
        for (let y = g + 1; y <= Math.min(g + 2, NY - 1); y++) {
          const i = idx(x, y, z);
          temp[i] += 0.012 * state.instability * weight;
          moisture[i] = Math.max(moisture[i], environmentalMoisture(y) + state.moisture * 0.18 * weight);
        }
      }
    }
  }
}

function advect()
{
  for (let y = 0; y < NY; y++) {
    for (let z = 0; z < NZ; z++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y, z);
        const g = groundCell[z * NX + x];
        if (y <= g) {
          tempNext[i] = 0;
          moistureNext[i] = 0;
          cloudNext[i] = 0;
          wNext[i] = 0;
          continue;
        }

        const [uMs, vMs] = prescribedWind(x, y, z);
        const xBack = x - uMs * MODEL_DT_SECONDS / (DX * 1000);
        const zBack = z - vMs * MODEL_DT_SECONDS / (DZ * 1000);
        const yBack = y - w[i] * MODEL_DT_SECONDS / (DY * 1000);

        tempNext[i] = sampleNearest(temp, xBack, yBack, zBack);
        moistureNext[i] = sampleNearest(moisture, xBack, yBack, zBack);
        cloudNext[i] = sampleNearest(cloud, xBack, yBack, zBack);
        wNext[i] = sampleNearest(w, xBack, yBack, zBack);
      }
    }
  }

  [temp, tempNext] = [tempNext, temp];
  [moisture, moistureNext] = [moistureNext, moisture];
  [cloud, cloudNext] = [cloudNext, cloud];
  [w, wNext] = [wNext, w];
}

function microphysicsAndBuoyancy()
{
  let spawnBudget = Math.min(26, MAX_RAIN - rainCount);

  for (let y = 0; y < NY; y++) {
    for (let z = 0; z < NZ; z++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y, z);
        const g = groundCell[z * NX + x];
        if (y <= g)
          continue;

        let t = temp[i];
        let q = moisture[i];
        let c = cloud[i];
        let vv = w[i];

        // Approximate dry adiabatic response. Rising parcels cool, sinking parcels warm.
        t -= vv * 0.0037 * state.instability;

        const qsat = saturationThreshold(y, t);
        if (q > qsat) {
          const condense = Math.min(q - qsat, (q - qsat) * 0.30 + 0.0015);
          q -= condense;
          c += condense * 1.35;
          t += condense * 0.68; // crude latent heating
        } else if (c > 0 && q < qsat * 0.93) {
          const evaporate = Math.min(c, (qsat - q) * 0.030);
          c -= evaporate;
          q += evaporate * 0.72;
          t -= evaporate * 0.38;
        }

        const envQ = environmentalMoisture(y);
        const condensateLoading = c * 0.38;
        const buoyancy = (0.055 * t + 0.22 * (q - envQ) - condensateLoading) * state.instability;
        vv += buoyancy * MODEL_DT_SECONDS;
        vv *= 0.986;
        vv = clamp(vv, -28, 48);

        // Weak numerical mixing back toward the environment.
        t *= 0.9983;
        q = mix(q, envQ, 0.0008);
        c *= 0.9988;

        temp[i] = clamp(t, -9, 12);
        moisture[i] = clamp(q, 0, 1.15);
        cloud[i] = clamp(c, 0, 1.6);
        w[i] = vv;

        if (spawnBudget > 0 && c > 0.48 && y > g + 7 && rand() < c * 0.010) {
          spawnRain(x, y, z);
          cloud[i] *= 0.992;
          spawnBudget--;
        }
      }
    }
  }
}

function spawnRain(x, y, z)
{
  if (rainCount >= MAX_RAIN)
    return;
  const n = rainCount++;
  rainX[n] = (x + 0.5) * DX - WORLD_X / 2 + (rand() - 0.5) * DX;
  rainY[n] = (y + 0.5) * DY + (rand() - 0.5) * DY;
  rainZ[n] = (z + 0.5) * DZ - WORLD_Z / 2 + (rand() - 0.5) * DZ;
  const [u, v] = prescribedWind(x, y, z);
  rainVX[n] = u;
  rainVZ[n] = v;
}

function updateRain()
{
  let n = 0;
  while (n < rainCount) {
    rainX[n] += rainVX[n] * MODEL_DT_SECONDS / 1000;
    rainZ[n] += rainVZ[n] * MODEL_DT_SECONDS / 1000;
    rainY[n] -= (7.0 + rand() * 2.0) * MODEL_DT_SECONDS / 1000;

    const ground = terrainHeightAt(rainX[n], rainZ[n]);
    const outside = Math.abs(rainX[n]) > WORLD_X / 2 || Math.abs(rainZ[n]) > WORLD_Z / 2;
    if (rainY[n] <= ground || outside) {
      const last = --rainCount;
      rainX[n] = rainX[last];
      rainY[n] = rainY[last];
      rainZ[n] = rainZ[last];
      rainVX[n] = rainVX[last];
      rainVZ[n] = rainVZ[last];
      continue;
    }
    n++;
  }
}

function physicsStep()
{
  addSurfaceForcing();
  advect();
  microphysicsAndBuoyancy();
  updateRain();
  state.modelMinutes += MODEL_DT_SECONDS / 60;
}

function updateCloudGeometry()
{
  let count = 0;
  let maxUpdraft = 0;
  let top = 0;
  const threshold = 0.032;

  // Visit in a pseudo-shuffled stride to avoid always clipping the same side if MAX_CLOUD_POINTS is reached.
  const stride = 7919;
  let cursor = Math.floor(state.modelMinutes * 23) % CELL_COUNT;
  for (let seen = 0; seen < CELL_COUNT && count < MAX_CLOUD_POINTS; seen++) {
    cursor = (cursor + stride) % CELL_COUNT;
    const y = Math.floor(cursor / (NX * NZ));
    const rem = cursor - y * NX * NZ;
    const z = Math.floor(rem / NX);
    const x = rem - z * NX;
    const g = groundCell[z * NX + x];
    if (y <= g)
      continue;

    const c = cloud[cursor];
    maxUpdraft = Math.max(maxUpdraft, w[cursor]);
    if (c <= threshold)
      continue;

    const px = (x + 0.5) * DX - WORLD_X / 2 + jitterX[cursor];
    const py = (y + 0.5) * DY + jitterY[cursor];
    const pz = (z + 0.5) * DZ - WORLD_Z / 2 + jitterZ[cursor];
    top = Math.max(top, py);

    const p3 = count * 3;
    cloudPositions[p3] = px;
    cloudPositions[p3 + 1] = py;
    cloudPositions[p3 + 2] = pz;

    const density = clamp((c - threshold) / 0.55, 0, 1);
    const altitudeShade = clamp(py / WORLD_Y, 0, 1);
    const updraftTint = clamp(w[cursor] / 40, 0, 1);
    const gray = mix(0.63, 1.0, 0.38 + density * 0.45);
    cloudColors[p3] = clamp(gray + updraftTint * 0.04, 0, 1);
    cloudColors[p3 + 1] = clamp(gray + altitudeShade * 0.035, 0, 1);
    cloudColors[p3 + 2] = clamp(gray + 0.06 + altitudeShade * 0.04, 0, 1);
    cloudAlpha[count] = clamp(0.15 + density * 0.58, 0.12, 0.76);
    cloudSize[count] = 0.62 + Math.sqrt(clamp(c, 0, 1.4)) * 1.12;
    count++;
  }

  cloudGeometry.setDrawRange(0, count);
  cloudGeometry.attributes.position.needsUpdate = true;
  cloudGeometry.attributes.color.needsUpdate = true;
  cloudGeometry.attributes.alpha.needsUpdate = true;
  cloudGeometry.attributes.size.needsUpdate = true;

  for (let i = 0; i < rainCount; i++) {
    const p = i * 3;
    rainPositions[p] = rainX[i];
    rainPositions[p + 1] = rainY[i];
    rainPositions[p + 2] = rainZ[i];
  }
  rainGeometry.setDrawRange(0, rainCount);
  rainGeometry.attributes.position.needsUpdate = true;

  document.getElementById('simTime').textContent = `${state.modelMinutes.toFixed(1)} min`;
  document.getElementById('cloudCells').textContent = count.toLocaleString();
  document.getElementById('maxUpdraft').textContent = `${maxUpdraft.toFixed(1)} m/s`;
  document.getElementById('cloudTop').textContent = `${top.toFixed(1)} km`;
  document.getElementById('rainCount').textContent = rainCount.toLocaleString();
}

function applyPreset(name)
{
  const presets = {
    supercell : {moisture : 0.78, instability : 1.45, shear : 0.90, rotation : 0.85, relief : 0.35},
    pulse : {moisture : 0.82, instability : 1.55, shear : 0.15, rotation : 0.05, relief : 0.20},
    multicell : {moisture : 0.76, instability : 1.35, shear : 0.55, rotation : 0.20, relief : 0.15},
    dry : {moisture : 0.44, instability : 1.20, shear : 0.45, rotation : 0.10, relief : 0.55},
  };
  const p = presets[name] || presets.supercell;
  state.preset = name;
  Object.assign(state, p);
  syncControlsFromState();
  rebuildTerrain();
  resetAtmosphere();
  if (name === 'supercell')
    setStatus('Supercell-ish preset: strong directional shear plus an imposed rotating updraft bias. This is not a resolved mesocyclone.');
}

function syncControlsFromState()
{
  document.getElementById('moisture').value = state.moisture;
  document.getElementById('instability').value = state.instability;
  document.getElementById('shear').value = state.shear;
  document.getElementById('rotation').value = state.rotation;
  document.getElementById('terrain').value = state.relief;
  document.getElementById('speed').value = state.speed;
  document.getElementById('preset').value = state.preset;
  updateValueLabels();
}

function updateValueLabels()
{
  document.getElementById('moistureValue').textContent = `${Math.round(state.moisture * 100)}%`;
  document.getElementById('instabilityValue').textContent = `${state.instability.toFixed(2)}×`;
  document.getElementById('shearValue').textContent = state.shear.toFixed(2);
  document.getElementById('rotationValue').textContent = state.rotation.toFixed(2);
  document.getElementById('terrainValue').textContent = `${state.relief.toFixed(2)} km`;
  document.getElementById('speedValue').textContent = `${state.speed.toFixed(2)}×`;
}

function wireUI()
{
  const mappings = [
    ['moisture', 'moisture'],
    ['instability', 'instability'],
    ['shear', 'shear'],
    ['rotation', 'rotation'],
    ['speed', 'speed'],
  ];
  for (const [id, key] of mappings) {
    document.getElementById(id).addEventListener('input', event => {
      state[key] = Number.parseFloat(event.target.value);
      updateValueLabels();
    });
  }

  document.getElementById('terrain').addEventListener('input', event => {
    state.relief = Number.parseFloat(event.target.value);
    updateValueLabels();
    rebuildTerrain();
  });
  document.getElementById('terrain').addEventListener('change', () => resetAtmosphere());

  document.getElementById('preset').addEventListener('change', event => applyPreset(event.target.value));
  document.getElementById('pause').addEventListener('click', togglePause);
  document.getElementById('reset').addEventListener('click', resetAtmosphere);
  document.getElementById('bubble').addEventListener('click', () => triggerBubble(1.25, 0, 0));
  document.getElementById('showGrid').addEventListener('change', event => {
    grid.visible = event.target.checked;
    domainEdges.visible = event.target.checked;
  });

  window.addEventListener('keydown', event => {
    const target = event.target;
    if (target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName))
      return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePause();
    } else if (event.key.toLowerCase() === 'r') {
      resetAtmosphere();
    }
  });
}

function togglePause()
{
  state.paused = !state.paused;
  document.getElementById('pause').textContent = state.paused ? 'Resume' : 'Pause';
  setStatus(state.paused ? 'Simulation paused.' : 'Simulation running.');
}

function onResize()
{
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

wireUI();
syncControlsFromState();
resetAtmosphere();

let lastRealTime = performance.now();
let accumulator = 0;
let renderCounter = 0;
function animate(now)
{
  requestAnimationFrame(animate);
  const realDelta = Math.min((now - lastRealTime) / 1000, 0.1);
  lastRealTime = now;

  if (!state.paused) {
    accumulator += realDelta * BASE_STEPS_PER_SECOND * state.speed;
    let guard = 0;
    while (accumulator >= 1 && guard < 8) {
      physicsStep();
      accumulator -= 1;
      guard++;
    }
  }

  renderCounter++;
  if (renderCounter % 2 === 0)
    updateCloudGeometry();

  controls.update();
  renderer.render(scene, camera);
}

loadingEl.classList.add('hidden');
setTimeout(() => loadingEl.remove(), 500);
requestAnimationFrame(animate);
