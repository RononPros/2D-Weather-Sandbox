import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const canvas = $('scene');
const loadingEl = $('loading');
const statusEl = $('status');
const clamp = (v,a,b)=>Math.min(Math.max(v,a),b);
const mix = (a,b,t)=>a+(b-a)*t;

function setStatus(t){ if(statusEl) statusEl.textContent=t; }

const renderer = new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
renderer.setSize(innerWidth,innerHeight,false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x79a8ca);
scene.fog = new THREE.FogExp2(0x91b8d0,0.012);
const camera = new THREE.PerspectiveCamera(52,innerWidth/innerHeight,0.05,180);
camera.position.set(28,15,32);
const controls = new OrbitControls(camera,canvas);
controls.enableDamping=true; controls.dampingFactor=.055; controls.target.set(0,4.8,0); controls.minDistance=7; controls.maxDistance=90;
scene.add(new THREE.HemisphereLight(0xd9efff,0x314534,2.1));
const sun = new THREE.DirectionalLight(0xffefd1,3.6); sun.position.set(-22,30,12); scene.add(sun);

const WORLD=36, TOP=14, MAX_PUFFS=4200, MAX_RAIN=2600;
const state={paused:false,time:0,moisture:.80,instability:1.55,shear:1.05,rotation:.95,relief:.35,speed:1,preset:'supercell'};
let seed=0x51c0ffee;
function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return((seed>>>0)%1000000)/1000000;}

function terrainHeight(x,z){
  const nx=x/WORLD+.5,nz=z/WORLD+.5;
  const r1=Math.exp(-(((nx-.72)/.18)**2+((nz-.60)/.34)**2));
  const r2=Math.exp(-(((nx-.25)/.17)**2+((nz-.28)/.20)**2));
  const waves=.14*Math.sin(nx*Math.PI*4.1)*Math.cos(nz*Math.PI*3.3);
  return Math.max(0,state.relief*(.06+.58*r1+.28*r2+.13*waves));
}

const terrainGeo=new THREE.PlaneGeometry(WORLD,WORLD,90,90); terrainGeo.rotateX(-Math.PI/2);
terrainGeo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(terrainGeo.attributes.position.count*3),3));
const terrain=new THREE.Mesh(terrainGeo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.98})); scene.add(terrain);
function rebuildTerrain(){
  const p=terrainGeo.attributes.position,c=terrainGeo.attributes.color;
  for(let i=0;i<p.count;i++){
    const h=terrainHeight(p.getX(i),p.getZ(i)); p.setY(i,h);
    const t=clamp(h/Math.max(state.relief,.01),0,1); c.setXYZ(i,mix(.12,.34,t),mix(.30,.44,t),mix(.17,.20,t));
  }
  p.needsUpdate=true;c.needsUpdate=true;terrainGeo.computeVertexNormals();
}
rebuildTerrain();

const grid=new THREE.GridHelper(WORLD,18,0xc9e2ef,0x486d80);grid.position.y=.035;grid.material.transparent=true;grid.material.opacity=.18;scene.add(grid);
const edges=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(WORLD,TOP,WORLD)),new THREE.LineBasicMaterial({color:0xcfe6ef,transparent:true,opacity:.12}));edges.position.y=TOP/2;scene.add(edges);

const puffGeo=new THREE.SphereGeometry(.52,10,7);
const puffMat=new THREE.MeshLambertMaterial({color:0xffffff,transparent:true,opacity:.73,depthWrite:false,vertexColors:true});
const puffMesh=new THREE.InstancedMesh(puffGeo,puffMat,MAX_PUFFS);puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);puffMesh.frustumCulled=false;puffMesh.renderOrder=2;scene.add(puffMesh);
const dummy=new THREE.Object3D(), tmpColor=new THREE.Color();

const rainPos=new Float32Array(MAX_RAIN*6);
const rainGeo=new THREE.BufferGeometry(); rainGeo.setAttribute('position',new THREE.BufferAttribute(rainPos,3).setUsage(THREE.DynamicDrawUsage));
const rainLines=new THREE.LineSegments(rainGeo,new THREE.LineBasicMaterial({color:0x9fc8dd,transparent:true,opacity:.42}));scene.add(rainLines);

const windPos=new Float32Array(220*6);const windGeo=new THREE.BufferGeometry();windGeo.setAttribute('position',new THREE.BufferAttribute(windPos,3).setUsage(THREE.DynamicDrawUsage));
const windLines=new THREE.LineSegments(windGeo,new THREE.LineBasicMaterial({color:0x8dd9ff,transparent:true,opacity:.30}));scene.add(windLines);

let puffs=[],rain=[];
function windAt(y,x,z){
  const yn=clamp(y/TOP,0,1); let u=4+24*state.shear*yn, v=-3+18*state.shear*yn;
  if(state.rotation>0){const r=Math.hypot(x,z)+1,sw=7.5*state.rotation*Math.exp(-(x*x+z*z)/95)*(0.2+yn*.8);u+=-z/r*sw;v+=x/r*sw;}
  return [u,v];
}
function spawnPuff(x,z,boost=1){
  if(puffs.length>=MAX_PUFFS)return;
  const y=terrainHeight(x,z)+.25+rand()*.45;
  puffs.push({x:x+(rand()-.5)*1.4,y,z:z+(rand()-.5)*1.4,vy:(2.8+rand()*2.2)*state.instability*boost,size:.42+rand()*.34,age:0,life:75+rand()*95,d:.65+rand()*.35});
}
function triggerBubble(str=1,x=0,z=0){for(let i=0;i<95;i++)spawnPuff(x+(rand()-.5)*4,z+(rand()-.5)*4,str);setStatus('Warm moist bubble triggered. Watch the tower rise, rotate and shear into an anvil.');}
function reset(){
  puffs=[];rain=[];state.time=0;seed=0x51c0ffee;
  if(state.preset==='multicell')[-10,-4,3,9].forEach((x,i)=>triggerBubble(.75+.08*i,x,(i%2?2:-2)));
  else if(state.preset==='pulse')triggerBubble(1.2,0,0);
  else if(state.preset==='dry')triggerBubble(.55,0,0);
  else {triggerBubble(1.35,-4,0);triggerBubble(.75,-8,-3);}
  setStatus('Atmosphere reset. Clouds are now rendered as real 3D puff volumes instead of dots.');
}

function simulate(dt){
  const centers=state.preset==='multicell'?[-10,-4,3,9]:[0];
  if(state.preset!=='dry'&&rand()<.55*dt*state.moisture) centers.forEach(x=>spawnPuff(x,(rand()-.5)*3,.75));
  for(const p of puffs){
    const [u,v]=windAt(p.y,p.x,p.z),yn=p.y/TOP;
    p.x+=u*dt/1000*3.3; p.z+=v*dt/1000*3.3;
    p.y+=p.vy*dt/1000*3.8;
    p.vy+=((1.7*state.instability)*(1-yn)-.28*p.d)*dt*.18; p.vy*=Math.pow(.992,dt*10);
    if(p.y>7){p.size+=dt*.010*(.5+state.shear);p.x+=u*dt/1000*4.5;p.z+=v*dt/1000*4.5;}
    else p.size+=dt*.0035*state.moisture;
    p.age+=dt; p.d*=Math.pow(.9985,dt*10);
    if(p.y>2.5&&p.d>.73&&rand()<.012*dt*state.moisture&&rain.length<MAX_RAIN) rain.push({x:p.x,y:p.y-.3,z:p.z,vx:u,vz:v});
  }
  puffs=puffs.filter(p=>p.age<p.life&&p.y<TOP+1&&Math.abs(p.x)<WORLD*.7&&Math.abs(p.z)<WORLD*.7&&p.d>.12);
  for(const r of rain){r.x+=r.vx*dt/1000*4;r.z+=r.vz*dt/1000*4;r.y-=10.5*dt/1000*4;}
  rain=rain.filter(r=>r.y>terrainHeight(r.x,r.z)&&Math.abs(r.x)<WORLD/2&&Math.abs(r.z)<WORLD/2);
  state.time+=dt/60;
}

function renderClouds(){
  let n=0,top=0,maxUp=0;
  for(const p of puffs){
    if(n>=MAX_PUFFS)break;
    const yn=clamp(p.y/TOP,0,1),anvil=p.y>7&&state.shear>.35;
    dummy.position.set(p.x,p.y,p.z);dummy.rotation.set(rand()*.15,rand()*Math.PI,rand()*.15);
    const s=p.size*(.85+.45*p.d);dummy.scale.set(s*(anvil?1.7:1.08),s*(anvil?.68:1),s*(anvil?1.4:1.08));dummy.updateMatrix();puffMesh.setMatrixAt(n,dummy.matrix);
    const shade=clamp(.68+.28*yn-.18*p.d*(1-yn),.48,1);tmpColor.setRGB(shade*.96,shade*.99,shade);puffMesh.setColorAt(n,tmpColor);
    top=Math.max(top,p.y);maxUp=Math.max(maxUp,p.vy);n++;
  }
  puffMesh.count=n;puffMesh.instanceMatrix.needsUpdate=true;if(puffMesh.instanceColor)puffMesh.instanceColor.needsUpdate=true;
  $('simTime').textContent=`${state.time.toFixed(1)} min`; $('cloudCells').textContent=n.toLocaleString(); $('maxUpdraft').textContent=`${maxUp.toFixed(1)} m/s`; $('cloudTop').textContent=`${top.toFixed(1)} km`; $('rainCount').textContent=rain.length.toLocaleString();
}
function renderRain(){
  let n=Math.min(rain.length,MAX_RAIN);for(let i=0;i<n;i++){const r=rain[i],o=i*6;rainPos[o]=r.x;rainPos[o+1]=r.y;rainPos[o+2]=r.z;rainPos[o+3]=r.x-r.vx*.001;rainPos[o+4]=r.y+.28;rainPos[o+5]=r.z-r.vz*.001;}
  rainGeo.attributes.position.needsUpdate=true;rainGeo.setDrawRange(0,n*2);
}
function renderWind(){
  let n=0;for(let y=2;y<TOP;y+=3.2)for(let z=-14;z<=14;z+=7)for(let x=-14;x<=14;x+=7){if(n>=220)break;const[u,v]=windAt(y,x,z),o=n*6;windPos[o]=x;windPos[o+1]=y;windPos[o+2]=z;windPos[o+3]=x+u*.05;windPos[o+4]=y;windPos[o+5]=z+v*.05;n++;}
  windGeo.attributes.position.needsUpdate=true;windGeo.setDrawRange(0,n*2);
}

function sync(){
  $('preset').value=state.preset;$('moisture').value=state.moisture;$('instability').value=state.instability;$('shear').value=state.shear;$('rotation').value=state.rotation;$('terrain').value=state.relief;$('speed').value=state.speed;
  $('moistureValue').textContent=`${Math.round(state.moisture*100)}%`;$('instabilityValue').textContent=`${state.instability.toFixed(2)}×`;$('shearValue').textContent=state.shear.toFixed(2);$('rotationValue').textContent=state.rotation.toFixed(2);$('terrainValue').textContent=`${state.relief.toFixed(2)} km`;$('speedValue').textContent=`${state.speed.toFixed(2)}×`;
}
function preset(name){state.preset=name;if(name==='supercell'){state.moisture=.80;state.instability=1.55;state.shear=1.05;state.rotation=.95;}else if(name==='pulse'){state.moisture=.84;state.instability=1.85;state.shear=.18;state.rotation=.04;}else if(name==='multicell'){state.moisture=.78;state.instability=1.45;state.shear=.62;state.rotation=.18;}else{state.moisture=.42;state.instability=1.15;state.shear=.32;state.rotation=.03;}sync();reset();}
function range(id,key,fmt,cb){$(id).addEventListener('input',()=>{state[key]=Number($(id).value);$(`${id}Value`).textContent=fmt(state[key]);if(cb)cb();});}
range('moisture','moisture',v=>`${Math.round(v*100)}%`);range('instability','instability',v=>`${v.toFixed(2)}×`);range('shear','shear',v=>v.toFixed(2),renderWind);range('rotation','rotation',v=>v.toFixed(2),renderWind);range('terrain','relief',v=>`${v.toFixed(2)} km`,()=>{rebuildTerrain();reset();});range('speed','speed',v=>`${v.toFixed(2)}×`);
$('preset').addEventListener('change',e=>preset(e.target.value));$('pause').addEventListener('click',()=>{state.paused=!state.paused;$('pause').textContent=state.paused?'Resume':'Pause';});$('reset').addEventListener('click',reset);$('bubble').addEventListener('click',()=>triggerBubble(1.25,-2+(rand()-.5)*4,(rand()-.5)*4));
$('showGrid').addEventListener('change',e=>{grid.visible=e.target.checked;edges.visible=e.target.checked;windLines.visible=e.target.checked;});
addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/Math.max(innerHeight,1);camera.updateProjectionMatrix();});
addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target?.tagName))return;if(e.code==='Space'){e.preventDefault();state.paused=!state.paused;$('pause').textContent=state.paused?'Resume':'Pause';}else if(e.key.toLowerCase()==='r')reset();});

sync();reset();renderWind();
let last=performance.now(),frame=0;
function animate(now){requestAnimationFrame(animate);const realDt=Math.min((now-last)/1000,.08);last=now;if(!state.paused)simulate(realDt*42*state.speed);frame++;if(frame%2===0){renderClouds();renderRain();}if(frame%24===0)renderWind();controls.update();renderer.render(scene,camera);}
loadingEl.classList.add('hidden');setTimeout(()=>loadingEl.remove(),450);setStatus('Visual V2 loaded: 3D cloud bodies, anvil spreading, shaded towers, rain shafts, terrain and wind vectors.');requestAnimationFrame(animate);
