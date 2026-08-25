import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const mix = (a, b, amount) => a + (b - a) * amount;
const MODEL_DT = 3;
const BASE_STEPS_PER_SECOND = 10;
const SAVE_VERSION = 2;

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6a9abc);
scene.fog = new THREE.FogExp2(0x86abc5, 0.009);

const camera = new THREE.PerspectiveCamera(49, innerWidth / innerHeight, 0.05, 240);
camera.position.set(34, 21, 35);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.target.set(0, 4.5, 0);
controls.minDistance = 5;
controls.maxDistance = 130;
controls.maxPolarAngle = Math.PI * 0.495;
controls.mouseButtons.LEFT = -1;
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;

const hemiLight = new THREE.HemisphereLight(0xcceaff, 0x243526, 2.25);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff3d2, 3.3);
sunLight.position.set(-30, 35, 18);
scene.add(sunLight);
const sunDisc = new THREE.Mesh(
  new THREE.SphereGeometry(1.15, 20, 12),
  new THREE.MeshBasicMaterial({color: 0xfff3c2, fog: false})
);
scene.add(sunDisc);

const state = {
  running: false,
  paused: false,
  preset: 'supercell',
  displayMode: 'realistic',
  tool: 'inspect',
  brushSize: 4,
  brushAltitude: 1.5,
  brushIntensity: 0.6,
  wholeColumn: false,
  wrap: true,
  showWind: false,
  showGrid: true,
  volumeOpacity: 0.65,
  speed: 1,
  modelSeconds: 0,
  dayTime: 15,
  dayCycle: true,
  surfaceTemp: 29,
  surfaceHumidity: 72,
  lapseRate: 7.2,
  shear: 24,
  worldX: 48,
  worldZ: 48,
  worldY: 15,
  nx: 44,
  nz: 44,
  ny: 28,
  dx: 1,
  dz: 1,
  dy: 1,
  cells: 0,
  renderStride: 1,
};

let temperature;
let vapor;
let cloud;
let rain;
let ice;
let u;
let v;
let w;
let pressure;
let temperatureNext;
let vaporNext;
let cloudNext;
let rainNext;
let iceNext;
let uNext;
let vNext;
let wNext;
let pressureNext;
let terrain;
let surface;
let groundCell;
let terrainMesh;
let volumePoints;
let precipPoints;
let windLines;
let gridHelper;
let domainEdges;
let brushRing;
let selectedCell = null;
let rngState = 0x78ab12ef;
let toastTimer = 0;

const idx = (x, y, z) => (y * state.nz + z) * state.nx + x;
const idx2 = (x, z) => z * state.nx + x;

function random() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 4294967296;
}

function environmentalTemperature(y) {
  return state.surfaceTemp - state.lapseRate * ((y + 0.5) * state.dy);
}

function environmentalVapor(y) {
  const altitude = (y + 0.5) * state.dy;
  return (state.surfaceHumidity / 100) * Math.exp(-altitude / 5.8);
}

function saturationRatio(tempC, y) {
  const altitude = (y + 0.5) * state.dy;
  const thermal = Math.exp((tempC - environmentalTemperature(y)) * 0.045);
  return clamp((0.76 - altitude * 0.012) * thermal, 0.12, 1.0);
}

function baseWindAt(y) {
  const yn = y / Math.max(state.ny - 1, 1);
  let angle = 0;
  let speed = 2.5 + state.shear * yn;
  if (state.preset === 'supercell') {
    angle = THREE.MathUtils.degToRad(-28 + 72 * yn);
    speed = 4 + state.shear * yn;
  } else if (state.preset === 'mountain') {
    angle = THREE.MathUtils.degToRad(4);
    speed = 7 + state.shear * 0.45 * yn;
  } else if (state.preset === 'seabreeze') {
    angle = THREE.MathUtils.degToRad(5);
    speed = 2 + state.shear * 0.35 * yn;
  }
  return [Math.cos(angle) * speed, Math.sin(angle) * speed];
}

function allocateFields() {
  state.cells = state.nx * state.nz * state.ny;
  const fields = Array.from({length: 18}, () => new Float32Array(state.cells));
  [
    temperature, vapor, cloud, rain, ice, u, v, w, pressure,
    temperatureNext, vaporNext, cloudNext, rainNext, iceNext, uNext, vNext, wNext, pressureNext
  ] = fields;
  terrain = new Float32Array(state.nx * state.nz);
  surface = new Uint8Array(state.nx * state.nz);
  groundCell = new Int16Array(state.nx * state.nz);
}

function terrainPreset(x, z) {
  const xn = x / Math.max(state.nx - 1, 1);
  const zn = z / Math.max(state.nz - 1, 1);
  const noise = Math.sin(xn * 17.2) * Math.cos(zn * 13.4) * 0.09 +
    Math.sin((xn + zn) * 29.0) * 0.035;
  if (state.preset === 'mountain') {
    const ridge = Math.exp(-(((xn - 0.56) / 0.12) ** 2)) *
      (0.58 + 0.42 * Math.exp(-(((zn - 0.54) / 0.44) ** 2)));
    return clamp(0.15 + noise + ridge * 3.9, 0, 5.2);
  }
  if (state.preset === 'seabreeze') {
    if (xn < 0.43)
      return 0;
    const coast = clamp((xn - 0.43) * 2.3, 0, 1);
    return Math.max(0.08, 0.12 + coast * 0.35 + noise);
  }
  const hill = Math.exp(-(((xn - 0.76) / 0.18) ** 2 + ((zn - 0.68) / 0.26) ** 2));
  return Math.max(0.05, 0.14 + noise + hill * (state.preset === 'custom' ? 0.45 : 1.05));
}

function initializeAtmosphere() {
  rngState = 0x78ab12ef;
  state.modelSeconds = 0;
  selectedCell = null;
  [temperature, vapor, cloud, rain, ice, u, v, w, pressure].forEach(field => field.fill(0));
  for (let z = 0; z < state.nz; z++) {
    for (let x = 0; x < state.nx; x++) {
      const s = idx2(x, z);
      terrain[s] = terrainPreset(x, z);
      surface[s] = state.preset === 'seabreeze' && x / state.nx < 0.43 ? 1 : 0;
      groundCell[s] = clamp(Math.floor(terrain[s] / state.dy), 0, state.ny - 2);
      for (let y = 0; y < state.ny; y++) {
        const i = idx(x, y, z);
        const [baseU, baseV] = baseWindAt(y);
        if (y <= groundCell[s]) {
          temperature[i] = state.surfaceTemp;
          continue;
        }
        temperature[i] = environmentalTemperature(y) + (random() - 0.5) * 0.08;
        vapor[i] = environmentalVapor(y) * (0.985 + random() * 0.03);
        u[i] = baseU;
        v[i] = baseV;
      }
    }
  }

  if (state.preset === 'supercell') {
    seedBubble(-7, -2, 1.7, 1.3);
    seedBubble(-10, -5, 1.1, 0.65);
  } else if (state.preset === 'seabreeze') {
    for (let z = 0; z < state.nz; z++) {
      for (let x = 0; x < Math.floor(state.nx * 0.43); x++) {
        const g = groundCell[idx2(x, z)];
        for (let y = g + 1; y < Math.min(g + 4, state.ny); y++)
          temperature[idx(x, y, z)] -= 4.5 * Math.exp(-(y - g - 1) * 0.5);
      }
    }
  }
}

function applyPresetEnvironment() {
  const profiles = {
    supercell: {surfaceTemp: 29, surfaceHumidity: 72, lapseRate: 7.2, shear: 24},
    mountain: {surfaceTemp: 24, surfaceHumidity: 82, lapseRate: 6.7, shear: 18},
    seabreeze: {surfaceTemp: 32, surfaceHumidity: 68, lapseRate: 7.6, shear: 10},
    custom: {surfaceTemp: 25, surfaceHumidity: 55, lapseRate: 6.5, shear: 4}
  };
  Object.assign(state, profiles[state.preset] || profiles.supercell);
}

function seedBubble(worldX, worldZ, altitude, strength) {
  const cx = Math.floor((worldX + state.worldX / 2) / state.dx);
  const cz = Math.floor((worldZ + state.worldZ / 2) / state.dz);
  const cy = Math.floor(altitude / state.dy);
  const radiusKm = 5.0;
  for (let z = 0; z < state.nz; z++) {
    for (let x = 0; x < state.nx; x++) {
      for (let y = 0; y < state.ny; y++) {
        const wx = (x - cx) * state.dx;
        const wz = (z - cz) * state.dz;
        const wy = (y - cy) * state.dy * 1.25;
        const weight = Math.exp(-(wx * wx + wz * wz + wy * wy) / (radiusKm * radiusKm));
        if (weight < 0.018 || y <= groundCell[idx2(x, z)])
          continue;
        const i = idx(x, y, z);
        temperature[i] += 3.2 * strength * weight;
        vapor[i] = Math.max(vapor[i], 0.88 * strength * weight + environmentalVapor(y) * (1 - weight));
        w[i] += 6.5 * strength * weight;
        if (y > cy + 2)
          cloud[i] += 0.10 * strength * weight;
      }
    }
  }
}

function disposeObject(object) {
  if (!object)
    return;
  scene.remove(object);
  object.geometry?.dispose();
  if (Array.isArray(object.material))
    object.material.forEach(material => material.dispose());
  else
    object.material?.dispose();
}

function buildTerrainMesh() {
  disposeObject(terrainMesh);
  const geometry = new THREE.PlaneGeometry(state.worldX, state.worldZ, state.nx - 1, state.nz - 1);
  geometry.rotateX(-Math.PI / 2);
  const colors = new Float32Array(state.nx * state.nz * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0, side: THREE.DoubleSide
  }));
  terrainMesh.renderOrder = 0;
  scene.add(terrainMesh);
  updateTerrainMesh();
}

function updateTerrainMesh() {
  if (!terrainMesh)
    return;
  const positions = terrainMesh.geometry.attributes.position;
  const colors = terrainMesh.geometry.attributes.color;
  const color = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    const x = i % state.nx;
    const z = Math.floor(i / state.nx);
    const s = idx2(x, z);
    positions.setY(i, terrain[s]);
    if (surface[s] === 1)
      color.setRGB(0.06, 0.29 + terrain[s] * 0.01, 0.47);
    else if (surface[s] === 2)
      color.setRGB(0.43, 0.12, 0.035);
    else {
      const high = clamp(terrain[s] / 4.5, 0, 1);
      color.setRGB(mix(0.12, 0.48, high), mix(0.34, 0.42, high), mix(0.15, 0.35, high));
    }
    colors.setXYZ(i, color.r, color.g, color.b);
  }
  positions.needsUpdate = true;
  colors.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

function buildDomainGuides() {
  disposeObject(gridHelper);
  disposeObject(domainEdges);
  gridHelper = new THREE.GridHelper(state.worldX, 16, 0xc1deef, 0x44677b);
  gridHelper.position.y = 0.035;
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.25;
  scene.add(gridHelper);
  domainEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(state.worldX, state.worldY, state.worldZ)),
    new THREE.LineBasicMaterial({color: 0xb9dced, transparent: true, opacity: 0.22})
  );
  domainEdges.position.y = state.worldY / 2;
  scene.add(domainEdges);
}

function pointMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    uniforms: {opacityScale: {value: state.volumeOpacity}},
    vertexShader: `
      attribute float alpha;
      attribute float pointSize;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vAlpha = alpha;
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(pointSize * (270.0 / max(-mv.z, 1.0)), 2.0, 86.0);
      }`,
    fragmentShader: `
      uniform float opacityScale;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p) * 2.0;
        float edge = 1.0 - smoothstep(0.45, 1.0, d);
        float core = 1.0 - smoothstep(0.0, 0.72, d);
        float alpha = edge * vAlpha * opacityScale;
        if (alpha < 0.008) discard;
        gl_FragColor = vec4(vColor * (0.88 + core * 0.18), alpha);
      }`
  });
}

function buildVolumeObjects() {
  disposeObject(volumePoints);
  disposeObject(precipPoints);
  const maxPoints = state.cells;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(maxPoints), 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('pointSize', new THREE.BufferAttribute(new Float32Array(maxPoints), 1).setUsage(THREE.DynamicDrawUsage));
  volumePoints = new THREE.Points(geometry, pointMaterial());
  volumePoints.renderOrder = 2;
  scene.add(volumePoints);

  const precipGeometry = new THREE.BufferGeometry();
  precipGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3).setUsage(THREE.DynamicDrawUsage));
  precipGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3).setUsage(THREE.DynamicDrawUsage));
  precipGeometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(maxPoints), 1).setUsage(THREE.DynamicDrawUsage));
  precipGeometry.setAttribute('pointSize', new THREE.BufferAttribute(new Float32Array(maxPoints), 1).setUsage(THREE.DynamicDrawUsage));
  precipPoints = new THREE.Points(precipGeometry, pointMaterial());
  precipPoints.renderOrder = 3;
  scene.add(precipPoints);
}

function buildBrush() {
  disposeObject(brushRing);
  brushRing = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.5, 64),
    new THREE.MeshBasicMaterial({color: 0x59d9ff, transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthTest: false})
  );
  brushRing.rotation.x = -Math.PI / 2;
  brushRing.renderOrder = 20;
  brushRing.visible = false;
  scene.add(brushRing);
}

function buildWindLines() {
  disposeObject(windLines);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18 * 18 * 6), 3).setUsage(THREE.DynamicDrawUsage));
  windLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: 0x9fe9ff, transparent: true, opacity: 0.58, depthWrite: false
  }));
  scene.add(windLines);
  updateWindLines();
}

function createSimulation() {
  $('loading').classList.add('visible');
  requestAnimationFrame(() => {
    const detail = Number($('detail').value);
    const grids = [[34, 22], [44, 28], [54, 34]];
    state.worldX = Number($('worldSize').value);
    state.worldZ = state.worldX;
    state.worldY = Number($('worldHeight').value);
    [state.nx, state.ny] = grids[detail];
    state.nz = state.nx;
    state.dx = state.worldX / state.nx;
    state.dz = state.worldZ / state.nz;
    state.dy = state.worldY / state.ny;
    state.renderStride = detail === 2 ? 2 : 1;
    applyPresetEnvironment();
    state.brushAltitude = Math.min(state.brushAltitude, state.worldY - state.dy);
    $('brushAltitude').max = (state.worldY - state.dy).toFixed(2);
    $('brushAltitude').value = state.brushAltitude;
    allocateFields();
    initializeAtmosphere();
    buildTerrainMesh();
    buildDomainGuides();
    buildVolumeObjects();
    buildBrush();
    buildWindLines();
    updateEnvironmentUI();
    updateTerrainMesh();
    updateVolumeGeometry();
    updateSun();
    state.running = true;
    state.paused = false;
    $('pauseButton').textContent = 'Pause';
    $('setup').classList.add('hidden');
    $('loading').classList.remove('visible');
    controls.target.set(0, state.worldY * 0.32, 0);
    camera.position.set(state.worldX * 0.72, state.worldY * 1.35, state.worldZ * 0.74);
    controls.update();
    toast('Simulation created. Pick a tool and start bullying the atmosphere.');
  });
}

function wrappedX(x) {
  if (state.wrap)
    return ((x % state.nx) + state.nx) % state.nx;
  return clamp(x, 0, state.nx - 1);
}

function wrappedZ(z) {
  if (state.wrap)
    return ((z % state.nz) + state.nz) % state.nz;
  return clamp(z, 0, state.nz - 1);
}

function sample(field, xf, yf, zf) {
  const x = wrappedX(Math.round(xf));
  const z = wrappedZ(Math.round(zf));
  const minY = groundCell[idx2(x, z)] + 1;
  const y = clamp(Math.round(yf), minY, state.ny - 1);
  return field[idx(x, y, z)];
}

function advectFields() {
  const dtKm = MODEL_DT / 1000;
  for (let y = 0; y < state.ny; y++) {
    for (let z = 0; z < state.nz; z++) {
      for (let x = 0; x < state.nx; x++) {
        const i = idx(x, y, z);
        const g = groundCell[idx2(x, z)];
        if (y <= g) {
          temperatureNext[i] = temperature[i];
          vaporNext[i] = cloudNext[i] = rainNext[i] = iceNext[i] = 0;
          uNext[i] = vNext[i] = wNext[i] = pressureNext[i] = 0;
          continue;
        }
        const xb = x - u[i] * dtKm / state.dx;
        const zb = z - v[i] * dtKm / state.dz;
        const yb = y - w[i] * dtKm / state.dy;
        temperatureNext[i] = sample(temperature, xb, yb, zb);
        vaporNext[i] = sample(vapor, xb, yb, zb);
        cloudNext[i] = sample(cloud, xb, yb, zb);
        rainNext[i] = sample(rain, xb, y - (w[i] - 9) * dtKm / state.dy, zb);
        iceNext[i] = sample(ice, xb, y - (w[i] - 2.4) * dtKm / state.dy, zb);
        uNext[i] = sample(u, xb, yb, zb);
        vNext[i] = sample(v, xb, yb, zb);
        wNext[i] = sample(w, xb, yb, zb);
        pressureNext[i] = sample(pressure, xb, yb, zb);
      }
    }
  }
  [temperature, temperatureNext] = [temperatureNext, temperature];
  [vapor, vaporNext] = [vaporNext, vapor];
  [cloud, cloudNext] = [cloudNext, cloud];
  [rain, rainNext] = [rainNext, rain];
  [ice, iceNext] = [iceNext, ice];
  [u, uNext] = [uNext, u];
  [v, vNext] = [vNext, v];
  [w, wNext] = [wNext, w];
  [pressure, pressureNext] = [pressureNext, pressure];
}

function applyDynamicsAndMicrophysics() {
  for (let y = 0; y < state.ny; y++) {
    for (let z = 0; z < state.nz; z++) {
      for (let x = 0; x < state.nx; x++) {
        const i = idx(x, y, z);
        const s = idx2(x, z);
        const g = groundCell[s];
        if (y <= g)
          continue;

        const xm = wrappedX(x - 1);
        const xp = wrappedX(x + 1);
        const zm = wrappedZ(z - 1);
        const zp = wrappedZ(z + 1);
        const ym = Math.max(g + 1, y - 1);
        const yp = Math.min(state.ny - 1, y + 1);
        const du = (u[idx(xp, y, z)] - u[idx(xm, y, z)]) / (2 * state.dx * 1000);
        const dv = (v[idx(x, y, zp)] - v[idx(x, y, zm)]) / (2 * state.dz * 1000);
        const dw = (w[idx(x, yp, z)] - w[idx(x, ym, z)]) / (2 * state.dy * 1000);
        const divergence = du + dv + dw;
        let p = pressure[i] * 0.965 - divergence * 650;
        p = clamp(p, -8, 8);

        const dpdx = (pressure[idx(xp, y, z)] - pressure[idx(xm, y, z)]) / (2 * state.dx);
        const dpdz = (pressure[idx(x, y, zp)] - pressure[idx(x, y, zm)]) / (2 * state.dz);
        let uu = u[i] - dpdx * 0.052 * MODEL_DT;
        let vv = v[i] - dpdz * 0.052 * MODEL_DT;
        let ww = w[i] - divergence * 180 * MODEL_DT;

        const envT = environmentalTemperature(y);
        const envQ = environmentalVapor(y);
        let t = temperature[i] - w[i] * 0.0019 * MODEL_DT;
        let q = vapor[i];
        let c = cloud[i];
        let r = rain[i];
        let h = ice[i];
        const saturation = saturationRatio(t, y);

        if (q > saturation) {
          const condensed = Math.min(q - saturation, 0.018 + (q - saturation) * 0.24);
          q -= condensed;
          c += condensed * 1.28;
          t += condensed * 2.4;
        } else if (c > 0 && q < saturation * 0.92) {
          const evaporated = Math.min(c, (saturation - q) * 0.022);
          c -= evaporated;
          q += evaporated * 0.82;
          t -= evaporated * 1.7;
        }

        if (c > 0.42) {
          const conversion = Math.min(c * 0.012, Math.max(0, c - 0.42) * 0.036);
          c -= conversion;
          if (t < -4)
            h += conversion;
          else
            r += conversion;
        }
        if (h > 0 && t > 1) {
          const melted = Math.min(h, 0.006 * MODEL_DT);
          h -= melted;
          r += melted;
          t -= melted * 0.8;
        }
        if (r > 0 && q < saturation * 0.78) {
          const evaporated = Math.min(r, (saturation * 0.78 - q) * 0.006);
          r -= evaporated;
          q += evaporated;
          t -= evaporated * 1.1;
        }

        const thermalBuoyancy = (t - envT) * 0.08;
        const moistureBuoyancy = (q - envQ) * 0.9;
        const loading = (c + r * 1.4 + h * 1.9) * 0.55;
        ww += (thermalBuoyancy + moistureBuoyancy - loading) * MODEL_DT;

        if (y === g + 1) {
          const xSlope = (terrain[idx2(xp, z)] - terrain[idx2(xm, z)]) / (2 * state.dx);
          const zSlope = (terrain[idx2(x, zp)] - terrain[idx2(x, zm)]) / (2 * state.dz);
          ww += Math.max(0, uu * xSlope + vv * zSlope) * 0.18;
          const heatTarget = state.surfaceTemp + (surface[s] === 2 ? 18 : surface[s] === 1 ? -5 : 0);
          const moistureTarget = surface[s] === 1 ? 0.98 : surface[s] === 2 ? 0.2 : state.surfaceHumidity / 100;
          t = mix(t, heatTarget, surface[s] === 2 ? 0.016 : 0.0035);
          q = mix(q, moistureTarget, surface[s] === 1 ? 0.007 : 0.002);
          if (surface[s] === 2)
            ww += 0.24 * MODEL_DT;
          if (state.preset === 'seabreeze') {
            uu += (surface[s] === 1 ? 0.12 : -0.025) * MODEL_DT;
            p += surface[s] === 1 ? 0.018 : -0.008;
          }
        }

        const [targetU, targetV] = baseWindAt(y);
        uu = mix(uu, targetU, 0.0016);
        vv = mix(vv, targetV, 0.0016);
        t = mix(t, envT, 0.00045);
        q = mix(q, envQ, 0.00032);

        temperature[i] = clamp(t, -88, 55);
        vapor[i] = clamp(q, 0, 1.35);
        cloud[i] = clamp(c * 0.9994, 0, 1.8);
        rain[i] = clamp(r * 0.999, 0, 1.3);
        ice[i] = clamp(h * 0.9994, 0, 1.3);
        u[i] = clamp(uu * 0.9993, -55, 55);
        v[i] = clamp(vv * 0.9993, -55, 55);
        w[i] = clamp(ww * 0.982, -30, 68);
        pressure[i] = p;
      }
    }
  }
}

function physicsStep() {
  advectFields();
  applyDynamicsAndMicrophysics();
  state.modelSeconds += MODEL_DT;
  if (state.dayCycle)
    state.dayTime = (state.dayTime + MODEL_DT / 3600) % 24;
}

function colorRamp(value, stops) {
  const scaled = clamp(value, 0, 1) * (stops.length - 1);
  const low = Math.floor(scaled);
  const high = Math.min(stops.length - 1, low + 1);
  return new THREE.Color(stops[low]).lerp(new THREE.Color(stops[high]), scaled - low);
}

const ramps = {
  temperature: [0x282b82, 0x1675d1, 0x24d8d0, 0x64df7a, 0xffe75f, 0xff853b, 0xd62f52],
  humidity: [0x152739, 0x176ca1, 0x27cbe0, 0xd9f5f8, 0xffffff],
  wind: [0x202b78, 0x1fb7da, 0x50e06c, 0xffec58, 0xff7438, 0xd92a56],
  vertical: [0x1d3eaa, 0x31b8ee, 0xf0f3f5, 0xffa040, 0xe12e47],
  pressure: [0x5531a7, 0x3b9ce2, 0xeeeeee, 0xffc14a, 0xce3f55],
  precipitation: [0x142e51, 0x235fba, 0x37d7e8, 0xf4f7ff, 0xe68bff],
};

function pointVisual(i, y) {
  const mode = state.displayMode;
  let alpha = 0;
  let size = Math.max(state.dx, state.dy) * 1.38;
  let color = new THREE.Color(0xffffff);
  if (mode === 'realistic') {
    const density = cloud[i];
    if (density < 0.018)
      return null;
    const shade = clamp(0.58 + density * 0.36 + y / state.ny * 0.12 - rain[i] * 0.22, 0.32, 1);
    color.setRGB(shade, shade * 1.01, shade * 1.045);
    alpha = clamp(0.12 + density * 0.64, 0.1, 0.84);
    size *= 1.2 + Math.sqrt(density) * 0.75;
  } else if (mode === 'temperature') {
    color = colorRamp((temperature[i] + 45) / 75, ramps.temperature);
    alpha = 0.105;
  } else if (mode === 'humidity') {
    color = colorRamp(clamp(vapor[i] * 0.88 + cloud[i] * 0.55, 0, 1), ramps.humidity);
    alpha = 0.08 + cloud[i] * 0.26;
  } else if (mode === 'wind') {
    color = colorRamp(Math.hypot(u[i], v[i]) / 45, ramps.wind);
    alpha = 0.105;
  } else if (mode === 'vertical') {
    color = colorRamp((w[i] + 18) / 58, ramps.vertical);
    alpha = 0.105 + Math.min(Math.abs(w[i]) / 80, 0.12);
  } else if (mode === 'pressure') {
    color = colorRamp((pressure[i] + 5) / 10, ramps.pressure);
    alpha = 0.1;
  } else {
    const precipitation = rain[i] + ice[i];
    if (precipitation < 0.004)
      return null;
    color = colorRamp(clamp(precipitation * 1.4 + ice[i] * 0.5, 0, 1), ramps.precipitation);
    alpha = 0.16 + precipitation * 0.5;
    size *= 0.72;
  }
  return {color, alpha: clamp(alpha, 0.04, 0.9), size};
}

function updateVolumeGeometry() {
  if (!volumePoints)
    return;
  const geometry = volumePoints.geometry;
  const positions = geometry.attributes.position.array;
  const colors = geometry.attributes.color.array;
  const alphas = geometry.attributes.alpha.array;
  const sizes = geometry.attributes.pointSize.array;
  let count = 0;
  let cursor = Math.floor(state.modelSeconds * 7) % Math.max(state.renderStride, 1);
  for (let y = 0; y < state.ny; y++) {
    for (let z = 0; z < state.nz; z++) {
      for (let x = 0; x < state.nx; x++) {
        const i = idx(x, y, z);
        if (y <= groundCell[idx2(x, z)] || ((i + cursor) % state.renderStride !== 0))
          continue;
        const visual = pointVisual(i, y);
        if (!visual)
          continue;
        const p = count * 3;
        positions[p] = (x + 0.5) * state.dx - state.worldX / 2;
        positions[p + 1] = (y + 0.5) * state.dy;
        positions[p + 2] = (z + 0.5) * state.dz - state.worldZ / 2;
        colors[p] = visual.color.r;
        colors[p + 1] = visual.color.g;
        colors[p + 2] = visual.color.b;
        alphas[count] = visual.alpha;
        sizes[count] = visual.size;
        count++;
      }
    }
  }
  geometry.setDrawRange(0, count);
  Object.values(geometry.attributes).forEach(attribute => attribute.needsUpdate = true);
  volumePoints.material.uniforms.opacityScale.value = state.volumeOpacity;

  const precipGeometry = precipPoints.geometry;
  const pp = precipGeometry.attributes.position.array;
  const pc = precipGeometry.attributes.color.array;
  const pa = precipGeometry.attributes.alpha.array;
  const ps = precipGeometry.attributes.pointSize.array;
  let precipCount = 0;
  if (state.displayMode === 'realistic') {
    for (let y = 0; y < state.ny; y++) {
      for (let z = 0; z < state.nz; z++) {
        for (let x = 0; x < state.nx; x++) {
          const i = idx(x, y, z);
          const amount = rain[i] + ice[i];
          if (amount < 0.018 || ((i + cursor) % state.renderStride !== 0))
            continue;
          const p = precipCount * 3;
          pp[p] = (x + 0.5) * state.dx - state.worldX / 2;
          pp[p + 1] = (y + 0.5) * state.dy;
          pp[p + 2] = (z + 0.5) * state.dz - state.worldZ / 2;
          const icy = ice[i] > rain[i];
          pc[p] = icy ? 0.84 : 0.31;
          pc[p + 1] = icy ? 0.91 : 0.68;
          pc[p + 2] = 1;
          pa[precipCount] = clamp(amount * 0.5, 0.08, 0.45);
          ps[precipCount] = Math.max(state.dx, state.dy) * 0.6;
          precipCount++;
        }
      }
    }
  }
  precipGeometry.setDrawRange(0, precipCount);
  Object.values(precipGeometry.attributes).forEach(attribute => attribute.needsUpdate = true);
  precipPoints.material.uniforms.opacityScale.value = state.volumeOpacity;
}

function updateWindLines() {
  if (!windLines)
    return;
  windLines.visible = state.showWind;
  if (!state.showWind)
    return;
  const positions = windLines.geometry.attributes.position.array;
  const y = clamp(Math.floor(state.brushAltitude / state.dy), 0, state.ny - 1);
  const sampleCount = 12;
  let count = 0;
  for (let gz = 0; gz < sampleCount; gz++) {
    for (let gx = 0; gx < sampleCount; gx++) {
      const x = Math.floor((gx + 0.5) / sampleCount * state.nx);
      const z = Math.floor((gz + 0.5) / sampleCount * state.nz);
      const i = idx(x, y, z);
      const px = (x + 0.5) * state.dx - state.worldX / 2;
      const pz = (z + 0.5) * state.dz - state.worldZ / 2;
      const scale = 0.075;
      const p = count * 6;
      positions[p] = px;
      positions[p + 1] = state.brushAltitude;
      positions[p + 2] = pz;
      positions[p + 3] = px + u[i] * scale;
      positions[p + 4] = state.brushAltitude + w[i] * scale * 0.35;
      positions[p + 5] = pz + v[i] * scale;
      count++;
    }
  }
  windLines.geometry.setDrawRange(0, count * 2);
  windLines.geometry.attributes.position.needsUpdate = true;
}

function updateDiagnostics() {
  let cloudBase = Infinity;
  let cloudTop = 0;
  let maxW = -Infinity;
  let maxSpeed = 0;
  let rainCells = 0;
  let hailCells = 0;
  for (let y = 0; y < state.ny; y++) {
    for (let z = 0; z < state.nz; z++) {
      for (let x = 0; x < state.nx; x++) {
        const i = idx(x, y, z);
        if (y <= groundCell[idx2(x, z)])
          continue;
        const altitude = (y + 0.5) * state.dy;
        if (cloud[i] > 0.035) {
          cloudBase = Math.min(cloudBase, altitude);
          cloudTop = Math.max(cloudTop, altitude);
        }
        maxW = Math.max(maxW, w[i]);
        maxSpeed = Math.max(maxSpeed, Math.hypot(u[i], v[i]));
        if (rain[i] > 0.025)
          rainCells++;
        if (ice[i] > 0.025)
          hailCells++;
      }
    }
  }
  const estimatedCape = Math.max(0, (state.lapseRate - 5.5) * 780 + (state.surfaceHumidity - 45) * 25);
  $('cloudBase').textContent = Number.isFinite(cloudBase) ? `${cloudBase.toFixed(1)} km` : '—';
  $('cloudTop').textContent = cloudTop > 0 ? `${cloudTop.toFixed(1)} km` : '—';
  $('maxUpdraft').textContent = `${Math.max(0, maxW).toFixed(1)} m/s`;
  $('maxWind').textContent = `${(maxSpeed * 3.6).toFixed(0)} km/h`;
  $('cape').textContent = `${estimatedCape.toFixed(0)} J/kg`;
  $('precipCells').textContent = `${rainCells.toLocaleString()} / ${hailCells.toLocaleString()}`;
  $('timeReadout').textContent = formatDuration(state.modelSeconds);
  if (selectedCell)
    showCell(...selectedCell);
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return [hours, minutes, secs].map(value => String(value).padStart(2, '0')).join(':');
}

function formatClock(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.round((hours - Math.floor(hours)) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function updateSun() {
  const angle = (state.dayTime / 24) * Math.PI * 2 - Math.PI / 2;
  const height = Math.sin(angle);
  const horizontal = Math.cos(angle);
  sunLight.position.set(horizontal * -42, height * 50, 20);
  sunDisc.position.copy(sunLight.position).normalize().multiplyScalar(95);
  sunDisc.visible = height > -0.08;
  sunLight.intensity = Math.max(0.04, height * 3.6);
  hemiLight.intensity = 0.28 + Math.max(0, height) * 2.05;
  const night = new THREE.Color(0x071423);
  const day = new THREE.Color(0x6a9abc);
  scene.background.copy(night).lerp(day, clamp((height + 0.08) * 1.7, 0, 1));
  scene.fog.color.copy(scene.background).lerp(new THREE.Color(0xa8c3d3), 0.22);
  $('dayTime').value = state.dayTime;
  $('dayTimeValue').textContent = formatClock(state.dayTime);
}

function maskTerrainColumn(x, z) {
  const s = idx2(x, z);
  groundCell[s] = clamp(Math.floor(terrain[s] / state.dy), 0, state.ny - 2);
  for (let y = 0; y <= groundCell[s]; y++) {
    const i = idx(x, y, z);
    vapor[i] = cloud[i] = rain[i] = ice[i] = 0;
    u[i] = v[i] = w[i] = pressure[i] = 0;
  }
}

function paintAt(point, inverted = false, windVector = null) {
  if (!state.running)
    return;
  const radius = state.brushSize / 2;
  const cx = Math.floor((point.x + state.worldX / 2) / state.dx);
  const cz = Math.floor((point.z + state.worldZ / 2) / state.dz);
  const cy = clamp(Math.floor(state.brushAltitude / state.dy), 0, state.ny - 1);
  const xRadius = Math.ceil(radius / state.dx);
  const zRadius = Math.ceil(radius / state.dz);
  const yRadius = Math.max(1, Math.ceil(radius / state.dy));
  const sign = inverted ? -1 : 1;
  const terrainTool = ['land', 'sea', 'fire'].includes(state.tool);

  for (let z = Math.max(0, cz - zRadius); z <= Math.min(state.nz - 1, cz + zRadius); z++) {
    for (let x = Math.max(0, cx - xRadius); x <= Math.min(state.nx - 1, cx + xRadius); x++) {
      const wx = ((x + 0.5) * state.dx - state.worldX / 2 - point.x) / radius;
      const wz = ((z + 0.5) * state.dz - state.worldZ / 2 - point.z) / radius;
      const horizontalDistance = wx * wx + wz * wz;
      if (horizontalDistance > 1)
        continue;
      const horizontalWeight = (1 - horizontalDistance) ** 2;
      const s = idx2(x, z);
      if (state.tool === 'land') {
        terrain[s] = clamp(terrain[s] + sign * state.brushIntensity * horizontalWeight * 0.22, 0, state.worldY * 0.55);
        if (!inverted)
          surface[s] = 0;
        maskTerrainColumn(x, z);
        continue;
      }
      if (state.tool === 'sea') {
        surface[s] = inverted ? 0 : 1;
        if (!inverted)
          terrain[s] = Math.min(terrain[s], 0.025);
        maskTerrainColumn(x, z);
        continue;
      }
      if (state.tool === 'fire') {
        surface[s] = inverted ? 0 : 2;
        continue;
      }
      if (terrainTool)
        continue;

      const yStart = state.wholeColumn ? groundCell[s] + 1 : Math.max(groundCell[s] + 1, cy - yRadius);
      const yEnd = state.wholeColumn ? state.ny - 1 : Math.min(state.ny - 1, cy + yRadius);
      for (let y = yStart; y <= yEnd; y++) {
        const vertical = state.wholeColumn ? 1 : 1 - Math.min(1, Math.abs(y - cy) / (yRadius + 0.5));
        const weight = horizontalWeight * vertical * state.brushIntensity;
        const i = idx(x, y, z);
        if (state.tool === 'temperature')
          temperature[i] = clamp(temperature[i] + sign * weight * 0.55, -88, 55);
        else if (state.tool === 'moisture') {
          vapor[i] = clamp(vapor[i] + sign * weight * 0.045, 0, 1.35);
          if (!inverted && vapor[i] > saturationRatio(temperature[i], y))
            cloud[i] += weight * 0.018;
        } else if (state.tool === 'updraft')
          w[i] = clamp(w[i] + sign * weight * 2.2, -30, 68);
        else if (state.tool === 'wind') {
          const vector = windVector || new THREE.Vector2(1, 0);
          const length = Math.max(vector.length(), 0.001);
          const speed = sign * weight * Math.min(30, 8 + length * 4);
          u[i] = clamp(u[i] + vector.x / length * speed, -55, 55);
          v[i] = clamp(v[i] + vector.y / length * speed, -55, 55);
        }
      }
    }
  }
  if (terrainTool)
    updateTerrainMesh();
}

function showCell(x, y, z) {
  x = clamp(x, 0, state.nx - 1);
  z = clamp(z, 0, state.nz - 1);
  y = clamp(y, groundCell[idx2(x, z)] + 1, state.ny - 1);
  selectedCell = [x, y, z];
  const i = idx(x, y, z);
  const rh = clamp(vapor[i] / Math.max(saturationRatio(temperature[i], y), 0.01) * 100, 0, 180);
  const speed = Math.hypot(u[i], v[i]);
  $('cellReadout').innerHTML = `
    <div class="stat"><span>Position</span><strong>${((x + .5) * state.dx - state.worldX / 2).toFixed(1)}, ${((z + .5) * state.dz - state.worldZ / 2).toFixed(1)} km</strong></div>
    <div class="stat"><span>Altitude</span><strong>${((y + .5) * state.dy).toFixed(2)} km</strong></div>
    <div class="stat"><span>Temperature</span><strong>${temperature[i].toFixed(1)} °C</strong></div>
    <div class="stat"><span>Relative humidity</span><strong>${rh.toFixed(0)}%</strong></div>
    <div class="stat"><span>Cloud water</span><strong>${cloud[i].toFixed(3)}</strong></div>
    <div class="stat"><span>Wind</span><strong>${(speed * 3.6).toFixed(0)} km/h</strong></div>
    <div class="stat"><span>Vertical speed</span><strong>${w[i].toFixed(1)} m/s</strong></div>
    <div class="stat"><span>Pressure anomaly</span><strong>${pressure[i].toFixed(2)}</strong></div>`;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const interactionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const interactionPoint = new THREE.Vector3();
let painting = false;
let windStart = null;
let lastPaint = 0;
let bPressed = false;

function pointerWorld(event, terrainLevel = false) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  interactionPlane.constant = -(terrainLevel ? 0.04 : state.brushAltitude);
  if (!raycaster.ray.intersectPlane(interactionPlane, interactionPoint))
    return null;
  if (Math.abs(interactionPoint.x) > state.worldX / 2 || Math.abs(interactionPoint.z) > state.worldZ / 2)
    return null;
  return interactionPoint.clone();
}

function updateBrushFromPointer(event) {
  if (!state.running || !brushRing)
    return null;
  const terrainLevel = ['land', 'sea', 'fire'].includes(state.tool);
  const point = pointerWorld(event, terrainLevel);
  brushRing.visible = Boolean(point);
  if (!point)
    return null;
  brushRing.position.copy(point);
  brushRing.position.y = terrainLevel ? 0.08 : state.brushAltitude;
  brushRing.scale.setScalar(state.brushSize);
  const colors = {temperature: 0xff8b45, moisture: 0x43cbff, updraft: 0xeefaff, wind: 0x84e7ff, land: 0x7fd365, sea: 0x389fee, fire: 0xff5038, inspect: 0xffef8b};
  brushRing.material.color.setHex(colors[state.tool]);
  return point;
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !state.running)
    return;
  const point = updateBrushFromPointer(event);
  if (!point)
    return;
  if (state.tool === 'inspect') {
    const x = Math.floor((point.x + state.worldX / 2) / state.dx);
    const z = Math.floor((point.z + state.worldZ / 2) / state.dz);
    const y = Math.floor(state.brushAltitude / state.dy);
    showCell(x, y, z);
    return;
  }
  painting = true;
  controls.enabled = false;
  canvas.setPointerCapture(event.pointerId);
  windStart = state.tool === 'wind' ? point.clone() : null;
  paintAt(point, event.ctrlKey || event.metaKey);
});

canvas.addEventListener('pointermove', event => {
  const point = updateBrushFromPointer(event);
  if (!painting || !point || performance.now() - lastPaint < 24)
    return;
  lastPaint = performance.now();
  const windVector = windStart ? new THREE.Vector2(point.x - windStart.x, point.z - windStart.z) : null;
  paintAt(point, event.ctrlKey || event.metaKey, windVector);
});

function stopPainting(event) {
  if (!painting)
    return;
  painting = false;
  windStart = null;
  controls.enabled = true;
  if (event.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId))
    canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener('pointerup', stopPainting);
canvas.addEventListener('pointercancel', stopPainting);
canvas.addEventListener('pointerleave', event => {
  if (!painting && brushRing)
    brushRing.visible = false;
  else if (painting)
    stopPainting(event);
});
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
  if (!bPressed)
    return;
  event.preventDefault();
  state.brushSize = clamp(state.brushSize + (event.deltaY > 0 ? -0.5 : 0.5), 1, 10);
  $('brushSize').value = state.brushSize;
  updateToolUI();
}, {passive: false});

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach(button => button.classList.toggle('active', button.dataset.tool === tool));
  const keyNames = {inspect: 'F', temperature: 'T', moisture: 'M', updraft: 'U', wind: 'V', land: 'L', sea: 'O', fire: 'X'};
  const hints = {
    inspect: 'Left-click at the selected altitude to sample a cell.',
    temperature: 'Paint heat. Hold Ctrl to cool the air.',
    moisture: 'Paint water vapor. Hold Ctrl to dry the air.',
    updraft: 'Kick air upward. Hold Ctrl to force a downdraft.',
    wind: 'Drag to set horizontal wind direction and strength.',
    land: 'Sculpt terrain upward. Hold Ctrl to erode it.',
    sea: 'Paint lake / sea surface. Hold Ctrl to restore land.',
    fire: 'Paint persistent heat sources. Hold Ctrl to extinguish.'
  };
  $('toolKey').textContent = keyNames[tool];
  $('toolHint').textContent = hints[tool];
}

function updateToolUI() {
  $('brushValue').textContent = `${state.brushSize.toFixed(1)} km`;
  $('altitudeValue').textContent = `${state.brushAltitude.toFixed(2)} km`;
  $('intensityValue').textContent = `${Math.round(state.brushIntensity * 100)}%`;
  if (brushRing)
    brushRing.scale.setScalar(state.brushSize);
}

function updateEnvironmentUI() {
  $('surfaceTemp').value = state.surfaceTemp;
  $('surfaceHumidity').value = state.surfaceHumidity;
  $('lapseRate').value = state.lapseRate;
  $('shear').value = state.shear;
  $('surfaceTempValue').textContent = `${state.surfaceTemp.toFixed(0)}°C`;
  $('surfaceHumidityValue').textContent = `${state.surfaceHumidity.toFixed(0)}%`;
  $('lapseRateValue').textContent = `${state.lapseRate.toFixed(1)}°C/km`;
  $('shearValue').textContent = `${state.shear.toFixed(0)} m/s`;
  $('gridSize').textContent = `${state.nx} × ${state.ny} × ${state.nz}`;
  $('domainSize').textContent = `${state.worldX} × ${state.worldZ} × ${state.worldY} km`;
  updateToolUI();
}

function updateLegend() {
  const legends = {
    realistic: ['clear', 'realistic', 'dense', 'linear-gradient(90deg,#526775,#c5d0d7,#fff)'],
    temperature: ['−45°C', 'temperature', '30°C', 'linear-gradient(90deg,#282b82,#1675d1,#24d8d0,#64df7a,#ffe75f,#ff853b,#d62f52)'],
    humidity: ['dry', 'water / cloud', 'saturated', 'linear-gradient(90deg,#152739,#176ca1,#27cbe0,#d9f5f8,#fff)'],
    wind: ['calm', 'horizontal wind', '45 m/s', 'linear-gradient(90deg,#202b78,#1fb7da,#50e06c,#ffec58,#ff7438,#d92a56)'],
    vertical: ['−18 m/s', 'vertical wind', '+40 m/s', 'linear-gradient(90deg,#1d3eaa,#31b8ee,#f0f3f5,#ffa040,#e12e47)'],
    pressure: ['low', 'pressure', 'high', 'linear-gradient(90deg,#5531a7,#3b9ce2,#eee,#ffc14a,#ce3f55)'],
    precipitation: ['none', 'rain / hail', 'heavy', 'linear-gradient(90deg,#142e51,#235fba,#37d7e8,#f4f7ff,#e68bff)'],
  };
  const legend = legends[state.displayMode];
  $('legendMin').textContent = legend[0];
  $('legendName').textContent = legend[1];
  $('legendMax').textContent = legend[2];
  $('legend').style.background = legend[3];
}

function togglePause() {
  state.paused = !state.paused;
  $('pauseButton').textContent = state.paused ? 'Resume' : 'Pause';
  toast(state.paused ? 'Model paused.' : 'Model running.');
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2400);
}

function bytesToBase64(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToFloat32(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function base64ToUint8(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function saveSimulation() {
  if (!state.running)
    return;
  const data = {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    config: {
      preset: state.preset, worldX: state.worldX, worldY: state.worldY,
      nx: state.nx, ny: state.ny, modelSeconds: state.modelSeconds,
      surfaceTemp: state.surfaceTemp, surfaceHumidity: state.surfaceHumidity,
      lapseRate: state.lapseRate, shear: state.shear, dayTime: state.dayTime
    },
    fields: {
      temperature: bytesToBase64(temperature), vapor: bytesToBase64(vapor),
      cloud: bytesToBase64(cloud), rain: bytesToBase64(rain), ice: bytesToBase64(ice),
      u: bytesToBase64(u), v: bytesToBase64(v), w: bytesToBase64(w),
      pressure: bytesToBase64(pressure), terrain: bytesToBase64(terrain),
      surface: bytesToBase64(surface)
    }
  };
  const blob = new Blob([JSON.stringify(data)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `3D Weather ${state.preset} ${Math.floor(state.modelSeconds / 60)}min.weather3d`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Simulation saved.');
}

async function loadSimulation(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.version !== SAVE_VERSION)
      throw new Error('Unsupported save version');
    const config = data.config;
    state.preset = config.preset;
    state.worldX = state.worldZ = config.worldX;
    state.worldY = config.worldY;
    state.nx = state.nz = config.nx;
    state.ny = config.ny;
    state.dx = state.worldX / state.nx;
    state.dz = state.worldZ / state.nz;
    state.dy = state.worldY / state.ny;
    Object.assign(state, {
      modelSeconds: config.modelSeconds, surfaceTemp: config.surfaceTemp,
      surfaceHumidity: config.surfaceHumidity, lapseRate: config.lapseRate,
      shear: config.shear, dayTime: config.dayTime
    });
    allocateFields();
    temperature.set(base64ToFloat32(data.fields.temperature));
    vapor.set(base64ToFloat32(data.fields.vapor));
    cloud.set(base64ToFloat32(data.fields.cloud));
    rain.set(base64ToFloat32(data.fields.rain));
    ice.set(base64ToFloat32(data.fields.ice));
    u.set(base64ToFloat32(data.fields.u));
    v.set(base64ToFloat32(data.fields.v));
    w.set(base64ToFloat32(data.fields.w));
    pressure.set(base64ToFloat32(data.fields.pressure));
    terrain.set(base64ToFloat32(data.fields.terrain));
    surface.set(base64ToUint8(data.fields.surface));
    for (let z = 0; z < state.nz; z++)
      for (let x = 0; x < state.nx; x++)
        maskTerrainColumn(x, z);
    buildTerrainMesh();
    buildDomainGuides();
    buildVolumeObjects();
    buildBrush();
    buildWindLines();
    updateEnvironmentUI();
    updateVolumeGeometry();
    updateSun();
    state.running = true;
    state.paused = true;
    $('pauseButton').textContent = 'Resume';
    $('setup').classList.add('hidden');
    toast(`Loaded ${file.name}. Model paused for inspection.`);
  } catch (error) {
    console.error(error);
    toast(`Could not load save: ${error.message}`);
  }
}

function wireUI() {
  document.querySelectorAll('.scenario').forEach(button => button.addEventListener('click', () => {
    state.preset = button.dataset.preset;
    document.querySelectorAll('.scenario').forEach(other => other.classList.toggle('active', other === button));
  }));
  document.querySelectorAll('.tool').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $('startButton').addEventListener('click', createSimulation);
  $('pauseButton').addEventListener('click', togglePause);
  $('stepButton').addEventListener('click', () => {
    if (!state.running)
      return;
    physicsStep();
    updateVolumeGeometry();
    updateDiagnostics();
  });
  $('resetButton').addEventListener('click', () => {
    if (!state.running)
      return;
    initializeAtmosphere();
    updateTerrainMesh();
    updateVolumeGeometry();
    toast('Scenario reset.');
  });
  $('setupButton').addEventListener('click', () => $('setup').classList.remove('hidden'));
  $('saveButton').addEventListener('click', saveSimulation);
  $('loadButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file)
      loadSimulation(file);
    event.target.value = '';
  });

  for (const id of ['worldSize', 'worldHeight', 'detail']) {
    $(id).addEventListener('input', () => {
      const detail = Number($('detail').value);
      const labels = ['Fast · 34 × 22 × 34', 'Balanced · 44 × 28 × 44', 'Detailed · 54 × 34 × 54'];
      $('worldSizeValue').textContent = `${$('worldSize').value} × ${$('worldSize').value} km`;
      $('worldHeightValue').textContent = `${$('worldHeight').value} km`;
      $('detailValue').textContent = labels[detail];
    });
  }

  $('brushSize').addEventListener('input', event => { state.brushSize = Number(event.target.value); updateToolUI(); });
  $('brushAltitude').addEventListener('input', event => { state.brushAltitude = Number(event.target.value); updateToolUI(); updateWindLines(); });
  $('brushIntensity').addEventListener('input', event => { state.brushIntensity = Number(event.target.value); updateToolUI(); });
  $('wholeColumn').addEventListener('change', event => state.wholeColumn = event.target.checked);
  $('wrapWorld').addEventListener('change', event => state.wrap = event.target.checked);
  $('showWind').addEventListener('change', event => { state.showWind = event.target.checked; updateWindLines(); });
  $('showGrid').addEventListener('change', event => {
    state.showGrid = event.target.checked;
    if (gridHelper) gridHelper.visible = state.showGrid;
    if (domainEdges) domainEdges.visible = state.showGrid;
  });
  $('speed').addEventListener('input', event => {
    state.speed = Number(event.target.value);
    $('speedValue').textContent = `${state.speed.toFixed(2).replace(/0$/, '')}×`;
  });
  $('displayMode').addEventListener('change', event => {
    state.displayMode = event.target.value;
    updateLegend();
    updateVolumeGeometry();
  });
  $('volumeOpacity').addEventListener('input', event => {
    state.volumeOpacity = Number(event.target.value);
    $('opacityValue').textContent = `${Math.round(state.volumeOpacity * 100)}%`;
    if (volumePoints) volumePoints.material.uniforms.opacityScale.value = state.volumeOpacity;
    if (precipPoints) precipPoints.material.uniforms.opacityScale.value = state.volumeOpacity;
  });
  $('dayTime').addEventListener('input', event => {
    state.dayTime = Number(event.target.value);
    state.dayCycle = false;
    $('dayCycle').checked = false;
    updateSun();
  });
  $('dayCycle').addEventListener('change', event => state.dayCycle = event.target.checked);

  const environmentBindings = [
    ['surfaceTemp', 'surfaceTemp', value => `${value.toFixed(0)}°C`],
    ['surfaceHumidity', 'surfaceHumidity', value => `${value.toFixed(0)}%`],
    ['lapseRate', 'lapseRate', value => `${value.toFixed(1)}°C/km`],
    ['shear', 'shear', value => `${value.toFixed(0)} m/s`]
  ];
  environmentBindings.forEach(([id, key, format]) => $(id).addEventListener('input', event => {
    state[key] = Number(event.target.value);
    $(`${id}Value`).textContent = format(state[key]);
  }));

  window.addEventListener('keydown', event => {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target?.tagName))
      return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePause();
    } else if (event.key.toLowerCase() === 'r') {
      initializeAtmosphere();
      updateTerrainMesh();
      updateVolumeGeometry();
      updateDiagnostics();
    } else if (event.key.toLowerCase() === 'b') {
      bPressed = true;
    } else if (/^[1-7]$/.test(event.key)) {
      const modes = ['temperature', 'humidity', 'realistic', 'wind', 'vertical', 'pressure', 'precipitation'];
      state.displayMode = modes[Number(event.key) - 1];
      $('displayMode').value = state.displayMode;
      updateLegend();
      updateVolumeGeometry();
    } else {
      const tools = {f: 'inspect', t: 'temperature', m: 'moisture', u: 'updraft', v: 'wind', l: 'land', o: 'sea', x: 'fire'};
      if (tools[event.key.toLowerCase()])
        setTool(tools[event.key.toLowerCase()]);
    }
  });
  window.addEventListener('keyup', event => {
    if (event.key.toLowerCase() === 'b')
      bPressed = false;
  });
  window.addEventListener('blur', () => {
    bPressed = false;
    painting = false;
    controls.enabled = true;
  });
}

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / Math.max(innerHeight, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

wireUI();
updateLegend();
updateToolUI();

let lastTime = performance.now();
let accumulator = 0;
let renderFrames = 0;
let diagnosticsTimer = 0;
let fpsTimer = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const delta = Math.min((now - lastTime) / 1000, 0.12);
  lastTime = now;
  if (state.running && !state.paused) {
    accumulator += delta * BASE_STEPS_PER_SECOND * state.speed;
    let guard = 0;
    while (accumulator >= 1 && guard < 10) {
      physicsStep();
      accumulator -= 1;
      guard++;
    }
  }

  renderFrames++;
  if (state.running && renderFrames % 3 === 0) {
    updateVolumeGeometry();
    if (state.showWind)
      updateWindLines();
  }
  if (state.running && now - diagnosticsTimer > 700) {
    updateDiagnostics();
    updateSun();
    diagnosticsTimer = now;
  }
  if (now - fpsTimer > 1000) {
    $('fps').textContent = `${Math.round(renderFrames * 1000 / (now - fpsTimer))} FPS`;
    if ($('autoQuality').checked && state.running) {
      const fps = renderFrames * 1000 / (now - fpsTimer);
      if (fps < 28)
        state.renderStride = Math.min(4, state.renderStride + 1);
      else if (fps > 52)
        state.renderStride = Math.max(1, state.renderStride - 1);
    }
    renderFrames = 0;
    fpsTimer = now;
  }
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
