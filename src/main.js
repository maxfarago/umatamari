import "./style.css";
import * as THREE from "three";
import { BufferGeometryUtils } from "three/examples/jsm/utils/BufferGeometryUtils.js";


// ---------------------------------------------------------------- constants
var GOAL_R      = 4.0;      // 8 m across = 78.2hh
var START_R     = 0.30;
var ROUND_TIME  = 180;
var WORLD       = 130;
var PICKUP      = 1.55;
var FILL        = 0.32;
var FIXED       = 1/60;
var MAX_STEPS   = 6;
var HEAD_K      = 0.85;
var HEAD_POW    = 0.65;
var CM_PER_HAND = 10.16;    // four inches, exactly
var MODE_KEY    = "umatamari-mode";
var HINT_TIMED  = "Small stuff sticks. Big stuff says nay.";
var HINT_ENDLESS= "No bell. Stay small and the army ignores you. Esc or tap the clock when you're done.";
var UP          = new THREE.Vector3(0,1,0);
var DEBRIS_CAP  = 24;
var TRACER_CAP  = 40;
var HIT_INVULN  = 0.55;
var GULP        = 0.10;
var HIT_STOP    = 3;

// ---------------------------------------------------------------- rng
function fnv1a(s){
  var h = 2166136261 >>> 0;
  for (var i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a){
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function todaySeed(){
  var d = new Date();
  return d.getUTCFullYear() + "-" +
         ("0"+(d.getUTCMonth()+1)).slice(-2) + "-" +
         ("0"+d.getUTCDate()).slice(-2);
}
var SEED = (new URLSearchParams(location.search).get("seed") || todaySeed()).slice(0,40);
var DEV  = SEED === "dev";
var rnd  = mulberry32(fnv1a(SEED));
function reseed(){ rnd = mulberry32(fnv1a(SEED)); }
var trnd = mulberry32(0xC0FFEE);

var actx = null;
function ensureAudio(){
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!actx) actx = new AC();
  if (actx.state === "suspended") actx.resume();
}
function tone(freq, dur, type, vol, dest, delay){
  if (!actx) return;
  var t = actx.currentTime + (delay || 0);
  var o = actx.createOscillator();
  var g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (dest) o.frequency.exponentialRampToValueAtTime(Math.max(1, dest), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.01);
}
function noise(dur, vol, freq){
  if (!actx) return;
  var n = Math.max(1, (actx.sampleRate * dur) | 0);
  var buf = actx.createBuffer(1, n, actx.sampleRate);
  var data = buf.getChannelData(0), i;
  for (i=0;i<n;i++) data[i] = Math.random()*2-1;
  var src = actx.createBufferSource();
  src.buffer = buf;
  var f = actx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = 0.8;
  var g = actx.createGain();
  var t = actx.currentTime;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start(t);
}
function sfxStick(){
  var f = 260 * Math.pow(radius / START_R, 0.32);
  if (f > 920) f = 920;
  tone(f, 0.048, "square", 0.07, f * 1.28);
  tone(f * 2, 0.03, "square", 0.028);
}
function sfxNay(){
  tone(98, 0.16, "triangle", 0.18, 52);
  noise(0.09, 0.12, 180);
}
function sfxShed(){
  noise(0.07, 0.1, 420);
  tone(190, 0.06, "square", 0.04, 90);
}
function sfxWanted(){
  tone(392, 0.1, "square", 0.09);
  tone(466, 0.14, "square", 0.09, 330, 0.09);
}

function loadMode(){
  try { return sessionStorage.getItem(MODE_KEY) || "timed"; } catch(e){ return "timed"; }
}
function saveMode(m){
  try { sessionStorage.setItem(MODE_KEY, m); } catch(e){}
}

// ---------------------------------------------------------------- renderer
var DPR = Math.min(window.devicePixelRatio || 1, 1.25);
var renderer = new THREE.WebGLRenderer({
  antialias: DPR < 1.15,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
document.body.appendChild(renderer.domElement);

var SKY_FOG     = 0xece4cd;
var SUN_LIGHT   = new THREE.Vector3(22, 55, -30);
var SUN_VIEW    = new THREE.Vector3(8, 12, -45).normalize();

var scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_FOG);
scene.fog = new THREE.Fog(SKY_FOG, 60, 230);

var camera = new THREE.PerspectiveCamera(58, innerWidth/innerHeight, 0.1, 700);

var hemi = new THREE.HemisphereLight(0xe5f2ff, 0x879b70, 0.8);
scene.add(hemi);
var sun = new THREE.DirectionalLight(0xffedcf, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024,1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far  = 160;
sun.shadow.bias = -0.0012;
scene.add(sun);
scene.add(sun.target);

// ---------------------------------------------------------------- ground
function groundTexture(){
  var s = 1024, i, x, y, len, rot, dx, dy, ox, oz;
  var c = document.createElement("canvas"); c.width = c.height = s;
  var g = c.getContext("2d");
  g.fillStyle = "#91ad78";
  g.fillRect(0,0,s,s);
  g.lineCap = "round";
  function blades(color, alpha, n, w, l0, l1){
    g.strokeStyle = color;
    g.globalAlpha = alpha;
    g.lineWidth = w;
    for (i=0;i<n;i++){
      x = trnd()*s;
      y = trnd()*s;
      len = l0 + trnd()*(l1-l0);
      rot = -0.22 + trnd()*0.44;
      dx = Math.sin(rot)*len;
      dy = -Math.cos(rot)*len;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x+dx, y+dy);
      g.stroke();
      if (x < len || y < len || x > s-len || y > s-len){
        for (ox=-1;ox<=1;ox++) for (oz=-1;oz<=1;oz++){
          if (!ox && !oz) continue;
          g.beginPath();
          g.moveTo(x+ox*s, y+oz*s);
          g.lineTo(x+dx+ox*s, y+dy+oz*s);
          g.stroke();
        }
      }
    }
  }
  blades("#78965f", 0.32, 13000, 1.15, 3, 6);
  blades("#bed09b", 0.30, 10000, 1.0, 2.5, 5);
  blades("#6d8c57", 0.18, 6000, 1.0, 2, 4.5);
  g.globalAlpha = 1;
  var t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(96, 96);
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}
// broad color varies in world space, independently of the fine grass tile
var groundMat = new THREE.MeshLambertMaterial({map:groundTexture()});
groundMat.onBeforeCompile = function(shader){
  shader.vertexShader = "varying vec2 pasturePosition;\n" + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>",
    "#include <begin_vertex>\npasturePosition = (modelMatrix * vec4(position, 1.0)).xz;");
  shader.fragmentShader = "varying vec2 pasturePosition;\n" + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>",
    "#include <map_fragment>\n" +
    "float pasture = sin(dot(pasturePosition, vec2(0.071, 0.043))) * sin(dot(pasturePosition, vec2(-0.037, 0.093)));\n" +
    "pasture += 0.5 * sin(dot(pasturePosition, vec2(0.129, -0.057)) + 1.7);\n" +
    "diffuseColor.rgb *= 0.98 + 0.035 * pasture;");
};
var ground = new THREE.Mesh(
  new THREE.CircleGeometry(WORLD * 8, 80),
  groundMat
);
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);

function skyTexture(){
  var c = document.createElement("canvas"); c.width = 8; c.height = 256;
  var g = c.getContext("2d");
  var grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#77a7c3");
  grd.addColorStop(0.32, "#91bed3");
  grd.addColorStop(0.40, "#abd0df");
  grd.addColorStop(0.45, "#c7e0e6");
  grd.addColorStop(0.49, "#ece4cd");
  grd.addColorStop(1, "#ece4cd");
  g.fillStyle = grd;
  g.fillRect(0, 0, 8, 256);
  var t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  return t;
}
var skyMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: skyTexture() },
    projInverse: { value: new THREE.Matrix4() },
    viewInverse: { value: new THREE.Matrix4() }
  },
  vertexShader: [
    "uniform mat4 projInverse;",
    "uniform mat4 viewInverse;",
    "varying vec3 vDir;",
    "void main(){",
    "  gl_Position = vec4(position.xy, 0.0, 1.0);",
    "  vec4 view = projInverse * vec4(position.xy, 1.0, 1.0);",
    "  view.xyz /= view.w;",
    "  vDir = mat3(viewInverse) * view.xyz;",
    "}"
  ].join("\n"),
  fragmentShader: [
    "uniform sampler2D map;",
    "varying vec3 vDir;",
    "void main(){",
    "  vec3 d = normalize(vDir);",
    "  float v = 0.5 + 0.5 * d.y;",
    "  gl_FragColor = texture2D(map, vec2(0.5, clamp(v, 0.0, 1.0)));",
    "}"
  ].join("\n"),
  depthTest: false,
  depthWrite: false,
  fog: false
});
var sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat);
sky.frustumCulled = false;
sky.renderOrder = -2;
scene.add(sky);

var skyRoot = new THREE.Group();
scene.add(skyRoot);

var sunMat = new THREE.MeshBasicMaterial({
  color: 0xffe082, fog: false, depthTest: false, depthWrite: false
});
var sunDisc = new THREE.Mesh(new THREE.SphereGeometry(36, 16, 12), sunMat);
sunDisc.position.copy(SUN_VIEW).multiplyScalar(260);
sunDisc.frustumCulled = false;
sunDisc.renderOrder = -1;
skyRoot.add(sunDisc);

var sunGlow = new THREE.Mesh(
  new THREE.SphereGeometry(70, 12, 10),
  new THREE.MeshBasicMaterial({
    color: 0xffe08a,
    fog: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.28
  })
);
sunGlow.position.copy(SUN_VIEW).multiplyScalar(260);
sunGlow.frustumCulled = false;
sunGlow.renderOrder = -1;
skyRoot.add(sunGlow);

var cloudMat = new THREE.MeshBasicMaterial({
  color: 0xfff8e9, fog: false, depthTest: false, depthWrite: false
});
var cloudShade = new THREE.MeshBasicMaterial({
  color: 0xe6e8de, fog: false, depthTest: false, depthWrite: false
});
function addCloud(az, el, scale){
  var g = new THREE.Group();
  function slab(w, h, d, x, y, z, mat){
    var m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mat || cloudMat);
    m.scale.set(w * 0.68, h * 0.85, d * 0.65);
    m.position.set(x, y, z);
    m.frustumCulled = false;
    g.add(m);
  }
  slab(1.8, 0.7, 1.1, 0, 0, 0);
  slab(1.2, 0.55, 0.9, 0.85, 0.12, 0.15);
  slab(1.0, 0.5, 0.8, -0.75, 0.08, -0.1);
  slab(0.8, 0.42, 0.7, 0.2, 0.28, -0.05, cloudShade);
  var dist = 220;
  var ce = Math.cos(el), se = Math.sin(el);
  g.position.set(Math.sin(az)*ce*dist, se*dist, -Math.cos(az)*ce*dist);
  g.scale.setScalar(scale);
  g.frustumCulled = false;
  skyRoot.add(g);
}
addCloud(-0.22, 0.14, 12);
addCloud(0.38, 0.16, 10);
addCloud(-0.55, 0.12, 13);
addCloud(0.7, 0.15, 11);
addCloud(0.05, 0.18, 8);
addCloud(-0.95, 0.13, 11);

// nearby toy contact shadows
var contactCanvas=document.createElement("canvas");
contactCanvas.width=64; contactCanvas.height=64;
var contactCtx=contactCanvas.getContext("2d");
var contactGradient=contactCtx.createRadialGradient(32,32,2,32,32,32);
contactGradient.addColorStop(0,"rgba(62,65,47,.27)");
contactGradient.addColorStop(0.45,"rgba(62,65,47,.17)");
contactGradient.addColorStop(1,"rgba(62,65,47,0)");
contactCtx.fillStyle=contactGradient; contactCtx.fillRect(0,0,64,64);
var CONTACT_CAP = 256;
var contactMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),
  new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(contactCanvas),transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1}),CONTACT_CAP);
contactMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
contactMesh.frustumCulled = false;
contactMesh.count = 0;
scene.add(contactMesh);
var contactDummy = new THREE.Object3D();
var contactCandidates = [];
var contactX = Infinity, contactZ = Infinity, contactProps = -1;
var contactBuilds = 0;
function updateContacts(){
  var dx = katamari.position.x - contactX, dz = katamari.position.z - contactZ;
  if (props.length === contactProps && dx*dx + dz*dz < 1) return;
  contactX = katamari.position.x; contactZ = katamari.position.z;
  contactProps = props.length;
  contactCandidates.length = 0;
  for (var i=0;i<props.length;i++){
    var obj = props[i];
    dx = obj.position.x - contactX; dz = obj.position.z - contactZ;
    var distance = dx*dx + dz*dz;
    if (obj.visible && obj.userData.size && distance < 2500){
      obj.userData.contactDistance = distance;
      contactCandidates.push(obj);
    }
  }
  contactCandidates.sort(function(a,b){ return a.userData.contactDistance - b.userData.contactDistance; });
  var n = Math.min(CONTACT_CAP, contactCandidates.length);
  for (var j=0;j<n;j++){
    var p = contactCandidates[j], size = p.userData.size;
    contactDummy.position.set(p.position.x,0.018,p.position.z);
    contactDummy.rotation.set(-Math.PI/2,0,0);
    contactDummy.scale.set(size*1.25,size*1.25,1);
    contactDummy.updateMatrix();
    contactMesh.setMatrixAt(j,contactDummy.matrix);
  }
  contactMesh.count = n;
  contactMesh.instanceMatrix.updateRange.offset = 0;
  contactMesh.instanceMatrix.updateRange.count = n * 16;
  contactMesh.instanceMatrix.needsUpdate = true;
  contactBuilds++;
}

// ---------------------------------------------------------------- the ball
function ballTexture(){
  var c = document.createElement("canvas"); c.width = 256; c.height = 128;
  var g = c.getContext("2d");
  g.fillStyle = "#b5763f"; g.fillRect(0,0,256,128);
  for (var i=0;i<90;i++){
    g.fillStyle = trnd()<0.5 ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.05)";
    g.beginPath();
    g.arc(trnd()*256, trnd()*128, 4+trnd()*10, 0, 6.283);
    g.fill();
  }
  var t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}
var katamari = new THREE.Group();
scene.add(katamari);
var core = new THREE.Mesh(
  new THREE.SphereGeometry(1, 26, 20),
  new THREE.MeshLambertMaterial({map:ballTexture()})
);
core.castShadow = true;
core.receiveShadow = false;
katamari.add(core);

var bakeMat = new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors });
var bakeInv = new THREE.Matrix4();
var bakeXform = new THREE.Matrix4();

function bakeProp(root){
  root.updateMatrixWorld(true);
  bakeInv.copy(root.matrixWorld).invert();
  var geos = [];
  var doomed = [];
  root.traverse(function(o){
    if (!o.isMesh) return;
    doomed.push(o);
    var geo = o.geometry.clone();
    bakeXform.multiplyMatrices(bakeInv, o.matrixWorld);
    geo.applyMatrix4(bakeXform);
    geo.deleteAttribute("uv");
    geo.deleteAttribute("uv2");
    var c = o.material.color;
    var n = geo.attributes.position.count;
    var cols = new Float32Array(n * 3);
    for (var i = 0; i < n; i++){
      cols[i*3] = c.r;
      cols[i*3+1] = c.g;
      cols[i*3+2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    geos.push(geo);
  });
  if (!geos.length) return;
  var merged = BufferGeometryUtils.mergeBufferGeometries(geos, false);
  for (var g = 0; g < geos.length; g++) geos[g].dispose();
  if (!merged) return;
  for (var d = doomed.length - 1; d >= 0; d--) doomed[d].parent.remove(doomed[d]);
  merged.computeBoundingSphere();
  var mesh = new THREE.Mesh(merged, bakeMat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  root.add(mesh);
}

function dumpBaked(obj){
  obj.traverse(function(o){
    if (o.isMesh && o.material === bakeMat && o.geometry) o.geometry.dispose();
  });
}

// ---------------------------------------------------------------- prop kit
var PAL = [0xf27668,0xf4a04f,0xf2cd4f,0x98bd69,0x59bce0,0xb18bd6,0xef91b5,
           0xf4efe2,0x9a6b4f,0x5f6b7a,0x2f9e7a,0xe9573f];
function hue(){ return PAL[(rnd()*PAL.length)|0]; }

var matCache = {};
function mat(color){
  if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({color:color});
  return matCache[color];
}
var geoBox = new THREE.BoxGeometry(1,1,1);
var toyBoxCache = {};
// selected toys get a uniform bevel based on their thinnest dimension
function toyBox(c,w,h,d,x,y,z){
  var unit = Math.min(w,h,d);
  var dims = [w/unit,h/unit,d/unit];
  var key = dims.map(function(v){ return v.toFixed(4); }).join(":");
  var geo = toyBoxCache[key];
  if (!geo){
    geo = new THREE.BoxGeometry(dims[0],dims[1],dims[2],3,3,3);
    var pos = geo.attributes.position, normal = geo.attributes.normal;
    var point = new THREE.Vector3(), center = new THREE.Vector3(), delta = new THREE.Vector3();
    var bevel = 0.12;
    for (var i=0;i<pos.count;i++){
      point.fromBufferAttribute(pos,i);
      for (var axis=0;axis<3;axis++){
        var half = dims[axis]*0.5;
        var value = point.getComponent(axis);
        if (Math.abs(value) < half*0.9) value = Math.sign(value)*(half-bevel);
        point.setComponent(axis,value);
        center.setComponent(axis,Math.max(-half+bevel,Math.min(half-bevel,value)));
      }
      delta.copy(point).sub(center).normalize();
      point.copy(center).addScaledVector(delta,bevel);
      pos.setXYZ(i,point.x,point.y,point.z);
      normal.setXYZ(i,delta.x,delta.y,delta.z);
    }
    toyBoxCache[key] = geo;
  }
  return part(geo,c,unit,unit,unit,x,y,z);
}
var geoCyl = new THREE.CylinderGeometry(0.5,0.5,1,14);
var geoSph = new THREE.SphereGeometry(0.5,12,9);
var geoCon = new THREE.ConeGeometry(0.5,1,14);

function part(geo, color, sx, sy, sz, x, y, z){
  var m = new THREE.Mesh(geo, mat(color));
  m.scale.set(sx,sy,sz);
  m.position.set(x,y,z);
  m.castShadow = false;
  return m;
}
var box = function(c,w,h,d,x,y,z){ return part(geoBox,c,w,h,d,x,y,z); };
var cyl = function(c,r,h,x,y,z){ return part(geoCyl,c,r*2,h,r*2,x,y,z); };
var sph = function(c,r,x,y,z){ return part(geoSph,c,r*2,r*2,r*2,x,y,z); };
var con = function(c,r,h,x,y,z){ return part(geoCon,c,r*2,h,r*2,x,y,z); };
function turn(g, m, rx, ry, rz){
  m.rotation.set(rx||0, ry||0, rz||0);
  g.add(m);
  return m;
}

var HIDE = 0xb5763f, MANE = 0x4a2f1c, DARK = 0x2b2140, SOCK = 0xf7f2e4;
var BRASS = 0xd2a63c, BRONZE = 0x6f7f63, STEEL = 0x9aa3ad;

// ---------------------------------------------------------------- max himself
// The head and tail ride their own rig parented to the scene, NOT to the rolling
// group. Anything parented to the ball spends half of each revolution underground.
function buildHead(){
  var g = new THREE.Group();
  turn(g, toyBox(HIDE, 0.30,0.66,0.30,  0, 0.26, 0.00), -0.34,0,0);
  g.add(part(geoSph,HIDE,0.39,0.40,0.52,0,0.62,0.20));
  g.add(part(geoSph,0xcc996b,0.35,0.29,0.38,0,0.51,0.47));
  g.add(toyBox(SOCK, 0.10,0.34,0.03,    0, 0.60, 0.62));
  g.add(sph(DARK, 0.035, -0.07, 0.44, 0.61));
  g.add(sph(DARK, 0.035,  0.07, 0.44, 0.61));
  g.add(sph(DARK, 0.052, -0.165, 0.68, 0.33));
  g.add(sph(DARK, 0.052,  0.165, 0.68, 0.33));
  g.add(con(HIDE, 0.062, 0.19, -0.125, 0.86, 0.04));
  g.add(con(HIDE, 0.062, 0.19,  0.125, 0.86, 0.04));
  g.add(toyBox(MANE, 0.13,0.32,0.30,    0, 0.66, -0.04));
  g.add(toyBox(MANE, 0.15,0.24,0.16,    0, 0.38, -0.16));
  g.add(sph(SOCK,0.015,-0.194,0.697,0.348));
  g.add(sph(SOCK,0.015,0.194,0.697,0.348));
  g.traverse(function(o){ if(o.isMesh) o.castShadow=true; });
  return g;
}
// sculpted locks: tapered rings following a curved centerline
function tailLock(side, length, color){
  var curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0,0,0),
    new THREE.Vector3(side*0.25,0.015,-0.15),
    new THREE.Vector3(side*0.70,-0.09,-0.34),
    new THREE.Vector3(side,-0.28,-0.50),
    new THREE.Vector3(side*0.85,-0.49,-0.59)
  ]);
  var rings = 10, sides = 8;
  var frames = curve.computeFrenetFrames(rings,false);
  var positions = [], indices = [];
  var widths = [0.065,0.105,0.100,0.060,0.008];
  for (var i=0;i<=rings;i++){
    var t = i/rings, point = curve.getPointAt(t);
    var section = Math.min(3,Math.floor(t*4));
    var blend = t*4-section;
    blend = blend*blend*(3-2*blend);
    var width = widths[section]*(1-blend)+widths[section+1]*blend;
    for (var j=0;j<sides;j++){
      var angle = j/sides*Math.PI*2;
      var vertex = point.clone().addScaledVector(frames.normals[i],Math.cos(angle)*width)
        .addScaledVector(frames.binormals[i],Math.sin(angle)*width*0.8);
      positions.push(vertex.x,vertex.y*length,vertex.z*length);
      if (i<rings){
        var a = i*sides+j, b = i*sides+(j+1)%sides;
        indices.push(a,b,a+sides,b,b+sides,a+sides);
      }
    }
  }
  // cap both ends so the tuft stays solid from every angle
  var start = positions.length/3;
  positions.push(0,0,0);
  var end = curve.getPointAt(1);
  positions.push(end.x,end.y*length,end.z*length);
  for (var k=0;k<sides;k++){
    var next = (k+1)%sides;
    indices.push(start,next,k);
    indices.push(start+1,rings*sides+k,rings*sides+next);
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  var lock = new THREE.Mesh(geo,mat(color));
  lock.castShadow = true;
  return lock;
}
function buildTail(){
  var g = new THREE.Group();
  var dock = part(geoSph,MANE,0.15,0.17,0.25,0,0.025,0.035);
  dock.castShadow = true;
  g.add(dock);
  var hair = new THREE.Group();
  hair.position.set(0,0.02,-0.04);
  hair.add(tailLock(-0.080,0.88,0x49301f));
  hair.add(tailLock(0.080,0.94,0x543722));
  hair.add(tailLock(0,1.08,MANE));
  g.add(hair);
  g.userData.hair = hair;
  return g;
}

var rig     = new THREE.Group(); scene.add(rig);
var headGrp = buildHead(); rig.add(headGrp);
var tailGrp = buildTail(); rig.add(tailGrp);

var rigYaw = 0, bobT = 0, tailSpring = 0, tailVel = 0;
var tailPitch = 0, tailPitchVel = 0, hairLag = 0, hairVel = 0;
function angLerp(a,b,t){
  var d = ((b - a + Math.PI*3) % (Math.PI*2)) - Math.PI;
  return a + d*t;
}
function updateRig(dt){
  bobT += dt;
  var hs = HEAD_K * Math.pow(radius, HEAD_POW);
  var sp = Math.sqrt(vel.x*vel.x + vel.z*vel.z);
  var targetYaw = sp > 0.35 ? Math.atan2(vel.x, vel.z) : rigYaw;

  rig.position.copy(katamari.position);
  if (sp > 0.35) rigYaw = angLerp(rigYaw, targetYaw, 1 - Math.pow(0.0015, dt));
  rig.rotation.y = rigYaw;

  var gait = Math.min(1, sp / 5);
  var bob  = Math.sin(bobT*9) * 0.06 * gait;
  var stream = Math.min(1, sp / 7.5);
  var turnErr = sp > 0.35 ? ((rigYaw - targetYaw + Math.PI*3) % (Math.PI*2)) - Math.PI : 0;
  var swish = Math.sin(bobT*9 + 0.7) * gait;

  headGrp.scale.setScalar(hs);
  headGrp.position.set(0, radius*0.30 + bob*radius*0.2, radius*1.05);
  headGrp.rotation.set(bob, 0, 0);

  var wantPitch = 0.16*(1 - stream) - 0.22*stream + bob*0.28;
  var wantYaw   = -turnErr*1.55 + swish*0.34;
  var wantRoll  = swish*0.12;
  if (dt > 0){
    tailVel += (wantYaw - tailSpring) * 16 * dt;
    tailVel *= Math.pow(0.86, dt * 60);
    tailSpring += tailVel * dt;
    tailPitchVel += (wantPitch - tailPitch) * 11 * dt;
    tailPitchVel *= Math.pow(0.84, dt * 60);
    tailPitch += tailPitchVel * dt;
  } else {
    tailSpring = wantYaw;
    tailPitch = wantPitch;
  }
  if (tailSpring > 0.95) tailSpring = 0.95;
  if (tailSpring < -0.95) tailSpring = -0.95;

  tailGrp.scale.setScalar(hs*0.95);
  tailGrp.position.set(0, radius*0.55, -radius*0.82);
  tailGrp.rotation.set(tailPitch, tailSpring, wantRoll);

  var hair = tailGrp.userData.hair;
  var wantHair = -turnErr*0.85 + Math.sin(bobT*9 + 1.5)*0.42*gait;
  if (dt > 0){
    hairVel += (wantHair - hairLag) * 8 * dt;
    hairVel *= Math.pow(0.80, dt * 60);
    hairLag += hairVel * dt;
  } else {
    hairLag = wantHair;
  }
  hair.rotation.set(0.12*(1 - stream), hairLag, swish*0.08);
  for (var lockIndex=0;lockIndex<hair.children.length;lockIndex++){
    var lock = hair.children[lockIndex];
    var lag = lockIndex*0.7;
    lock.rotation.x = -gulpPunch*(1.1+lockIndex*0.3);
    lock.rotation.y = Math.sin(bobT*2.2-lag)*(0.018+gait*0.025) + hairLag*0.08*lockIndex;
    lock.rotation.z = Math.sin(bobT*2.2-lag)*0.012;
  }
}

// ---------------------------------------------------------------- a horse, generally
// Eight of the recipes below are horses of one kind or another, so they share a
// builder. legK stretches the legs, which is the whole of the high-horse joke.
function quadruped(s, hide, mane, legK){
  var g = new THREE.Group();
  var leg = s*0.34*(legK || 1);
  var y   = leg + s*0.16;
  g.add(box(hide, s*0.60, s*0.30, s*0.26,  0,        y,         0));       // barrel
  g.add(box(hide, s*0.22, s*0.31, s*0.27, -s*0.26,   y+s*0.03,  0));       // rump
  turn(g, box(hide, s*0.13, s*0.36, s*0.20, s*0.29,  y+s*0.17,  0), 0,0,-0.42); // neck
  g.add(toyBox(hide, s*0.21, s*0.13, s*0.14,  s*0.43,   y+s*0.31,  0));       // head
  g.add(toyBox(hide, s*0.10, s*0.10, s*0.11,  s*0.51,   y+s*0.27,  0));       // muzzle
  g.add(sph(DARK, s*0.018, s*0.50, y+s*0.34, -s*0.055));
  g.add(sph(DARK, s*0.018, s*0.50, y+s*0.34,  s*0.055));
  g.add(con(hide, s*0.026, s*0.08, s*0.36, y+s*0.41, -s*0.04));
  g.add(con(hide, s*0.026, s*0.08, s*0.36, y+s*0.41,  s*0.04));            // ears
  g.add(box(mane, s*0.05, s*0.28, s*0.14,  s*0.32,   y+s*0.26, 0));        // mane
  turn(g, con(mane, s*0.05, s*0.28, -s*0.38, y-s*0.01, 0), 0,0,-2.5);      // tail
  var lp = [[s*0.20, s*0.09],[s*0.20,-s*0.09],[-s*0.20, s*0.09],[-s*0.20,-s*0.09]];
  for (var i=0;i<4;i++){
    g.add(box(hide, s*0.06, leg, s*0.06, lp[i][0], leg*0.5, lp[i][1]));
    g.add(box(DARK, s*0.07, s*0.035, s*0.075, lp[i][0], s*0.018, lp[i][1]));
  }
  return g;
}
function rider(g, s, y, coat, hat){
  g.add(box(coat, s*0.14, s*0.22, s*0.16, s*0.02, y+s*0.11, 0));
  g.add(sph(0xe8b98d, s*0.07, s*0.05, y+s*0.28, 0));
  g.add(cyl(hat, s*0.10, s*0.09, s*0.05, y+s*0.36, 0));
}

// ---------------------------------------------------------------- recipes
// hp is added to Max's horsepower on pickup. A horse is one horsepower. That is
// not a joke about the game, it is what the unit means.
var KIT = [
  // ---- pocket-sized
  {name:"horsefly", size:[0.10,0.15], w:8, zone:[0,26], make:function(s){
    var g=new THREE.Group();
    g.add(sph(0x33383f, s*0.4, 0, s*0.5, 0));
    g.add(sph(0x6f5a3a, s*0.28, s*0.34, s*0.54, 0));
    g.add(sph(0xe9573f, s*0.09, s*0.48, s*0.60,  s*0.12));
    g.add(sph(0xe9573f, s*0.09, s*0.48, s*0.60, -s*0.12));
    turn(g, box(0xdfeef7, s*0.7, s*0.03, s*0.26, -s*0.1, s*0.72,  s*0.22), 0,0,0.2);
    turn(g, box(0xdfeef7, s*0.7, s*0.03, s*0.26, -s*0.1, s*0.72, -s*0.22), 0,0,0.2);
    return g;}},
  {name:"thumbtack", size:[0.14,0.2], w:6, zone:[0,26], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0xd94f4f, s*0.48, s*0.10, 0, s*0.20, 0));
    g.add(cyl(0xf2c9c9, s*0.28, s*0.05, 0, s*0.26, 0));
    g.add(cyl(STEEL, s*0.06, s*0.36, 0, 0, 0));
    g.add(con(STEEL, s*0.06, s*0.14, 0, -s*0.24, 0));
    return g;}},
  {name:"sugar cube", size:[0.16,0.22], w:11, zone:[0,26], make:function(s){
    var g=new THREE.Group();
    g.add(box(0xfdf9ef, s, s, s, 0, s*0.5, 0));
    g.add(box(0xe4dcc8, s*1.02, s*0.06, s*1.02, 0, s*0.5, 0));
    g.add(box(0xe4dcc8, s*0.06, s*1.02, s*1.02, 0, s*0.5, 0));
    return g;}},
  {name:"coin", size:[0.18,0.26], w:7, zone:[0,26], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0xe0a82e, s*0.5, s*0.10, 0, s*0.05, 0));
    g.add(cyl(0xffd23f, s*0.36, s*0.12, 0, s*0.06, 0));
    g.add(box(0xe0a82e, s*0.18, s*0.03, s*0.07, 0, s*0.13, 0));
    g.add(box(0xe0a82e, s*0.07, s*0.03, s*0.18, 0, s*0.13, 0));
    return g;}},
  {name:"horse chestnut", size:[0.18,0.26], w:8, zone:[0,28], make:function(s){
    var g=new THREE.Group();
    g.add(sph(0x6b3f24, s*0.42, 0, s*0.38, 0));
    g.add(sph(0x8fbf58, s*0.46, 0, s*0.30, 0));
    for (var i=0;i<7;i++){
      var a=i*0.9;
      g.add(con(0x8fbf58, s*0.05, s*0.16, Math.cos(a)*s*0.34, s*0.16, Math.sin(a)*s*0.34));
    }
    return g;}},
  {name:"candy", size:[0.2,0.3], w:6, zone:[0,26], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s*0.55, s*0.5, s*0.5, 0, s*0.25, 0));
    g.add(box(0xf7f2e4, s*0.58, s*0.14, s*0.52, 0, s*0.25, 0));
    g.add(con(0xf7f2e4, s*0.2, s*0.32, s*0.44, s*0.25, 0));
    turn(g, con(0xf7f2e4, s*0.2, s*0.32, -s*0.44, s*0.25, 0), 0, 0, Math.PI);
    return g;}},
  {name:"die", size:[0.24,0.32], w:5, zone:[0,28], make:function(s){
    var g=new THREE.Group();
    var p=s*0.09, o=s*0.22;
    g.add(box(0xf7f2e4, s, s, s, 0, s*0.5, 0));
    g.add(box(DARK, p, p, s*0.05, 0, s*0.5, s*0.51));
    g.add(box(DARK, s*0.05, p, p, s*0.51, s*0.5+o, o));
    g.add(box(DARK, s*0.05, p, p, s*0.51, s*0.5-o, -o));
    g.add(box(DARK, p, s*0.05, p, -o, s*1.02, -o));
    g.add(box(DARK, p, s*0.05, p, 0, s*1.02, 0));
    g.add(box(DARK, p, s*0.05, p, o, s*1.02, o));
    return g;}},
  {name:"horseshoe", size:[0.26,0.36], w:9, zone:[0,30], make:function(s){
    var g=new THREE.Group();
    for (var i=0;i<7;i++){
      var a = -0.5 + (i/6)*4.1;
      g.add(box(STEEL, s*0.16, s*0.1, s*0.16, Math.cos(a)*s*0.38, s*0.05, Math.sin(a)*s*0.38));
      if (i%2===0) g.add(box(DARK, s*0.05, s*0.04, s*0.05, Math.cos(a)*s*0.38, s*0.11, Math.sin(a)*s*0.38));
    }
    return g;}},
  {name:"eraser", size:[0.28,0.4], w:5, zone:[0,28], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s, s*0.35, s*0.45, 0, s*0.17, 0));
    g.add(box(0xf4efe2, s*0.40, s*0.38, s*0.48, 0, s*0.17, 0));
    g.add(box(0xe9573f, s*0.18, s*0.04, s*0.50, 0, s*0.17, 0));
    return g;}},
  {name:"seahorse", size:[0.3,0.44], w:5, zone:[0,40], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x3fb8c4, s*0.30, s*0.06, 0, s*0.03, 0));
    for (var i=0;i<5;i++){
      var a = i*0.42;
      g.add(box(0xf2a341, s*0.13, s*0.13, s*0.10,
                Math.sin(a)*s*0.14, s*0.22+i*s*0.12, 0));
    }
    g.add(box(0xf2a341, s*0.16, s*0.11, s*0.10, s*0.10, s*0.84, 0));
    g.add(box(0xf2a341, s*0.14, s*0.06, s*0.07, s*0.22, s*0.80, 0));
    g.add(con(0xf2a341, s*0.05, s*0.12, -s*0.04, s*0.94, 0));
    return g;}},
  {name:"horseradish", size:[0.32,0.46], w:7, zone:[0,40], make:function(s){
    var g=new THREE.Group();
    g.add(sph(0xf0e6cf, s*0.24, 0, s*0.20, 0));
    g.add(sph(0xe8dcbe, s*0.18, s*0.04, s*0.38, 0));
    turn(g, con(0xe0d3b0, s*0.13, s*0.34, -s*0.03, s*0.50, 0), 0,0,Math.PI);
    for (var i=0;i<3;i++)
      turn(g, box(0x5aa04a, s*0.09, s*0.34, s*0.05, (i-1)*s*0.09, s*0.66, 0), 0,0,(i-1)*0.4);
    return g;}},
  {name:"knight", size:[0.34,0.48], w:6, zone:[0,36], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0xf4efe2, s*0.28, s*0.10, 0, s*0.05, 0));
    g.add(cyl(0xf4efe2, s*0.20, s*0.14, 0, s*0.16, 0));
    g.add(cyl(0xf4efe2, s*0.12, s*0.26, 0, s*0.35, 0));
    turn(g, box(0xf4efe2, s*0.16, s*0.30, s*0.20, s*0.03, s*0.60, 0), -0.30,0,0);
    g.add(box(0xf4efe2, s*0.14, s*0.13, s*0.15, s*0.12, s*0.72, 0));
    g.add(con(0xf4efe2, s*0.05, s*0.14, -s*0.06, s*0.80, 0));
    return g;}},
  {name:"horsehair brush", size:[0.36,0.5], w:6, zone:[0,42], make:function(s){
    var g=new THREE.Group();
    g.add(toyBox(0x9a6b4f, s*0.9, s*0.16, s*0.30, 0, s*0.32, 0));
    g.add(box(BRASS, s*0.88, s*0.06, s*0.34, 0, s*0.21, 0));
    g.add(box(0x3a2a1a, s*0.84, s*0.18, s*0.32, 0, s*0.09, 0));
    g.add(box(0x2a1c12, s*0.12, s*0.16, s*0.34, -s*0.18, s*0.09, 0));
    g.add(box(0x2a1c12, s*0.12, s*0.16, s*0.34,  s*0.18, s*0.09, 0));
    g.add(sph(DARK, s*0.055, -s*0.34, s*0.32, 0));
    return g;}},
  {name:"pencil", size:[0.4,0.6], w:5, zone:[0,30], make:function(s){
    var g=new THREE.Group();
    turn(g, cyl(0xffd23f, s*0.07, s*0.70, 0, s*0.07, 0), 0, 0, Math.PI/2);
    turn(g, con(0xf1c8a0, s*0.07, s*0.16, s*0.42, s*0.07, 0), 0, 0, -Math.PI/2);
    turn(g, con(DARK, s*0.028, s*0.08, s*0.52, s*0.07, 0), 0, 0, -Math.PI/2);
    turn(g, cyl(STEEL, s*0.075, s*0.10, -s*0.40, s*0.07, 0), 0, 0, Math.PI/2);
    turn(g, cyl(0xff8fc0, s*0.07, s*0.14, -s*0.50, s*0.07, 0), 0, 0, Math.PI/2);
    return g;}},

  // ---- yard
  {name:"carrot", size:[0.3,0.45], w:9, zone:[0,44], make:function(s){
    var g=new THREE.Group();
    turn(g, con(0xf08a3c, s*0.15, s*0.9, 0, s*0.16, 0), 0, 0, -2.0);
    for (var i=0;i<3;i++)
      g.add(box(0x4fa34a, s*0.06, s*0.26, s*0.06, s*0.34+i*s*0.06, s*0.34, (i-1)*s*0.07));
    return g;}},
  {name:"apple", size:[0.35,0.5], w:8, zone:[0,46], make:function(s){
    var g=new THREE.Group();
    g.add(sph(0xe9573f, s*0.45, 0, s*0.45, 0));
    g.add(sph(0xf27a5c, s*0.16, s*0.18, s*0.58, s*0.18));
    g.add(cyl(0x6b4a2f, s*0.035, s*0.20, 0, s*0.90, 0));
    turn(g, box(0x4fa34a, s*0.22, s*0.04, s*0.12, s*0.12, s*0.94, 0), 0, 0, 0.45);
    return g;}},
  {name:"mug", size:[0.4,0.55], w:5, zone:[0,46], make:function(s,c){
    var g=new THREE.Group();
    g.add(cyl(c, s*0.4, s*0.70, 0, s*0.35, 0));
    g.add(cyl(0x3a2418, s*0.32, s*0.08, 0, s*0.68, 0));
    g.add(box(c, s*0.08, s*0.08, s*0.10, s*0.44, s*0.58, 0));
    g.add(box(c, s*0.08, s*0.08, s*0.10, s*0.44, s*0.22, 0));
    g.add(box(c, s*0.08, s*0.44, s*0.10, s*0.52, s*0.40, 0));
    return g;}},
  {name:"soda can", size:[0.4,0.55], w:5, zone:[0,48], make:function(s,c){
    var g=new THREE.Group();
    g.add(cyl(c, s*0.32, s*0.86, 0, s*0.49, 0));
    g.add(cyl(STEEL, s*0.33, s*0.08, 0, s*0.94, 0));
    g.add(cyl(STEEL, s*0.33, s*0.06, 0, s*0.04, 0));
    g.add(cyl(0xf7f2e4, s*0.335, s*0.22, 0, s*0.50, 0));
    g.add(cyl(DARK, s*0.338, s*0.04, 0, s*0.50, 0));
    g.add(box(STEEL, s*0.10, s*0.03, s*0.06, s*0.05, s*1.00, 0));
    return g;}},
  {name:"book", size:[0.5,0.8], w:5, zone:[0,48], make:function(s,c){
    var g=new THREE.Group();
    g.add(toyBox(c, s, s*0.22, s*0.75, 0, s*0.11, 0));
    g.add(box(0xf7f2e4, s*0.88, s*0.16, s*0.68, s*0.05, s*0.11, 0));
    g.add(box(c, s*0.10, s*0.24, s*0.76, -s*0.46, s*0.12, 0));
    g.add(box(BRASS, s*0.46, s*0.03, s*0.08, s*0.06, s*0.23, 0));
    return g;}},
  {name:"rubber duck", size:[0.4,0.6], w:4, zone:[0,50], make:function(s){
    var g=new THREE.Group();
    g.add(sph(0xffd23f, s*0.45, 0, s*0.42, 0));
    g.add(sph(0xffd23f, s*0.26, 0, s*0.85, s*0.2));
    turn(g, con(0xff8c1a, s*0.1, s*0.22, 0, s*0.85, s*0.44), Math.PI/2, 0, 0);
    g.add(sph(0xf7f2e4, s*0.055, -s*0.09, s*0.92, s*0.38));
    g.add(sph(0xf7f2e4, s*0.055,  s*0.09, s*0.92, s*0.38));
    g.add(sph(DARK, s*0.028, -s*0.09, s*0.93, s*0.42));
    g.add(sph(DARK, s*0.028,  s*0.09, s*0.93, s*0.42));
    g.add(box(0xffc020, s*0.18, s*0.08, s*0.22, s*0.32, s*0.46, 0));
    return g;}},
  {name:"feed bucket", size:[0.55,0.8], w:7, zone:[0,52], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x4a7ec4, s*0.4, s*0.7, 0, s*0.35, 0));
    g.add(cyl(0x2f5a95, s*0.43, s*0.09, 0, s*0.72, 0));
    g.add(sph(0xc9a227, s*0.3, 0, s*0.7, 0));
    turn(g, box(STEEL, s*0.05, s*0.32, s*0.05, s*0.40, s*0.88, 0), 0,0,-0.55);
    turn(g, box(STEEL, s*0.05, s*0.32, s*0.05, -s*0.40, s*0.88, 0), 0,0,0.55);
    g.add(box(STEEL, s*0.62, s*0.05, s*0.05, 0, s*1.04, 0));
    return g;}},
  {name:"potted plant", size:[0.8,1.3], w:6, zone:[0,56], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0xc06a44, s*0.28, s*0.4, 0, s*0.2, 0));
    g.add(cyl(0xa85a38, s*0.32, s*0.06, 0, s*0.40, 0));
    g.add(cyl(0x5c4030, s*0.24, s*0.04, 0, s*0.36, 0));
    for (var i=0;i<4;i++){
      var a = i*1.57 + rnd();
      g.add(sph(0x4fa34a, s*0.22, Math.cos(a)*s*0.18, s*0.5+rnd()*s*0.3, Math.sin(a)*s*0.18));
    }
    return g;}},
  {name:"hobby horse", size:[0.9,1.4], w:6, zone:[0,58], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x9a6b4f, s*0.04, s*0.92, 0, s*0.46, 0));
    g.add(cyl(0xf7f2e4, s*0.048, s*0.10, 0, s*0.28, 0));
    g.add(cyl(0xe9573f, s*0.048, s*0.10, 0, s*0.50, 0));
    g.add(box(0x9a6b4f, s*0.18, s*0.03, s*0.03, 0, s*0.10, 0));
    var h = buildHead();
    h.scale.setScalar(s*0.52);
    h.position.set(0, s*0.62, 0);
    h.rotation.y = Math.PI/2;
    g.add(h);
    return g;}},

  // ---- room-sized
  {name:"traffic cone", size:[1.0,1.5], w:6, zone:[4,80], make:function(s){
    var g=new THREE.Group();
    g.add(box(0x3f4a57, s*0.74, s*0.08, s*0.74, 0, s*0.04, 0));
    g.add(box(0xe9573f, s*0.7, s*0.08, s*0.7, 0, s*0.10, 0));
    g.add(con(0xe9573f, s*0.3, s*0.95, 0, s*0.56, 0));
    g.add(cyl(0xf7f2e4, s*0.22, s*0.10, 0, s*0.48, 0));
    g.add(cyl(0xf7f2e4, s*0.14, s*0.08, 0, s*0.74, 0));
    return g;}},
  {name:"sawhorse", size:[1.2,1.8], w:7, zone:[4,80], make:function(s){
    var g=new THREE.Group();
    g.add(box(0xa67c45, s*0.9, s*0.09, s*0.12, 0, s*0.6, 0));
    var p=[[-1,-1],[1,-1],[-1,1],[1,1]];
    for (var i=0;i<4;i++)
      turn(g, box(0xc79a5e, s*0.07, s*0.66, s*0.07, p[i][0]*s*0.32, s*0.30, p[i][1]*s*0.14),
           p[i][1]*0.25, 0, -p[i][0]*0.18);
    g.add(box(STEEL, s*0.12, s*0.04, s*0.16, -s*0.28, s*0.66, 0));
    g.add(box(STEEL, s*0.12, s*0.04, s*0.16,  s*0.28, s*0.66, 0));
    return g;}},
  {name:"lawnmower", size:[1.3,1.9], w:6, hp:5, zone:[4,80], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s*0.7, s*0.22, s*0.52, 0, s*0.24, 0));
    g.add(box(0x33383f, s*0.26, s*0.20, s*0.30, s*0.06, s*0.44, 0));
    g.add(box(0x3a2a1a, s*0.20, s*0.28, s*0.48, s*0.42, s*0.28, 0));
    turn(g, box(STEEL, s*0.05, s*0.62, s*0.05, -s*0.38, s*0.50, 0), 0,0,0.55);
    g.add(box(STEEL, s*0.05, s*0.05, s*0.34, -s*0.66, s*0.76, 0));
    var p=[[-1,-1],[1,-1],[-1,1],[1,1]];
    for (var i=0;i<4;i++)
      turn(g, cyl(DARK, s*0.11, s*0.06, p[i][0]*s*0.28, s*0.11, p[i][1]*s*0.24), Math.PI/2,0,0);
    return g;}},
  {name:"chair", size:[1.3,2.0], w:6, zone:[4,80], make:function(s,c){
    var g=new THREE.Group(), t=s*0.07;
    g.add(box(c, s*0.6, t*1.4, s*0.6, 0, s*0.5, 0));
    g.add(box(0xf4efe2, s*0.50, t*1.6, s*0.50, 0, s*0.52, 0));
    g.add(box(c, s*0.6, s*0.55, t*1.4, 0, s*0.78, -s*0.27));
    g.add(box(0xf7f2e4, s*0.48, s*0.07, t*1.6, 0, s*0.96, -s*0.27));
    var p=[[-1,-1],[1,-1],[-1,1],[1,1]];
    for (var i=0;i<4;i++) g.add(box(c, t, s*0.5, t, p[i][0]*s*0.25, s*0.25, p[i][1]*s*0.25));
    return g;}},
  {name:"rocking horse", size:[1.3,1.9], w:6, zone:[4,80], make:function(s){
    var g=new THREE.Group();
    var q = quadruped(s*0.95, 0xf0e2c8, 0xc0503f, 0.55);
    q.position.y = s*0.16;
    g.add(q);
    for (var k=-1;k<=1;k+=2){
      for (var i=0;i<4;i++){
        var t=(i/3-0.5)*1.7;
        g.add(box(0xc79a5e, s*0.28, s*0.07, s*0.07, t*s*0.5, s*0.03+t*t*s*0.12, k*s*0.14));
      }
    }
    return g;}},
  {name:"trash can", size:[1.2,1.8], w:5, zone:[4,82], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x5f6b7a, s*0.34, s*0.9, 0, s*0.45, 0));
    g.add(cyl(STEEL, s*0.36, s*0.05, 0, s*0.22, 0));
    g.add(cyl(STEEL, s*0.36, s*0.05, 0, s*0.58, 0));
    g.add(cyl(0x3f4a57, s*0.38, s*0.10, 0, s*0.92, 0));
    g.add(box(STEEL, s*0.16, s*0.05, s*0.08, 0, s*1.00, 0));
    return g;}},
  {name:"hay bale", size:[1.4,2.1], w:8, zone:[6,84], make:function(s){
    var g=new THREE.Group();
    turn(g, cyl(0xd9b45a, s*0.42, s*0.9, 0, s*0.42, 0), 0, 0, Math.PI/2);
    turn(g, cyl(0xc39c3f, s*0.43, s*0.06, -s*0.44, s*0.42, 0), 0, 0, Math.PI/2);
    turn(g, cyl(0xc39c3f, s*0.43, s*0.06,  s*0.44, s*0.42, 0), 0, 0, Math.PI/2);
    g.add(box(0x8a6b32, s*0.08, s*0.06, s*0.88, -s*0.16, s*0.84, 0));
    g.add(box(0x8a6b32, s*0.08, s*0.06, s*0.88,  s*0.16, s*0.84, 0));
    return g;}},
  {name:"clotheshorse", size:[1.5,2.1], w:6, zone:[6,82], make:function(s,c){
    var g=new THREE.Group();
    for (var k=-1;k<=1;k+=2)
      for (var j=-1;j<=1;j+=2)
        turn(g, box(0xd8c9a6, s*0.06, s*0.82, s*0.06, j*s*0.34, s*0.40, k*s*0.16),
             k*0.18, 0, 0);
    for (var i=0;i<3;i++)
      for (k=-1;k<=1;k+=2)
        g.add(box(0xd8c9a6, s*0.74, s*0.04, s*0.04, 0, s*0.30+i*s*0.22, k*s*0.20));
    g.add(box(c, s*0.34, s*0.44, s*0.04, -s*0.16, s*0.56, s*0.21));
    g.add(box(0xf7f2e4, s*0.30, s*0.38, s*0.04, s*0.20, s*0.60, -s*0.21));
    return g;}},
  {name:"horse trough", size:[1.7,2.4], w:6, zone:[6,84], make:function(s){
    var g=new THREE.Group();
    g.add(box(0x7d6a52, s, s*0.10, s*0.44, 0, s*0.05, 0));
    for (var k=-1;k<=1;k+=2){
      g.add(box(0x8a7458, s, s*0.34, s*0.05, 0, s*0.24, k*s*0.20));
      g.add(box(0x8a7458, s*0.05, s*0.34, s*0.42, k*s*0.48, s*0.24, 0));
    }
    g.add(box(0x4aa8c9, s*0.92, s*0.02, s*0.36, 0, s*0.32, 0));
    return g;}},
  {name:"mailbox", size:[1.5,2.2], w:4, zone:[8,86], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x6b4a2f, s*0.06, s*0.7, 0, s*0.35, 0));
    g.add(box(0x5c3d24, s*0.16, s*0.08, s*0.16, 0, s*0.04, 0));
    g.add(box(0x2f6fa8, s*0.34, s*0.3, s*0.55, 0, s*0.85, 0));
    turn(g, cyl(0x2f6fa8, s*0.17, s*0.32, 0, s*1.0, 0), 0, 0, Math.PI/2);
    g.add(box(0xe9573f, s*0.04, s*0.16, s*0.08, s*0.20, s*0.92, 0));
    g.add(box(0xf7f2e4, s*0.10, s*0.08, s*0.02, 0, s*0.85, s*0.28));
    return g;}},
  {name:"bicycle", size:[1.8,2.4], w:4, zone:[8,86], make:function(s,c){
    var g=new THREE.Group();
    turn(g, cyl(DARK, s*0.28, s*0.06, -s*0.3, s*0.28, 0), 0, 0, Math.PI/2);
    turn(g, cyl(DARK, s*0.28, s*0.06,  s*0.3, s*0.28, 0), 0, 0, Math.PI/2);
    g.add(box(c, s*0.6, s*0.06, s*0.06, 0, s*0.42, 0));
    g.add(box(c, s*0.06, s*0.3, s*0.06, -s*0.28, s*0.5, 0));
    g.add(box(c, s*0.06, s*0.26, s*0.06,  s*0.26, s*0.50, 0));
    g.add(box(DARK, s*0.16, s*0.05, s*0.10, -s*0.28, s*0.68, 0));
    g.add(box(DARK, s*0.05, s*0.05, s*0.28,  s*0.28, s*0.66, 0));
    return g;}},
  {name:"moped", size:[1.8,2.5], w:5, hp:8, zone:[8,86], make:function(s,c){
    var g=new THREE.Group();
    turn(g, cyl(DARK, s*0.20, s*0.07, -s*0.32, s*0.20, 0), 0, 0, Math.PI/2);
    turn(g, cyl(DARK, s*0.20, s*0.07,  s*0.32, s*0.20, 0), 0, 0, Math.PI/2);
    g.add(box(c, s*0.62, s*0.20, s*0.20, 0, s*0.34, 0));
    g.add(box(0x33383f, s*0.24, s*0.13, s*0.22, -s*0.12, s*0.50, 0));
    turn(g, box(c, s*0.10, s*0.42, s*0.16, s*0.30, s*0.48, 0), 0,0,-0.25);
    g.add(box(DARK, s*0.05, s*0.05, s*0.40, s*0.36, s*0.66, 0));
    g.add(sph(0xffe9a8, s*0.06, s*0.42, s*0.40, 0));
    g.add(box(0xe9573f, s*0.04, s*0.04, s*0.08, -s*0.34, s*0.38, 0));
    return g;}},
  {name:"park bench", size:[2.2,3.2], w:5, zone:[10,90], make:function(s){
    var g=new THREE.Group();
    for (var i=0;i<3;i++)
      g.add(box(0x9a6b4f, s, s*0.04, s*0.08, 0, s*0.24, (i-1)*s*0.10));
    g.add(box(0x9a6b4f, s, s*0.10, s*0.06, 0, s*0.52, -s*0.14));
    g.add(box(0x9a6b4f, s, s*0.08, s*0.06, 0, s*0.38, -s*0.14));
    g.add(box(0x5f6b7a, s*0.07, s*0.24, s*0.3, -s*0.42, s*0.12, 0));
    g.add(box(0x5f6b7a, s*0.07, s*0.24, s*0.3,  s*0.42, s*0.12, 0));
    g.add(box(0x5f6b7a, s*0.08, s*0.08, s*0.32, -s*0.42, s*0.28, 0));
    g.add(box(0x5f6b7a, s*0.08, s*0.08, s*0.32,  s*0.42, s*0.28, 0));
    return g;}},
  {name:"carousel horse", size:[2.2,3.0], w:5, zone:[10,90], make:function(s){
    var g=new THREE.Group();
    var q = quadruped(s*0.9, 0xf7f2e4, 0xff8fc0, 1.0);
    q.position.y = s*0.20;
    g.add(q);
    g.add(cyl(BRASS, s*0.035, s*1.5, 0, s*0.75, 0));
    g.add(box(0xffd23f, s*0.30, s*0.08, s*0.30, -s*0.04, s*0.66, 0));
    return g;}},
  {name:"jump fence", size:[2.6,3.6], w:5, zone:[10,92], make:function(s){
    var g=new THREE.Group();
    g.add(box(0xf2ead4, s*0.08, s*0.9, s*0.08, -s*0.45, s*0.45, 0));
    g.add(box(0xf2ead4, s*0.08, s*0.9, s*0.08,  s*0.45, s*0.45, 0));
    g.add(box(0xe4d7ae, s*0.9, s*0.09, s*0.06, 0, s*0.30, 0));
    g.add(box(0xe9573f, s*0.9, s*0.09, s*0.06, 0, s*0.52, 0));
    g.add(box(0xe4d7ae, s*0.9, s*0.09, s*0.06, 0, s*0.74, 0));
    g.add(box(0x4fc4ff, s*0.10, s*0.08, s*0.10, -s*0.45, s*0.94, 0));
    g.add(box(0xe9573f, s*0.10, s*0.08, s*0.10,  s*0.45, s*0.94, 0));
    return g;}},
  {name:"dark horse", size:[2.6,3.6], w:3, hp:1, zone:[6,130], make:function(s){
    var g = quadruped(s, 0x241d2e, 0x120e18, 1.05);
    var y = s*0.34*1.05 + s*0.16;
    g.add(box(0xf7f2e4, s*0.05, s*0.08, s*0.03, s*0.48, y+s*0.34, 0));
    return g;}},

  // ---- street-sized
  {name:"car", size:[3.5,5.0], w:7, hp:120, zone:[16,130], make:function(s,c){
    var g=new THREE.Group();
    g.add(toyBox(c, s, s*0.22, s*0.42, 0, s*0.22, 0));
    g.add(toyBox(c, s*0.5, s*0.2, s*0.38, -s*0.04, s*0.42, 0));
    g.add(box(0x7ec8e8, s*0.36, s*0.14, s*0.40, -s*0.04, s*0.44, 0));
    g.add(box(STEEL, s*0.08, s*0.06, s*0.10, s*0.48, s*0.24,  s*0.16));
    g.add(box(STEEL, s*0.08, s*0.06, s*0.10, s*0.48, s*0.24, -s*0.16));
    g.add(box(0xe9573f, s*0.04, s*0.05, s*0.08, -s*0.50, s*0.24,  s*0.16));
    g.add(box(0xe9573f, s*0.04, s*0.05, s*0.08, -s*0.50, s*0.24, -s*0.16));
    var p=[[-1,-1],[1,-1],[-1,1],[1,1]];
    for (var i=0;i<4;i++)
      turn(g, cyl(DARK, s*0.1, s*0.07, p[i][0]*s*0.33, s*0.1, p[i][1]*s*0.21), Math.PI/2, 0, 0);
    return g;}},
  {name:"police horse", size:[3.5,5.0], w:5, hp:1, zone:[16,130], make:function(s){
    var g = quadruped(s, 0x4a3524, 0x2a1c12, 1.1);
    var y = s*0.34*1.1 + s*0.16;
    g.add(box(0xf7f2e4, s*0.22, s*0.04, s*0.28, 0, y+s*0.16, 0));
    g.add(box(0x2f3f6b, s*0.08, s*0.05, s*0.30, 0, y+s*0.18, 0));
    rider(g, s, s*0.62, 0x2f3f6b, 0x1b2440);
    return g;}},
  {name:"lamppost", size:[4.5,6.5], w:4, zone:[16,130], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x3f4a57, s*0.10, s*0.08, 0, s*0.04, 0));
    g.add(cyl(0x3f4a57, s*0.05, s*0.9, 0, s*0.45, 0));
    g.add(box(0x3f4a57, s*0.22, s*0.04, s*0.05, s*0.12, s*0.92, 0));
    g.add(con(0x3f4a57, s*0.08, s*0.06, s*0.22, s*0.90, 0));
    g.add(sph(0xffe9a8, s*0.10, s*0.22, s*0.82, 0));
    return g;}},
  {name:"tractor", size:[4.5,6.5], w:4, hp:95, zone:[20,130], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s*0.68, s*0.26, s*0.40, s*0.02, s*0.34, 0));
    g.add(box(c, s*0.28, s*0.26, s*0.34, s*0.30, s*0.52, 0));
    g.add(box(0x2b2140, s*0.26, s*0.22, s*0.36, -s*0.16, s*0.58, 0));
    g.add(box(DARK, s*0.04, s*0.16, s*0.28, s*0.36, s*0.34, 0));
    g.add(cyl(0x33383f, s*0.05, s*0.24, s*0.30, s*0.74, 0));
    g.add(sph(0xffe9a8, s*0.05, s*0.40, s*0.40,  s*0.18));
    g.add(sph(0xffe9a8, s*0.05, s*0.40, s*0.40, -s*0.18));
    for (var k=-1;k<=1;k+=2){
      turn(g, cyl(DARK, s*0.28, s*0.12, -s*0.22, s*0.28, k*s*0.24), Math.PI/2,0,0);
      turn(g, cyl(DARK, s*0.15, s*0.10,  s*0.34, s*0.15, k*s*0.22), Math.PI/2,0,0);
    }
    return g;}},
  {name:"tree", size:[5,9], w:8, zone:[14,130], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0x6a4828, s*0.12, s*0.10, 0, s*0.05, 0));
    g.add(cyl(0x7a5636, s*0.08, s*0.52, 0, s*0.26, 0));
    g.add(sph(0x3f8f3f, s*0.32, 0, s*0.64, 0));
    g.add(sph(0x4fa34a, s*0.24, s*0.20, s*0.82, s*0.12));
    g.add(sph(0x35803a, s*0.22, -s*0.18, s*0.76, -s*0.14));
    g.add(sph(0x2e6e32, s*0.18, s*0.06, s*0.90, -s*0.10));
    g.add(sph(0xe9573f, s*0.05, s*0.22, s*0.70, s*0.16));
    return g;}},
  {name:"horse float", size:[5.5,8], w:4, zone:[20,130], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s*0.8, s*0.5, s*0.42, 0, s*0.42, 0));
    g.add(box(0x9fdcf5, s*0.22, s*0.16, s*0.44, s*0.08, s*0.54, 0));
    g.add(box(0x9a6b4f, s*0.06, s*0.42, s*0.36, -s*0.42, s*0.3, 0));
    g.add(box(0x3f4a57, s*0.3, s*0.06, s*0.08, s*0.55, s*0.24, 0));
    g.add(box(0xe9573f, s*0.04, s*0.04, s*0.08, s*0.42, s*0.22, s*0.18));
    for (var k=-1;k<=1;k+=2){
      turn(g, cyl(DARK, s*0.1, s*0.08, -s*0.18, s*0.1, k*s*0.21), Math.PI/2, 0, 0);
      turn(g, cyl(DARK, s*0.1, s*0.08,  s*0.18, s*0.1, k*s*0.21), Math.PI/2, 0, 0);
    }
    return g;}},
  {name:"equestrian statue", size:[6,9], w:4, zone:[26,130], make:function(s){
    var g=new THREE.Group();
    g.add(box(0x8d8577, s*0.72, s*0.22, s*0.44, 0, s*0.11, 0));
    g.add(box(0xa39a89, s*0.62, s*0.10, s*0.36, 0, s*0.27, 0));
    g.add(box(BRASS, s*0.22, s*0.08, s*0.02, 0, s*0.18, s*0.23));
    var q = quadruped(s*0.78, BRONZE, BRONZE, 1.0);
    q.position.y = s*0.32;
    g.add(q);
    rider(g, s*0.78, s*0.32 + s*0.50, BRONZE, BRONZE);
    return g;}},
  {name:"food truck", size:[6,9], w:4, hp:210, zone:[24,130], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s, s*0.45, s*0.42, 0, s*0.35, 0));
    g.add(box(0xf7f2e4, s*0.28, s*0.3, s*0.4, -s*0.42, s*0.28, 0));
    g.add(box(0xe9573f, s*0.36, s*0.06, s*0.46, -s*0.42, s*0.46, 0));
    g.add(box(DARK, s*0.5, s*0.16, s*0.44, s*0.1, s*0.42, 0));
    g.add(box(0xffd23f, s*0.40, s*0.10, s*0.44, s*0.12, s*0.62, 0));
    for (var k=-1;k<=1;k+=2)
      for (var j=-1;j<=1;j+=2)
        turn(g, cyl(DARK, s*0.11, s*0.09, s*0.3*k, s*0.11, j*s*0.21), Math.PI/2, 0, 0);
    return g;}},
  {name:"high horse", size:[7,11], w:3, hp:1, zone:[30,130], make:function(s){
    var g = quadruped(s*0.72, 0xdcc9a8, 0x8a6f45, 3.4);
    var y = s*0.72*0.34*3.4 + s*0.72*0.16;
    g.add(box(0x8a2a1a, s*0.20, s*0.05, s*0.22, 0, y + s*0.72*0.16, 0));
    return g;}},
  {name:"trojan horse", size:[7.5,10], w:5, hp:1, trojan:true, zone:[18,90], make:function(s){
    var g = quadruped(s, 0xc4a574, 0x5c3d24, 1.2);
    var y = s*0.34*1.2 + s*0.16;
    g.add(box(0x5c3d24, s*0.16, s*0.18, s*0.04, 0, y, s*0.14));
    g.add(box(BRASS, s*0.04, s*0.04, s*0.04, s*0.06, y, s*0.16));
    turn(g, cyl(0x6b4a2f, s*0.12, s*0.08,  s*0.22, s*0.08,  s*0.16), Math.PI/2,0,0);
    turn(g, cyl(0x6b4a2f, s*0.12, s*0.08,  s*0.22, s*0.08, -s*0.16), Math.PI/2,0,0);
    turn(g, cyl(0x6b4a2f, s*0.12, s*0.08, -s*0.22, s*0.08,  s*0.16), Math.PI/2,0,0);
    turn(g, cyl(0x6b4a2f, s*0.12, s*0.08, -s*0.22, s*0.08, -s*0.16), Math.PI/2,0,0);
    return g;}},
  {name:"stable", size:[8,13], w:5, zone:[28,130], make:function(s){
    var g=new THREE.Group();
    g.add(box(0xc0503f, s*0.85, s*0.5, s*0.6, 0, s*0.25, 0));
    turn(g, con(0xf2ead4, s*0.6, s*0.34, 0, s*0.66, 0), 0, Math.PI/4, 0);
    g.add(box(0x6b4a2f, s*0.2, s*0.3, s*0.03, -s*0.2, s*0.15, s*0.31));
    g.add(box(0x6b4a2f, s*0.2, s*0.3, s*0.03,  s*0.2, s*0.15, s*0.31));
    g.add(box(0x9fdcf5, s*0.14, s*0.14, s*0.03, 0, s*0.34, s*0.31));
    g.add(box(0x7a3a32, s*0.10, s*0.18, s*0.10, s*0.22, s*0.82, -s*0.08));
    return g;}},
  {name:"house", size:[9,15], w:6, zone:[30,130], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s*0.8, s*0.55, s*0.7, 0, s*0.27, 0));
    turn(g, con(0xc0503f, s*0.62, s*0.4, 0, s*0.74, 0), 0, Math.PI/4, 0);
    g.add(box(0x6b4a2f, s*0.14, s*0.26, s*0.03, 0, s*0.13, s*0.36));
    g.add(box(0x5c3d24, s*0.20, s*0.04, s*0.08, 0, s*0.02, s*0.38));
    g.add(box(0x9fdcf5, s*0.14, s*0.14, s*0.03, -s*0.26, s*0.34, s*0.36));
    g.add(box(0x9fdcf5, s*0.14, s*0.14, s*0.03,  s*0.26, s*0.34, s*0.36));
    g.add(box(0x7a3a32, s*0.12, s*0.22, s*0.12, s*0.22, s*0.84, -s*0.08));
    return g;}},
  {name:"carousel", size:[9,14], w:3, hp:15, zone:[40,130], make:function(s){
    var g=new THREE.Group();
    g.add(cyl(0xf2ead4, s*0.50, s*0.10, 0, s*0.05, 0));
    g.add(cyl(BRASS, s*0.04, s*0.9, 0, s*0.45, 0));
    for (var i=0;i<4;i++){
      var a = i*1.571;
      g.add(cyl(BRASS, s*0.018, s*0.68, Math.cos(a)*s*0.40, s*0.44, Math.sin(a)*s*0.40));
    }
    for (i=0;i<2;i++){
      var b = i*3.14;
      var q = quadruped(s*0.24, 0xf7f2e4, 0xff8fc0, 1.0);
      q.position.set(Math.cos(b)*s*0.34, s*0.16, Math.sin(b)*s*0.34);
      q.rotation.y = -b;
      g.add(q);
    }
    turn(g, con(0xe9573f, s*0.56, s*0.30, 0, s*0.93, 0), 0, 0, 0);
    return g;}},
  {name:"office block", size:[12,20], w:3, zone:[46,130], make:function(s,c){
    var g=new THREE.Group();
    g.add(box(c, s*0.55, s, s*0.55, 0, s*0.5, 0));
    for (var i=0;i<5;i++)
      g.add(box(0x9fdcf5, s*0.5, s*0.07, s*0.56, 0, s*0.16+i*s*0.17, 0));
    g.add(box(DARK, s*0.55, s*0.10, s*0.56, 0, s*0.05, 0));
    g.add(box(0x6b4a2f, s*0.12, s*0.16, s*0.04, 0, s*0.10, s*0.28));
    g.add(cyl(STEEL, s*0.02, s*0.16, s*0.12, s*1.06, 0));
    return g;}}
];

function recipeMid(rec){ return (rec.size[0] + rec.size[1]) * 0.5; }

// static mix for the 3-minute bowl. crumbs/snacks stay near spawn; later bands keep recipe zones.
var BANDS = [
  {lo:0,    hi:0.40, n:280, ring:[0, 40]},
  {lo:0.40, hi:1.20, n:320, ring:[0, 50]},
  {lo:1.20, hi:4.00, n:250, ring:null},
  {lo:4.00, hi:8.00, n:160, ring:null},
  {lo:8.00, hi:99,   n:90,  ring:null}
];

function pickRecipeForBand(lo, hi){
  var pool = [], wt = [], sum = 0, i, rec, mid, r, w;
  for (i=0;i<KIT.length;i++){
    rec = KIT[i];
    mid = recipeMid(rec);
    if (mid >= lo && mid <= hi){ pool.push(rec); wt.push(rec.w); sum += rec.w; }
  }
  if (!pool.length){
    for (i=0;i<KIT.length;i++){
      rec = KIT[i];
      mid = recipeMid(rec);
      w = rec.w / (1 + Math.abs(mid - (lo + hi) * 0.5));
      pool.push(rec); wt.push(w); sum += w;
    }
  }
  r = rnd() * sum;
  for (i=0;i<pool.length;i++){
    r -= wt[i];
    if (r <= 0) return pool[i];
  }
  return pool[0];
}

// ---------------------------------------------------------------- hands
// A hand is four inches. 14.2hh means fourteen hands and two inches, which is
// 14.5 hands decimal. The notation is wrong and everybody uses it anyway.
function handsOf(r){ return r*200/CM_PER_HAND; }
function handsText(h){
  var whole = Math.floor(h);
  var inch  = Math.floor((h - whole) * 4);
  return inch ? whole + "." + inch : "" + whole;
}
function metricText(r){
  var cm = r*200;
  return cm < 100 ? Math.round(cm) + "cm" : (cm/100).toFixed(2) + "m";
}

// thresholds in decimal hands; 14.5 decimal is the famous 14.2hh
var TIERS = [
  [ 8.5,   "miniature",     ""],
  [10.0,   "shetland",      ""],
  [12.5,   "large pony",    ""],
  [14.5,   "a horse",       "14.2hh. Up to here you were a pony. Officially."],
  [16.0,   "hunter",        ""],
  [17.5,   "shire",         ""],
  [21.5,   "record",        "21.2hh. Sampson stood this tall in 1850. No horse has beaten it."],
  [30.0,   "hazard",        ""],
  [45.0,   "landmark",      ""],
  [60.0,   "weather",       ""],
  [120.0,  "unlicensed",    ""],
  [200.0,  "geological",    ""],
  [400.0,  "constellation", "You are visible from other fields entirely."]
];
function tierIndex(h){
  var i = -1;
  while (i+1 < TIERS.length && h >= TIERS[i+1][0]) i++;
  return i;
}
function tierName(i){ return i < 0 ? "foal" : TIERS[i][1]; }

// ---------------------------------------------------------------- world
var props = [];
var attached = [];
var tmpV = new THREE.Vector3();
var tmpQ = new THREE.Quaternion();

function makeGreek(s){
  var g = new THREE.Group();
  g.add(box(0xf2ead4, s*0.22, s*0.42, s*0.16, 0, s*0.32, 0));
  g.add(sph(0xe8b98d, s*0.09, 0, s*0.60, 0));
  g.add(box(0x8a2a1a, s*0.26, s*0.07, s*0.26, 0, s*0.70, 0));
  g.add(box(STEEL, s*0.04, s*0.34, s*0.04, s*0.16, s*0.38, 0));
  return g;
}

function placeProp(g, size, name, hp, extra){
  extra = extra || {};
  g.userData = {size:size, name:name, r:size*0.42, hp:hp || 0, trojan:!!extra.trojan, opened:false};
  bakeProp(g);
  g.updateMatrix();
  g.matrixAutoUpdate = false;
  scene.add(g);
  props.push(g);
  contactProps = -1;
  return g;
}

function spawnOne(rec, band){
  var slo = Math.max(rec.size[0], band.lo);
  var shi = Math.min(rec.size[1], band.hi);
  if (slo > shi){ slo = rec.size[0]; shi = rec.size[1]; }
  var s = slo + rnd()*(shi-slo);
  var g = rec.make(s, hue());
  var ring = band.ring;
  var lo = ring ? ring[0] : rec.zone[0];
  var hi = ring ? ring[1] : rec.zone[1];
  var d = lo + Math.sqrt(rnd())*(hi-lo);
  var a = rnd()*Math.PI*2;
  g.position.set(Math.cos(a)*d, 0, Math.sin(a)*d);
  g.rotation.y = rnd()*Math.PI*2;
  placeProp(g, s, rec.name, rec.hp || 0, rec);
  return rec.trojan;
}

function spawnWorld(count){
  var hadTrojan = false;
  var total = 0, b, i, rec, n, scale;
  for (b=0;b<BANDS.length;b++) total += BANDS[b].n;
  scale = count / total;
  for (b=0;b<BANDS.length;b++){
    n = Math.round(BANDS[b].n * scale);
    for (i=0;i<n;i++){
      rec = pickRecipeForBand(BANDS[b].lo, BANDS[b].hi);
      if (spawnOne(rec, BANDS[b])) hadTrojan = true;
    }
  }
  if (!hadTrojan){
    rec = null;
    for (i=0;i<KIT.length;i++) if (KIT[i].trojan){ rec = KIT[i]; break; }
    if (rec){
      var s = rec.size[0] + rnd()*(rec.size[1]-rec.size[0]);
      var g = rec.make(s, hue());
      var a = rnd()*Math.PI*2;
      g.position.set(Math.cos(a)*36, 0, Math.sin(a)*36);
      g.rotation.y = rnd()*Math.PI*2;
      placeProp(g, s, rec.name, rec.hp || 0, rec);
    }
  }
}

function crackTrojan(p){
  if (p.userData.opened) return;
  p.userData.opened = true;
  var sr = mulberry32(fnv1a(SEED + ":trojan:" + p.position.x.toFixed(2) + "," + p.position.z.toFixed(2)));
  for (var i=0;i<28;i++){
    var ang = sr()*Math.PI*2;
    var d = 1.1 + sr()*2.6;
    var s = 0.18 + sr()*0.10;
    var g = makeGreek(s);
    g.position.set(p.position.x + Math.cos(ang)*d, 0, p.position.z + Math.sin(ang)*d);
    g.rotation.y = sr()*Math.PI*2;
    placeProp(g, s, "greek", 0, {});
  }
  p.scale.setScalar(0.55);
  p.userData.size *= 0.55;
  p.userData.r *= 0.55;
  p.updateMatrix();
  banner("it was full of greeks.", 2800);
}

// ---------------------------------------------------------------- debris / tracers
var debris = [];
var tracers = [];
var hitInvuln = 0;
var enemyTmp = new THREE.Vector3();

function freezeDebrisEntry(d){
  var m = d.mesh;
  d.frozen = true;
  d.vel.set(0, 0, 0);
  var s = (m.userData && m.userData.size) || 0.2;
  var r = (m.userData && m.userData.r) || s * 0.42;
  m.position.y = Math.max(m.position.y, r * 0.5);
  if (!m.userData) m.userData = {};
  m.userData.size = s;
  m.userData.r = r;
  m.userData.name = m.userData.name || "debris";
  m.userData.hp = m.userData.hp || 0;
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  props.push(m);
  contactProps = -1;
}

function spawnDebris(mesh, velImp){
  if (debris.length >= DEBRIS_CAP){
    freezeDebrisEntry(debris[0]);
    debris.shift();
  }
  if (!mesh.userData) mesh.userData = {};
  if (mesh.userData.size == null) mesh.userData.size = 0.2;
  if (mesh.userData.r == null) mesh.userData.r = mesh.userData.size * 0.42;
  mesh.matrixAutoUpdate = true;
  scene.add(mesh);
  debris.push({
    mesh: mesh,
    vel: velImp.clone(),
    spin: new THREE.Vector3((Math.random()-0.5)*8, (Math.random()-0.5)*8, (Math.random()-0.5)*8),
    frozen: false
  });
}

function spawnTracer(from, dir, shedN){
  if (tracers.length >= TRACER_CAP){
    scene.remove(tracers[0].mesh);
    tracers.shift();
  }
  var m = new THREE.Mesh(geoBox, mat(0xff4f4f));
  m.scale.set(0.06, 0.06, 0.22);
  m.position.copy(from);
  m.lookAt(from.x + dir.x, from.y + dir.y, from.z + dir.z);
  m.castShadow = false;
  scene.add(m);
  tracers.push({
    mesh: m,
    vel: dir.clone().multiplyScalar(18 + radius * 2),
    life: 1.2,
    shedN: shedN != null ? shedN : 1
  });
}

function updateDynamics(dt){
  var g = 40 * radius;
  var rest = 0.22;
  var fric = 0.88;
  var i, d, m, speed, groundY, s;
  for (i=debris.length-1;i>=0;i--){
    d = debris[i];
    if (d.frozen){ debris.splice(i,1); continue; }
    m = d.mesh;
    s = (m.userData && m.userData.size) || 0.2;
    groundY = ((m.userData && m.userData.r) || s * 0.42) * 0.55;
    d.vel.y -= g * dt;
    m.position.addScaledVector(d.vel, dt);
    m.rotation.x += d.spin.x * dt;
    m.rotation.y += d.spin.y * dt;
    m.rotation.z += d.spin.z * dt;
    var dx = m.position.x - katamari.position.x;
    var dy = m.position.y - katamari.position.y;
    var dz = m.position.z - katamari.position.z;
    var pr = (m.userData && m.userData.r) || 0.1;
    if (dx*dx + dy*dy + dz*dz < (radius + pr)*(radius + pr) && s <= radius * PICKUP){
      debris.splice(i,1);
      collect(m);
      continue;
    }
    if (m.position.y < groundY){
      m.position.y = groundY;
      if (d.vel.y < 0) d.vel.y = -d.vel.y * rest;
      d.vel.x *= fric; d.vel.z *= fric;
      d.vel.x *= 0.92; d.vel.z *= 0.92;
      speed = d.vel.length();
      if (speed < 0.4 + radius * 0.15){
        freezeDebrisEntry(d);
        debris.splice(i,1);
      }
    }
  }
  for (i=tracers.length-1;i>=0;i--){
    d = tracers[i];
    d.life -= dt;
    d.mesh.position.addScaledVector(d.vel, dt);
    d.vel.y -= g * dt * 0.3;
    if (d.life <= 0 || d.mesh.position.y < 0){
      scene.remove(d.mesh);
      tracers.splice(i,1);
      continue;
    }
    var tdx = d.mesh.position.x - katamari.position.x;
    var tdy = d.mesh.position.y - katamari.position.y;
    var tdz = d.mesh.position.z - katamari.position.z;
    if (tdx*tdx + tdy*tdy + tdz*tdz < (radius + 0.15)*(radius + 0.15) && hitInvuln <= 0){
      scene.remove(d.mesh);
      tracers.splice(i,1);
      var away = new THREE.Vector3(tdx, 0.2, tdz);
      if (away.lengthSq() < 1e-6) away.set(1,0,0);
      away.normalize();
      onHit(away, d.shedN || 1, null);
    }
  }
  if (hitInvuln > 0) hitInvuln -= dt;
}

function shrinkVolume(amount){
  var r = Math.cbrt(Math.max(1e-8, volume - amount) * 3 / (4 * Math.PI));
  if (r < START_R) r = START_R;
  setRadius(r);
}

function shedFromImpact(into){
  var n = 1 + (into / 2.2 | 0);
  if (n > 8) n = 8;
  return n;
}

function shed(count, awayDir){
  if (!attached.length){
    shake = Math.min(0.35, shake + 0.1);
    return;
  }
  attached.sort(function(a,b){ return b.position.length() - a.position.length(); });
  var n = Math.min(count, attached.length);
  var i, a, mesh, imp;
  for (i=0;i<n;i++){
    a = attached.shift();
    a.updateMatrixWorld(true);
    mesh = a.clone(true);
    mesh.userData = {
      size: a.userData.size,
      r: a.userData.r,
      name: a.userData.name || "debris",
      hp: a.userData.hp || 0
    };
    tmpV.setFromMatrixPosition(a.matrixWorld).sub(katamari.position);
    if (tmpV.lengthSq() < 1e-6) tmpV.copy(awayDir);
    tmpV.y = Math.max(0.2, tmpV.y);
    tmpV.normalize();
    mesh.position.copy(katamari.position).addScaledVector(tmpV, radius + mesh.userData.size + 0.15);
    mesh.quaternion.setFromRotationMatrix(a.matrixWorld);
    katamari.remove(a);
    shrinkVolume(a.userData.size * a.userData.size * a.userData.size * FILL);
    imp = awayDir.clone().multiplyScalar(3.5 + radius * 1.8);
    imp.y += 2.8 + radius * 0.8;
    spawnDebris(mesh, imp);
  }
  if (n) sfxShed();
  checkTier();
  syncHUD();
}

function onHit(awayDir, shedCount, nayProp){
  shake = Math.min(0.45, 0.12 + shedCount * 0.08);
  hitInvuln = HIT_INVULN;
  if (attached.length) shed(shedCount, awayDir);
  else shake = Math.min(0.35, shake + 0.1);
  nay(nayProp);
}

// ---------------------------------------------------------------- enemies
var soldiers = [];
var tanks = [];
var planes = [];
var enemyBanners = {army:false, tank:false, plane:false};
var wantedStars = 0;
var wantedSeen = false;
var wantedEl = null;

function wantedLevelFromSize(hh){
  if (hh < 16.0) return 0;
  if (hh < 21.5) return 1;
  if (hh < 30.0) return 2;
  if (hh < 45.0) return 3;
  if (hh < 60.0) return 4;
  return 5;
}

function wantedCaps(stars){
  if (stars <= 0) return {soldier:0, tank:0, plane:0};
  if (stars === 1) return {soldier:2, tank:0, plane:0};
  if (stars === 2) return {soldier:5, tank:0, plane:0};
  if (stars === 3) return {soldier:7, tank:2, plane:0};
  if (stars === 4) return {soldier:9, tank:3, plane:0};
  return {soldier:10, tank:4, plane:3};
}

function updateWantedHUD(){
  if (!wantedEl) wantedEl = document.getElementById("wanted");
  if (!wantedEl) return;
  if (gameMode !== "endless"){
    wantedEl.classList.remove("show");
    return;
  }
  var icons = wantedEl.querySelectorAll("i");
  var i;
  for (i=0;i<icons.length;i++){
    if (i < wantedStars) icons[i].classList.add("on");
    else icons[i].classList.remove("on");
  }
  if (wantedStars > 0) wantedEl.classList.add("show");
  else wantedEl.classList.remove("show");
}

function bakeMover(g){
  bakeProp(g);
  g.matrixAutoUpdate = true;
  return g;
}

function buildSoldier(){
  var g = new THREE.Group();
  var s = 0.5;
  g.add(box(0x3d5a3a, s*0.14, s*0.22, s*0.10, 0, s*0.11, 0));
  g.add(sph(0xe8b98d, s*0.07, 0, s*0.28, 0));
  g.add(box(0x2f3f6b, s*0.16, s*0.06, s*0.06, s*0.08, s*0.18, 0));
  bakeMover(g);
  g.userData = {kind:"soldier", r:s*0.22, size:s, eatable:true, shootT:0.8 + trnd(), alert:false, patrolA:trnd()*Math.PI*2};
  return g;
}

function buildTank(){
  var g = new THREE.Group();
  var s = 5;
  g.add(box(0x4a5a42, s*0.72, s*0.22, s*0.42, 0, s*0.22, 0));
  g.add(box(0x3a4a32, s*0.28, s*0.18, s*0.24, s*0.18, s*0.38, 0));
  g.add(cyl(0x33383f, s*0.04, s*0.38, s*0.34, s*0.38, 0));
  for (var k=-1;k<=1;k+=2)
    for (var j=-1;j<=1;j+=2)
      turn(g, cyl(0x222830, s*0.12, s*0.08, j*s*0.28, s*0.08, k*s*0.20), Math.PI/2,0,0);
  bakeMover(g);
  g.userData = {kind:"tank", r:s*0.45, size:s, eatable:false, shootT:0, shedN:4};
  return g;
}

function buildPlane(){
  var g = new THREE.Group();
  var s = 15;
  g.add(box(0x9aa3ad, s*0.55, s*0.08, s*0.12, 0, 0, 0));
  turn(g, box(0x9aa3ad, s*0.18, s*0.04, s*0.55, 0, 0.02, 0), 0,0,0);
  g.add(box(0x7a8a9a, s*0.10, s*0.10, s*0.10, s*0.22, 0.04, 0));
  bakeMover(g);
  g.userData = {kind:"plane", r:s*0.35, size:s, eatable:false, shootT:0, y:18};
  return g;
}

function clampWorld(x){
  return Math.max(-WORLD, Math.min(WORLD, x));
}

function spawnEnemy(kind){
  var list = kind === "soldier" ? soldiers : kind === "tank" ? tanks : planes;
  var caps = wantedCaps(wantedStars);
  if (list.length >= caps[kind]) return;
  var ang = trnd() * Math.PI * 2;
  var dist;
  if (kind === "soldier") dist = Math.max(22, scene.fog.far * 0.55 + trnd() * scene.fog.far * 0.25);
  else if (kind === "tank") dist = Math.max(28, scene.fog.far * 0.6 + trnd() * scene.fog.far * 0.25);
  else dist = Math.max(36, scene.fog.far * 0.7 + trnd() * scene.fog.far * 0.2);
  dist = Math.min(dist, WORLD - 8);
  var x = clampWorld(katamari.position.x + Math.cos(ang) * dist);
  var z = clampWorld(katamari.position.z + Math.sin(ang) * dist);
  var e = kind === "soldier" ? buildSoldier() : kind === "tank" ? buildTank() : buildPlane();
  e.position.set(x, kind === "plane" ? (15 + trnd()*10) : e.userData.r, z);
  e.rotation.y = trnd() * Math.PI * 2;
  scene.add(e);
  list.push(e);
  if (kind === "soldier" && !enemyBanners.army){ enemyBanners.army = true; banner("The army has noticed.", 2800); }
  if (kind === "tank" && !enemyBanners.tank){ enemyBanners.tank = true; banner("They brought a tank.", 2800); }
  if (kind === "plane" && !enemyBanners.plane){ enemyBanners.plane = true; banner("Now they're cheating.", 2800); }
}

function maintainEnemies(){
  if (gameMode !== "endless"){
    if (wantedStars || soldiers.length || tanks.length || planes.length) clearEnemies();
    else updateWantedHUD();
    return;
  }
  var hh = handsOf(radius);
  var next = wantedLevelFromSize(hh);
  if (next > wantedStars){
    wantedStars = next;
    updateWantedHUD();
    sfxWanted();
    if (wantedStars === 1) banner("One star. Stay small next time.", 2600);
    else if (wantedStars === 2) banner("Two stars. They're tracking you.", 2600);
    else if (wantedStars === 3) banner("Three stars. They brought a tank.", 2800);
    else if (wantedStars === 4) banner("Four stars. Heavy response.", 2600);
    else if (wantedStars === 5) banner("Five stars. Now they're cheating.", 2800);
  } else if (next < wantedStars){
    if (hh < 14.5 && wantedStars > 0){ wantedStars = 0; updateWantedHUD(); }
    else if (hh < 19 && wantedStars > 1){ wantedStars = 1; updateWantedHUD(); }
    else if (hh < 27 && wantedStars > 2){ wantedStars = 2; updateWantedHUD(); }
    else if (hh < 40 && wantedStars > 3){ wantedStars = 3; updateWantedHUD(); }
    else if (hh < 54 && wantedStars > 4){ wantedStars = 4; updateWantedHUD(); }
  }

  var caps = wantedCaps(wantedStars);
  if (wantedStars === 1 && soldiers.length < caps.soldier && trnd() < 0.08) spawnEnemy("soldier");
  else if (wantedStars >= 2){
    while (soldiers.length < caps.soldier && trnd() < 0.55) spawnEnemy("soldier");
  }
  if (wantedStars >= 3 && tanks.length < caps.tank && trnd() < 0.2) spawnEnemy("tank");
  if (wantedStars >= 5 && planes.length < caps.plane && trnd() < 0.12) spawnEnemy("plane");

  while (soldiers.length > caps.soldier){
    var drop = soldiers.pop();
    dumpBaked(drop);
    scene.remove(drop);
  }
  while (tanks.length > caps.tank){ dumpBaked(tanks[tanks.length-1]); scene.remove(tanks.pop()); }
  while (planes.length > caps.plane){ dumpBaked(planes[planes.length-1]); scene.remove(planes.pop()); }

  var px = katamari.position.x, pz = katamari.position.z;
  var maxD = WORLD * 1.25;
  function cull(list){
    for (var i=list.length-1;i>=0;i--){
      var e = list[i];
      var dx = e.position.x - px, dz = e.position.z - pz;
      if (dx*dx + dz*dz > maxD*maxD){
        dumpBaked(e);
        scene.remove(e);
        list.splice(i,1);
      }
    }
  }
  cull(soldiers); cull(tanks); cull(planes);
}

function updateEnemies(dt){
  var px = katamari.position.x, py = katamari.position.y, pz = katamari.position.z;
  var i, e, u, dx, dz, dist, sp;

  for (i=0;i<soldiers.length;i++){
    e = soldiers[i];
    u = e.userData;
    dx = px - e.position.x; dz = pz - e.position.z;
    dist = Math.sqrt(dx*dx + dz*dz) || 1;
    if (wantedStars <= 1){
      if (!u.alert && dist < 14 + radius * 3){
        u.alert = true;
        wantedSeen = true;
      }
      if (!u.alert){
        u.patrolA += dt * 0.7;
        e.position.x = clampWorld(e.position.x + Math.cos(u.patrolA) * 1.2 * dt);
        e.position.z = clampWorld(e.position.z + Math.sin(u.patrolA) * 1.2 * dt);
        e.rotation.y = u.patrolA;
      } else {
        sp = 1.8 + radius * 0.25;
        var stand = Math.max(5, radius * 2.2 + 3);
        if (dist > stand){
          e.position.x = clampWorld(e.position.x + (dx/dist) * sp * dt);
          e.position.z = clampWorld(e.position.z + (dz/dist) * sp * dt);
        }
        e.rotation.y = Math.atan2(dx, dz);
        if (dist > 28 + radius * 6) u.alert = false;
      }
    } else {
      sp = 2.4 + radius * 0.45 + wantedStars * 0.15;
      var standOff = Math.max(4, radius * 2.2 + 2.5);
      if (dist > standOff){
        e.position.x = clampWorld(e.position.x + (dx/dist) * sp * dt);
        e.position.z = clampWorld(e.position.z + (dz/dist) * sp * dt);
      } else if (dist < standOff * 0.65){
        e.position.x = clampWorld(e.position.x - (dx/dist) * sp * 0.55 * dt);
        e.position.z = clampWorld(e.position.z - (dz/dist) * sp * 0.55 * dt);
      }
      e.rotation.y = Math.atan2(dx, dz);
      u.alert = true;
    }

    u.shootT -= dt;
    var canShoot = (wantedStars >= 2 || u.alert) && dist < 22 + radius * 6;
    if (u.shootT <= 0 && canShoot){
      u.shootT = 1.0 + trnd() * 0.7;
      enemyTmp.set(dx/dist, 0.15, dz/dist);
      spawnTracer(e.position.clone().add(new THREE.Vector3(0, u.r, 0)), enemyTmp, 1);
    }
    if (dist < radius + u.r + 0.2 && u.size <= radius * PICKUP){
      dumpBaked(e);
      scene.remove(e); soldiers.splice(i,1); i--;
      collectEnemy(e, u);
    }
  }

  for (i=0;i<tanks.length;i++){
    e = tanks[i];
    u = e.userData;
    dx = px - e.position.x; dz = pz - e.position.z;
    dist = Math.sqrt(dx*dx + dz*dz) || 1;
    sp = 1.1 + radius * 0.15;
    e.position.x = clampWorld(e.position.x + (dx/dist) * sp * dt);
    e.position.z = clampWorld(e.position.z + (dz/dist) * sp * dt);
    e.rotation.y = Math.atan2(dx, dz);
    u.shootT -= dt;
    if (u.shootT <= 0 && dist < 55 + radius * 10){
      u.shootT = 1.4 + trnd() * 0.8;
      enemyTmp.set(dx/dist, 0.2, dz/dist);
      spawnTracer(e.position.clone().add(new THREE.Vector3(0, u.r*0.6, 0)), enemyTmp, 3 + ((trnd()*4)|0));
    }
    if (dist < radius + u.r){
      if (u.size > radius * PICKUP){
        var tdx = e.position.x - px, tdz = e.position.z - pz;
        var tl = Math.sqrt(tdx*tdx + tdz*tdz) || 1;
        katamari.position.x += (tdx/tl) * 0.08;
        katamari.position.z += (tdz/tl) * 0.08;
        vel.x *= 0.5; vel.z *= 0.5;
        if (hitInvuln <= 0) onHit(new THREE.Vector3(tdx/tl, 0.15, tdz/tl), u.shedN, e);
      } else {
        dumpBaked(e);
        scene.remove(e); tanks.splice(i,1); i--;
        collectEnemy(e, u);
      }
    }
  }

  for (i=0;i<planes.length;i++){
    e = planes[i];
    u = e.userData;
    var ox = Math.cos(performance.now()*0.0004 + i) * (18 + radius * 2);
    var oz = Math.sin(performance.now()*0.0004 + i) * (18 + radius * 2);
    var tx = px + ox, tz = pz + oz;
    dx = tx - e.position.x; dz = tz - e.position.z;
    dist = Math.sqrt(dx*dx + dz*dz) || 1;
    sp = 10 + radius * 0.5;
    e.position.x = clampWorld(e.position.x + (dx/dist) * sp * dt);
    e.position.z = clampWorld(e.position.z + (dz/dist) * sp * dt);
    e.position.y = u.y + Math.sin(performance.now()*0.001 + i)*0.8;
    e.rotation.y = Math.atan2(dx, dz);
    dx = px - e.position.x; dz = pz - e.position.z;
    dist = Math.sqrt(dx*dx + dz*dz) || 1;
    u.shootT -= dt;
    if (u.shootT <= 0 && dist < 80 + radius * 12){
      u.shootT = 0.55 + trnd() * 0.35;
      enemyTmp.set(dx/dist, -0.35, dz/dist).normalize();
      spawnTracer(e.position.clone(), enemyTmp, 2);
    }
    u.eatable = py + radius >= e.position.y - u.r * 0.3;
    if (dist < radius + u.r * 0.5 && u.eatable && u.size <= radius * PICKUP){
      dumpBaked(e);
      scene.remove(e); planes.splice(i,1); i--;
      collectEnemy(e, u);
    }
  }
}

function collectEnemy(e, u){
  volume += u.size * u.size * u.size * FILL * 0.5;
  setRadius(Math.cbrt(volume * 3 / (4 * Math.PI)));
  collected++;
  gulpPunch = Math.min(0.11, gulpPunch + 0.04);
  sfxStick();
  announce(u.kind, 0);
  checkTier();
  syncHUD();
}

function clearEnemies(){
  var i;
  for (i=0;i<soldiers.length;i++){ dumpBaked(soldiers[i]); scene.remove(soldiers[i]); }
  for (i=0;i<tanks.length;i++){ dumpBaked(tanks[i]); scene.remove(tanks[i]); }
  for (i=0;i<planes.length;i++){ dumpBaked(planes[i]); scene.remove(planes[i]); }
  soldiers.length = tanks.length = planes.length = 0;
  for (i=0;i<debris.length;i++){ dumpBaked(debris[i].mesh); scene.remove(debris[i].mesh); }
  for (i=0;i<tracers.length;i++) scene.remove(tracers[i].mesh);
  debris.length = tracers.length = 0;
  enemyBanners = {army:false, tank:false, plane:false};
  wantedStars = 0;
  wantedSeen = false;
  hitInvuln = 0;
  updateWantedHUD();
}

// ---------------------------------------------------------------- state
var radius, volume, collected, timeLeft, elapsed, running, vel, camYaw, shake, cleared;
var hp, tier, dirty, gameMode, hitStop = 0, gulpPunch = 0;
var camTier, camDist = 0, camHigh = 0, camKick = 0;
var lastHands = 0, lastSizeText = "", callGen = 0;

function setRadius(r){
  radius = r;
  volume = (4/3)*Math.PI*r*r*r;
  core.scale.setScalar(r);
  scene.fog.near = 60 + r*9;
  scene.fog.far  = 230 + r*34;
  camera.far = Math.max(scene.fog.far + 80, 2500);
  camera.updateProjectionMatrix();
  var ext = Math.max(20, r*9);
  var sc = sun.shadow.camera;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
  sc.updateProjectionMatrix();
}
function powerMul(){ return 1 + Math.log10(Math.max(1,hp)) * 0.30; }
function framedRadius(t){
  var i = t + 1;
  if (i < 0) i = 0;
  if (i < TIERS.length) return TIERS[i][0] * CM_PER_HAND / 200;
  return TIERS[TIERS.length-1][0] * CM_PER_HAND / 200 * 1.25;
}
function camTargets(t){
  var r = framedRadius(t);
  return {
    dist: 4.2 + r * 4.2,
    high: 1.8 + r * 2.4,
    fov: 58 + Math.min(8, Math.max(0, t + 1) * 0.55)
  };
}
function applyFov(){
  camera.fov = camTargets(camTier).fov;
  camera.updateProjectionMatrix();
}

function reset(){
  var i;
  contactProps = -1;
  for (i=0;i<props.length;i++){
    dumpBaked(props[i]);
    scene.remove(props[i]);
  }
  for (i=0;i<attached.length;i++){
    dumpBaked(attached[i]);
    katamari.remove(attached[i]);
  }
  props.length = 0; attached.length = 0;
  clearEnemies();

  reseed();

  setRadius(START_R);
  collected= 0;
  timeLeft = ROUND_TIME;
  elapsed  = 0;
  cleared  = false;
  dirty    = false;
  hp       = 1;
  tier     = tierIndex(handsOf(START_R));
  camTier  = tier;
  camKick  = 0;
  camDist  = 0;
  lastHands = handsOf(START_R);
  lastSizeText = handsText(lastHands);
  vel      = new THREE.Vector3();
  camYaw   = 0;
  shake    = 0;
  rigYaw   = 0;
  bobT     = 0;
  tailSpring = 0;
  tailVel  = 0;
  tailPitch = 0;
  tailPitchVel = 0;
  hairLag = 0;
  hairVel = 0;
  nayAt    = 0;
  nayProp  = null;
  hitStop  = 0;
  gulpPunch = 0;

  katamari.position.set(0, radius, 0);
  katamari.quaternion.identity();
  stashPrev();

  spawnWorld(1100);
  hitInvuln = 0;
  pickedEl.innerHTML = "";
  bannerEl.classList.remove("show");
  var h = document.getElementById("hint");
  h.textContent = gameMode === "endless" ? HINT_ENDLESS : HINT_TIMED;
  h.style.opacity = 1;
  setTimeout(function(){ h.style.opacity = 0; }, 7000);
  applyFov();
  syncHUD();
  syncClock();
  updateRig(0);
  placeCamera(0, true);
  placeSky();
}

// ---------------------------------------------------------------- collecting
function collect(p){
  var s = p.userData.size;
  var from, i, a;
  p.matrixAutoUpdate = true;

  katamari.getWorldQuaternion(tmpQ).invert();
  tmpV.copy(p.position).sub(katamari.position).applyQuaternion(tmpQ);
  if (tmpV.lengthSq() < 1e-6) tmpV.set(0, 1, 0);
  from = tmpV.clone();

  p.position.copy(from);
  p.quaternion.premultiply(tmpQ);

  scene.remove(p);
  katamari.add(p);
  attached.push(p);

  volume += s*s*s*FILL;
  setRadius(Math.cbrt(volume*3/(4*Math.PI)));
  collected++;

  p.userData.gulpFrom = from;
  p.userData.gulpTo = from.clone().normalize().multiplyScalar(radius*0.96 + s*0.34);
  p.userData.gulpT = 0;
  gulpPunch = Math.min(0.11, gulpPunch + 0.04);
  sfxStick();

  if (p.userData.hp) hp += p.userData.hp;

  for (i=attached.length-1;i>=0;i--){
    a = attached[i];
    if (a.userData.gulpTo) continue;
    if (a.position.length() + a.userData.size*0.55 < radius*0.94){
      dumpBaked(a);
      katamari.remove(a);
      attached.splice(i,1);
    }
  }
  announce(p.userData.name, p.userData.hp);
  checkTier();
  syncHUD();
}

function updateGulps(dt){
  var i, a, t, k;
  for (i=0;i<attached.length;i++){
    a = attached[i];
    if (!a.userData.gulpTo) continue;
    t = a.userData.gulpT + dt / GULP;
    if (t >= 1){
      a.position.copy(a.userData.gulpTo);
      a.userData.gulpFrom = a.userData.gulpTo = null;
      a.userData.gulpT = 0;
      continue;
    }
    a.userData.gulpT = t;
    k = 1 - (1-t)*(1-t)*(1-t);
    a.position.lerpVectors(a.userData.gulpFrom, a.userData.gulpTo, k);
  }
}

var pickedEl = document.getElementById("picked");
function announce(name, gain){
  if (pickedEl.childElementCount > 4) pickedEl.removeChild(pickedEl.firstChild);
  var d = document.createElement("div");
  d.className = "pick";
  d.textContent = name;
  if (gain){
    var b = document.createElement("b");
    b.textContent = "+" + gain + " hp";
    d.appendChild(b);
  }
  pickedEl.appendChild(d);
  setTimeout(function(){ if (d.parentNode) d.parentNode.removeChild(d); }, 1700);
}

// ---------------------------------------------------------------- banners
var bannerEl = document.getElementById("banner");
var bannerT = null;
function banner(text, ms){
  bannerEl.textContent = text;
  bannerEl.classList.add("show");
  clearTimeout(bannerT);
  bannerT = setTimeout(function(){ bannerEl.classList.remove("show"); }, ms || 2600);
}
function hushCall(){
  callGen++;
  if (typeof speechSynthesis === "undefined") return;
  try { speechSynthesis.cancel(); } catch (e){}
}
function ownerCall(t){
  if (typeof speechSynthesis === "undefined") return;
  callGen++;
  var g = callGen;
  var u = new SpeechSynthesisUtterance();
  u.lang = "en-US";
  if (t < 3){ u.text = "max."; u.rate = 0.85; u.pitch = 0.75; u.volume = 0.55; }
  else if (t < 6){ u.text = "Max."; u.rate = 1.0; u.pitch = 0.95; u.volume = 0.8; }
  else if (t < 9){ u.text = "Max!"; u.rate = 1.15; u.pitch = 1.15; u.volume = 1; }
  else { u.text = "MAAAAAX"; u.rate = 0.7; u.pitch = 1.28; u.volume = 1; }
  try { speechSynthesis.cancel(); } catch (e){}
  // chrome drops speak() in the same tick as cancel()
  setTimeout(function(){
    if (g !== callGen) return;
    try { speechSynthesis.speak(u); } catch (e){}
  }, 50);
}
function checkTier(){
  var h = handsOf(radius);
  var t = tierIndex(h);
  var label = handsText(h);
  var grew = h > lastHands + 1e-9 && label !== lastSizeText;
  lastHands = h;
  lastSizeText = label;
  if (t > camTier){
    camTier = t;
    camKick = 1;
  }
  if (t > tier){
    tier = t;
    if (!cleared){
      var row = TIERS[t];
      banner(row[2] || (handsText(row[0]) + "hh — " + row[1]), row[2] ? 3600 : 2200);
    }
  } else {
    tier = t;
  }
  if (grew && running) ownerCall(t);
}

// ---------------------------------------------------------------- nay
var nayEl = document.getElementById("nay");
var nayAt = 0, nayProp = null;
var flashEl = document.getElementById("flash");
function nay(p){
  var t = performance.now();
  if (p === nayProp && t - nayAt < 1500) return;
  if (t - nayAt < 600) return;
  nayProp = p; nayAt = t;
  nayEl.classList.remove("go");
  void nayEl.offsetWidth;
  nayEl.classList.add("go");
  if (flashEl){
    flashEl.classList.remove("go");
    void flashEl.offsetWidth;
    flashEl.classList.add("go");
  }
  hitStop = HIT_STOP;
  sfxNay();
}

// ---------------------------------------------------------------- HUD
var sizeval = document.getElementById("sizeval");
var metricEl= document.getElementById("metric");
var barfill = document.getElementById("barfill");
var barEl   = document.getElementById("bar");
var tierEl  = document.getElementById("tier");
var hpEl    = document.getElementById("hp");
var timeEl  = document.getElementById("time");
var clockEl = document.getElementById("clock");
var clockCap = clockEl.querySelector(".cap");

function progOf(r){
  return (Math.log(r/START_R) / Math.log(GOAL_R/START_R)) * 100;
}
(function buildTicks(){
  for (var i=0;i<TIERS.length;i++){
    var r = TIERS[i][0] * CM_PER_HAND / 200;
    var p = progOf(r);
    if (p <= 2 || p >= 99) continue;
    var d = document.createElement("div");
    d.className = "tick" + (TIERS[i][2] ? " big" : "");
    d.style.left = p + "%";
    barEl.appendChild(d);
  }
})();

var lastHp = 1, hpT = null;
function syncHUD(){
  var h = handsOf(radius);
  sizeval.innerHTML = handsText(h) + "<span>hh</span>";
  metricEl.textContent = metricText(radius);
  barfill.style.width = Math.max(0, Math.min(100, progOf(radius))) + "%";
  tierEl.textContent = tierName(tier);
  hpEl.textContent = Math.round(hp) + " hp";
  if (hp !== lastHp){
    lastHp = hp;
    hpEl.classList.add("up");
    clearTimeout(hpT);
    hpT = setTimeout(function(){ hpEl.classList.remove("up"); }, 700);
  }
}
function syncClock(){
  if (running && gameMode === "endless"){
    clockCap.textContent = "Time";
    var t = Math.max(0, Math.floor(elapsed));
    timeEl.textContent = Math.floor(t/60) + ":" + ("0" + (t%60)).slice(-2);
    clockEl.classList.remove("low");
    clockEl.classList.add("done");
  } else {
    clockCap.textContent = "Time left";
    var tl = Math.max(0, Math.ceil(timeLeft));
    timeEl.textContent = Math.floor(tl/60) + ":" + ("0" + (tl%60)).slice(-2);
    clockEl.classList.toggle("low", tl <= 20);
    clockEl.classList.remove("done");
  }
}

// ---------------------------------------------------------------- input
var keys = {};
addEventListener("keydown", function(e){
  keys[e.code] = true;
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].indexOf(e.code) >= 0) e.preventDefault();
  if (e.code === "Escape" && running && gameMode === "endless"){
    e.preventDefault();
    finish(cleared);
    return;
  }
  if (DEV && running) devKey(e.code);
});
addEventListener("keyup", function(e){ keys[e.code] = false; });
addEventListener("blur", function(){ keys = {}; });

// Dev field only. Any of these marks the run so it can never be a record.
function devKey(code){
  if (code === "BracketRight"){ setRadius(radius*1.4); dirty = true; }
  else if (code === "BracketLeft"){ setRadius(Math.max(START_R, radius/1.4)); dirty = true; }
  else if (code === "KeyT" && gameMode === "timed"){ timeLeft += 30; dirty = true; }
  else if (code === "KeyY"){ hp *= 4; dirty = true; }
  else return;
  checkTier();
  syncHUD();
  syncClock();
}

var dragging = false, lastX = 0;
renderer.domElement.addEventListener("pointerdown", function(e){
  if (e.pointerType === "touch") return;
  dragging = true; lastX = e.clientX;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", function(e){
  if (!dragging) return;
  camYaw -= (e.clientX - lastX) * 0.005;
  lastX = e.clientX;
});
addEventListener("pointerup", function(){ dragging = false; });

var touchDir = new THREE.Vector2();
var knob = document.getElementById("knob");
var stickId = null, stickOrigin = {x:0,y:0};

function stickStart(e){
  var t = e.changedTouches[0];
  stickId = t.identifier;
  stickOrigin.x = t.clientX; stickOrigin.y = t.clientY;
  knob.style.display = "block";
  knob.style.left = (t.clientX-55) + "px";
  knob.style.top  = (t.clientY-55) + "px";
  e.preventDefault();
}
function stickMove(e){
  for (var i=0;i<e.changedTouches.length;i++){
    var t = e.changedTouches[i];
    if (t.identifier !== stickId) continue;
    var dx = t.clientX - stickOrigin.x, dy = t.clientY - stickOrigin.y;
    var len = Math.hypot(dx,dy) || 1;
    var cl = Math.min(len, 55);
    touchDir.set(dx/len * (cl/55), dy/len * (cl/55));
    knob.firstElementChild.style.transform =
      "translate(" + (dx/len*cl) + "px," + (dy/len*cl) + "px)";
  }
  e.preventDefault();
}
function stickEnd(e){
  for (var i=0;i<e.changedTouches.length;i++){
    if (e.changedTouches[i].identifier === stickId){
      stickId = null; touchDir.set(0,0);
      knob.style.display = "none";
      knob.firstElementChild.style.transform = "";
    }
  }
}
var stickEl = document.getElementById("stick");
stickEl.addEventListener("touchstart", stickStart, {passive:false});
stickEl.addEventListener("touchmove",  stickMove,  {passive:false});
stickEl.addEventListener("touchend",   stickEnd);
stickEl.addEventListener("touchcancel",stickEnd);

var lookId = null, lookX = 0;
var lookEl = document.getElementById("look");
lookEl.addEventListener("touchstart", function(e){
  var t = e.changedTouches[0]; lookId = t.identifier; lookX = t.clientX; e.preventDefault();
}, {passive:false});
lookEl.addEventListener("touchmove", function(e){
  for (var i=0;i<e.changedTouches.length;i++){
    var t = e.changedTouches[i];
    if (t.identifier !== lookId) continue;
    camYaw -= (t.clientX - lookX) * 0.006;
    lookX = t.clientX;
  }
  e.preventDefault();
}, {passive:false});
lookEl.addEventListener("touchend", function(){ lookId = null; });

// ---------------------------------------------------------------- camera
var prevPos = new THREE.Vector3();
var prevQuat = new THREE.Quaternion();
var savePos = new THREE.Vector3();
var saveQuat = new THREE.Quaternion();
var prevCamYaw = 0, saveCamYaw = 0;

function stashPrev(){
  prevPos.copy(katamari.position);
  prevQuat.copy(katamari.quaternion);
  prevCamYaw = camYaw;
}
function pushInterp(alpha){
  savePos.copy(katamari.position);
  saveQuat.copy(katamari.quaternion);
  saveCamYaw = camYaw;
  katamari.position.lerpVectors(prevPos, savePos, alpha);
  katamari.quaternion.copy(prevQuat).slerp(saveQuat, alpha);
  camYaw = angLerp(prevCamYaw, saveCamYaw, alpha);
}
function popInterp(){
  katamari.position.copy(savePos);
  katamari.quaternion.copy(saveQuat);
  camYaw = saveCamYaw;
}

var camPos = new THREE.Vector3();
var camAim = new THREE.Vector3();
function placeCamera(dt, snap){
  var t = camTargets(camTier);
  var kick = camKick * 0.2;
  var dist = t.dist * (1 + kick);
  var high = t.high * (1 + kick);
  if (snap || !camDist){
    camDist = dist;
    camHigh = high;
    camera.fov = t.fov;
    camera.updateProjectionMatrix();
  } else {
    var k = 1 - Math.pow(1 - 0.07, dt*60);
    camDist += (dist - camDist) * k;
    camHigh += (high - camHigh) * k;
    camera.fov += (t.fov - camera.fov) * k;
    camera.updateProjectionMatrix();
  }
  if (camKick > 0) camKick = Math.max(0, camKick - dt * 2.4);
  camPos.set(
    katamari.position.x + Math.sin(camYaw)*camDist,
    katamari.position.y + camHigh,
    katamari.position.z + Math.cos(camYaw)*camDist
  );
  camAim.copy(katamari.position);
  camAim.y += radius*0.6;
  if (snap) camera.position.copy(camPos);
  else camera.position.lerp(camPos, 1 - Math.pow(1 - 0.09, dt*60));
  camera.lookAt(camAim);
  if (shake > 0){
    camera.position.x += (Math.random()-0.5)*shake;
    camera.position.y += (Math.random()-0.5)*shake;
  }
}

// ---------------------------------------------------------------- loop
var clock = new THREE.Clock();
var moveDir = new THREE.Vector3();
var axis = new THREE.Vector3();
var fwd = new THREE.Vector3();
var right = new THREE.Vector3();

function step(dt){
  if (hitStop > 0){
    hitStop--;
    stashPrev();
    return;
  }
  stashPrev();
  var fx = 0, fz = 0;
  if (keys.KeyW || keys.ArrowUp)    fz += 1;
  if (keys.KeyS || keys.ArrowDown)  fz -= 1;
  if (keys.KeyD || keys.ArrowRight) fx += 1;
  if (keys.KeyA || keys.ArrowLeft)  fx -= 1;
  if (touchDir.lengthSq() > 0.01){ fx += touchDir.x; fz -= touchDir.y; }
  if (keys.KeyQ) camYaw += dt*1.8;
  if (keys.KeyE) camYaw -= dt*1.8;

  fwd.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  right.set(-fwd.z, 0, fwd.x);
  moveDir.set(0,0,0).addScaledVector(fwd, fz).addScaledVector(right, fx);
  if (moveDir.lengthSq() > 1) moveDir.normalize();

  var pm      = powerMul();
  var accel   = (18 + radius*7)   * pm;
  var maxSpd  = (8.2 + radius*2.6) * pm;
  vel.addScaledVector(moveDir, accel*dt);
  vel.multiplyScalar(Math.pow(0.02, dt));
  var sp = vel.length();
  if (sp > maxSpd){ vel.multiplyScalar(maxSpd/sp); sp = maxSpd; }

  katamari.position.addScaledVector(vel, dt);
  katamari.position.y = radius;

  var dist = sp*dt;
  if (dist > 1e-5){
    axis.set(vel.x, 0, vel.z).normalize();
    axis.crossVectors(UP, axis);
    katamari.rotateOnWorldAxis(axis, dist/radius);
  }

  updateDynamics(dt);
  updateEnemies(dt);

  var lim = WORLD;
  if (Math.abs(katamari.position.x) > lim){
    katamari.position.x = Math.sign(katamari.position.x)*lim; vel.x *= -0.3;
  }
  if (Math.abs(katamari.position.z) > lim){
    katamari.position.z = Math.sign(katamari.position.z)*lim; vel.z *= -0.3;
  }

  var reach = radius + 3.2;
  for (var i=props.length-1;i>=0;i--){
    var p = props[i];
    var dx = p.position.x - katamari.position.x;
    var dz = p.position.z - katamari.position.z;
    var pr = p.userData.r;
    if (Math.abs(dx) > reach + pr || Math.abs(dz) > reach + pr) continue;

    var d2 = dx*dx + dz*dz;
    var hit = radius + pr;
    if (d2 > hit*hit) continue;
    if (p.userData.trojan && !p.userData.opened) crackTrojan(p);
    if (p.userData.size <= radius * PICKUP){
      props.splice(i,1);
      contactProps = -1;
      collect(p);
    } else {
      var d = Math.sqrt(d2) || 0.001;
      var nx = -dx/d, nz = -dz/d;
      katamari.position.x += nx*(hit-d);
      katamari.position.z += nz*(hit-d);
      var into = vel.x*(-nx) + vel.z*(-nz);
      if (into > 0){
        vel.x += nx*into*1.5;
        vel.z += nz*into*1.5;
        shake = Math.min(0.35, into*0.03);
        if (hitInvuln <= 0){
          onHit(new THREE.Vector3(nx, 0.1, nz), attached.length ? shedFromImpact(into) : 0, p);
        }
      }
    }
  }
  if (shake > 0) shake = Math.max(0, shake - dt*1.4);
  updateGulps(dt);
}

function followSun(){
  sun.position.copy(katamari.position).add(SUN_LIGHT);
  sun.target.position.copy(katamari.position);
}
function placeSky(){
  camera.updateMatrixWorld();
  skyMat.uniforms.projInverse.value.copy(camera.projectionMatrixInverse);
  skyMat.uniforms.viewInverse.value.copy(camera.matrixWorld);
  skyRoot.position.copy(camera.position);
}

var acc = 0;
var fpsT = 0, fpsN = 0, fps = 0;
function frame(){
  requestAnimationFrame(frame);
  var dt = Math.min(clock.getDelta(), 0.25);
  if (gulpPunch > 0) gulpPunch = Math.max(0, gulpPunch - dt * 0.85);
  fpsN++;
  fpsT += dt;
  if (fpsT >= 0.5){
    fps = fpsN / fpsT;
    fpsN = 0;
    fpsT = 0;
  }

  if (running){
    acc += dt;
    var n = 0;
    while (acc >= FIXED && n < MAX_STEPS && running){
      var frozen = hitStop > 0;
      step(FIXED);
      if (!frozen){
        if (gameMode === "endless") elapsed += FIXED;
        else timeLeft -= FIXED;
      }
      acc -= FIXED;
      n++;
      if (!frozen && gameMode !== "endless" && timeLeft <= 0) break;
    }
    if (acc > FIXED*MAX_STEPS) acc = 0;
    syncClock();
    if (radius >= GOAL_R && !cleared) clearGoal();
    if (gameMode !== "endless" && timeLeft <= 0) finish(cleared);
    maintainEnemies();
  }

  var alpha = running ? Math.max(0, Math.min(1, acc / FIXED)) : 1;
  pushInterp(alpha);
  if (gulpPunch > 0){
    katamari.scale.setScalar(1 + gulpPunch);
    katamari.position.y += radius * gulpPunch;
  }
  followSun();
  updateRig(dt);
  placeCamera(dt, false);
  placeSky();
  updateContacts();
  renderer.render(scene, camera);
  katamari.scale.setScalar(1);
  popInterp();
}

window.__mh = function(){
  var meshes = 0, shadow = 0;
  scene.traverse(function(o){
    if (!o.isMesh) return;
    meshes++;
    if (o.castShadow) shadow++;
  });
  return {
    fps: +fps.toFixed(1),
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    meshes: meshes,
    shadow: shadow,
    dpr: renderer.getPixelRatio(),
    contacts: contactMesh.count,
    contactBuilds: contactBuilds,
    props: props.length,
    mode: gameMode,
    elapsed: +elapsed.toFixed(2),
    collected: collected,
    radius: +radius.toFixed(3),
    gulpPunch: +gulpPunch.toFixed(3),
    hitStop: hitStop,
    gulping: attached.filter(function(a){ return a.userData.gulpTo; }).length,
    cx: +camera.position.x.toFixed(5),
    cz: +camera.position.z.toFixed(5),
    mix: (function(){
      var n = [0,0,0,0,0], rad = [0,0,0,0,0], i, s, b, r;
      for (i=0;i<props.length;i++){
        s = props[i].userData.size;
        r = Math.hypot(props[i].position.x, props[i].position.z);
        if (s < 0.4) b=0;
        else if (s < 1.2) b=1;
        else if (s < 4) b=2;
        else if (s < 8) b=3;
        else b=4;
        n[b]++; rad[b]+=r;
      }
      return {n:n, r:rad.map(function(v,i){ return n[i] ? +(v/n[i]).toFixed(1) : 0; })};
    })()
  };
};

// ---------------------------------------------------------------- flow
function clearGoal(){
  cleared = true;
  ownerCall(99);
  banner("78.2hh. Max is max. Keep going.", 3200);
}

var startveil = document.getElementById("startveil");
var endveil   = document.getElementById("endveil");

function finish(won){
  if (!running) return;
  running = false;
  var h = handsOf(radius);
  var endless = gameMode === "endless";
  document.getElementById("endtitle").textContent = won ? "umatamari" : (endless ? "enough." : "time.");
  document.getElementById("final").innerHTML = handsText(h) + "<span>hh</span>";
  document.getElementById("tally").textContent =
    collected + " things stuck to Max · " + metricText(radius) + " across";
  document.getElementById("exprval").textContent = handsText(h) + "hh, " + Math.round(hp) + " hp";
  document.getElementById("endnote").textContent = won
    ? (endless
      ? "Sampson managed 21.2hh in 1850 and nothing has beaten him since."
      : "Sampson managed 21.2hh in 1850 and nothing has beaten him since. Max did it in three minutes.")
    : (endless
      ? "No bell. The field was always going to wait."
      : "Start on the crumbs. Every pickup unlocks the next size up.");
  document.getElementById("devnote").classList.toggle("hidden", !dirty);
  document.getElementById("seedend").textContent = "field " + SEED;
  endveil.classList.remove("hidden");
  syncClock();
  if (!endless) submitKing(won);
}

function kingLine(k){
  if (!k || !k.hh) return "no umatamari yet. there can be only one.";
  return "the umatamari is <b>" + handsText(k.hh) + "hh</b>";
}
function showKing(k){
  var start = document.getElementById("kingline");
  var end = document.getElementById("kingend");
  var html = kingLine(k);
  if (start) start.innerHTML = html;
  if (end) end.innerHTML = html;
  if (!k || !k.radius || running) return;
  if (startveil.classList.contains("hidden")) return;
  setRadius(k.radius);
  hp = k.hp || 1;
  tier = tierIndex(handsOf(k.radius));
  camTier = tier;
  camKick = 0;
  camDist = 0;
  applyFov();
  updateRig(0);
  placeCamera(0, true);
  placeSky();
  syncHUD();
  stashPrev();
}
function loadKing(){
  return fetch("/api/max").then(function(r){
    if (!r.ok) return { king: null };
    return r.json();
  }).then(function(d){ showKing(d && d.king); }).catch(function(){ showKing(null); });
}
function submitKing(won){
  if (dirty || DEV) return;
  fetch("/api/max", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      radius: radius,
      hp: hp,
      collected: collected,
      seed: SEED
    })
  }).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
    if (!d) return;
    if (d.king) showKing(d.king);
    if (d.took){
      document.getElementById("endtitle").textContent = "THE UMATAMARI";
      var note = document.getElementById("endnote");
      note.textContent = (won ? note.textContent + " " : "") + "this is the umatamari.";
    }
  }).catch(function(){});
}

function begin(mode){
  ensureAudio();
  hushCall();
  gameMode = mode === "endless" ? "endless" : "timed";
  saveMode(gameMode);
  startveil.classList.add("hidden");
  endveil.classList.add("hidden");
  reset();
  clock.getDelta();
  acc = 0;
  running = true;
  syncClock();
}
document.getElementById("start-timed").addEventListener("click", function(){ begin("timed"); });
document.getElementById("start-endless").addEventListener("click", function(){ begin("endless"); });
document.getElementById("againbtn").addEventListener("click", function(){ begin(loadMode()); });
clockEl.addEventListener("click", function(){
  if (running && gameMode === "endless") finish(cleared);
});

addEventListener("resize", function(){
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- title card
var GLOSS = [
  "<b>uma</b> <i>noun</i><br>a horse.",
  "<b>tamari</b> <i>noun</i><br>a lump. everything that stuck.",
  "<b>umatamari</b> <i>property</i><br>the number that comes back. it only goes up."
];
var glossEl = document.getElementById("gloss"), gi = 1;
glossEl.innerHTML = GLOSS[0];
setInterval(function(){
  if (startveil.classList.contains("hidden")) return;
  glossEl.style.opacity = 0;
  setTimeout(function(){
    glossEl.innerHTML = GLOSS[gi % GLOSS.length]; gi++;
    glossEl.style.opacity = 1;
  }, 340);
}, 3200);

var voiceUnlocked = false;
function titleCall(){
  if (!voiceUnlocked) return;
  if (running || startveil.classList.contains("hidden")) return;
  ownerCall(99);
}
setInterval(titleCall, 9000);
function unlockVoice(){
  voiceUnlocked = true;
  if (typeof speechSynthesis !== "undefined") try { speechSynthesis.getVoices(); } catch (e){}
  titleCall();
}
addEventListener("pointerdown", unlockVoice, {once:true});
addEventListener("keydown", unlockVoice, {once:true});
if (typeof speechSynthesis !== "undefined"){
  setInterval(function(){
    if (speechSynthesis.speaking) try { speechSynthesis.resume(); } catch (e){}
  }, 8000);
}

var seedstart = document.getElementById("seedstart");
if (DEV){
  document.getElementById("devbadge").classList.remove("hidden");
  seedstart.innerHTML = "dev field &middot; <b>[</b> <b>]</b> size, <b>T</b> time (timed only), <b>Y</b> power " +
                        "&middot; <a href='?'>today's field</a>";
} else {
  seedstart.innerHTML = "field " + SEED + " — everyone gets the same one today " +
                        "&middot; <a href='?seed=dev'>dev field</a>";
}

// idle backdrop behind the title card
gameMode = loadMode();
reset();
running = false;
loadKing();
frame();

