/**
 * 黑洞 · 引力透镜 —— 从 src/algos/three-programs/black-hole.js 移植。
 *
 * 同一段测地线积分与体积吸积盘，只改两处：
 *   1. 输出转灰度再反相，让页面保持纯白底、深色盘；
 *   2. 星野与星云归零、步数 220（官网是装饰，不是导出）。
 * 真源在应用里；那边改了参数不要指望这里自动跟上。
 */
import * as THREE from 'three';

const V=`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;
const F=`
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;uniform float uT;uniform float uSeed;
uniform float uMass;uniform float uDiskOut;uniform float uBright;uniform float uSpin;uniform float uTurb;
uniform float uThick;uniform float uBeam;uniform float uCd;uniform float uZoom;uniform float uRoll;
uniform float uOrbit;uniform float uEl;uniform float uStars;uniform float uNeb;uniform float uExposure;
uniform float uVignette;uniform float uGrain;
uniform vec3 uDiskCol;
float h1(vec2 p){p=fract(p*vec2(127.31,311.7));p+=dot(p,p+34.23);return fract(p.x*p.y);}
float n2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(h1(i),h1(i+vec2(1.0,0.0)),f.x),mix(h1(i+vec2(0.0,1.0)),h1(i+vec2(1.0,1.0)),f.x),f.y);}
float fbm(vec2 p){float s=0.0,a=0.5;for(int i=0;i<4;i++){s+=a*n2(p);p=p*2.03+vec2(2.7,6.1);a*=0.5;}return s;}
float h3(vec3 p){p=fract(p*vec3(0.1031,0.1030,0.0973));p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float starL(vec3 d,float K,float thr){
  vec3 p=d*K;
  vec3 i=floor(p);
  float h=h3(i);
  vec3 o=vec3(h3(i+vec3(1.7,0.0,0.0)),h3(i+vec3(0.0,9.2,0.0)),h3(i+vec3(0.0,0.0,4.4)));
  float f=length(fract(p)-o);
  return smoothstep(0.34,0.0,f)*step(thr,h)*(0.30+0.70*h);
}
vec3 skyCol(vec3 d){
  vec3 c=vec3(0.003,0.004,0.009);
  c+=vec3(0.86,0.89,1.00)*(starL(d,150.0,0.962)*1.8+starL(d,240.0,0.982)*1.2+starL(d,90.0,0.990)*2.4)*uStars;
  vec2 sph=vec2(atan(d.z,d.x),acos(clamp(d.y,-1.0,1.0)));
  float nb=fbm(sph*vec2(2.4,3.4)+vec2(0.5));
  c+=vec3(0.065,0.038,0.135)*nb*nb*2.2*uNeb;
  float nb2=fbm(sph*vec2(5.1,6.9)+vec2(7.3,1.1));
  c+=vec3(0.030,0.018,0.070)*nb2*nb2*1.4*uNeb;
  return c;
}
void main(){
  vec2 uv=vUv*2.0-1.0;uv.x*=uRes.x/uRes.y;
  float t=uT;
  float el=uEl+0.018*sin(t*0.21);
  float az=0.55+t*uOrbit;
  float roll=uRoll+0.045*sin(t*0.33);
  float cd=uCd;
  vec3 ro=vec3(cd*cos(el)*cos(az),cd*sin(el),cd*cos(el)*sin(az));
  vec3 fw=normalize(-ro);
  vec3 ri=normalize(cross(fw,vec3(0.0,1.0,0.0)));
  vec3 up=cross(ri,fw);
  float cr=cos(roll),sr=sin(roll);
  vec3 R=ri*cr+up*sr,U=up*cr-ri*sr;
  vec3 rd=normalize(fw*uZoom+uv.x*R+uv.y*U);
  vec3 pos=ro,vel=rd;
  float hh=dot(cross(pos,vel),cross(pos,vel));
  vec3 col=vec3(0.0);
  float trans=1.0;
  float fell=0.0;
  float gate=1.25*max(uThick,0.5);
  for(int i=0;i<220;i++){
    float r2=dot(pos,pos),r=sqrt(r2);
    if(r<1.02){fell=1.0;break;}
    if(r>62.0)break;
    float rr=length(pos.xz);
    float dt=0.085*min(r,6.0);
    if(rr<uDiskOut+1.0)dt=min(dt,max(0.040,abs(pos.y)*0.36));
    dt=max(dt,0.012);
    vec3 acc=-uMass*hh*pos/(r2*r2*r);
    vel+=acc*dt;pos+=vel*dt;
    rr=length(pos.xz);
    if(rr>2.95&&rr<uDiskOut&&abs(pos.y)<gate){
      float H=(0.024*rr+0.020)*uThick;
      float dens=exp(-pos.y*pos.y/(H*H));
      float edge=smoothstep(2.95,3.55,rr)*smoothstep(uDiskOut*0.969,uDiskOut*0.845,rr);
      float ang=atan(pos.z,pos.x)-0.7071*pow(rr,-1.5)*t*uSpin;
      vec2 q2=vec2(cos(ang),sin(ang))*rr;
      float big=fbm(q2*(0.90*uTurb)+vec2(rr*0.30));
      float fine=fbm(q2*(3.20*uTurb)+vec2(4.0));
      float rings=0.5+0.5*sin(log(rr)*20.0+big*7.0);
      float fac=0.03+1.30*big*big+0.55*rings*rings+0.24*fine;
      float T=pow(5.0/rr,0.90);
      float bri=0.24+1.40*T;
      vec3 dc=mix(uDiskCol,vec3(1.00,0.98,1.00),smoothstep(0.25,1.15,T));
      // sparse pale-warm wisps: a hue of the gas, not an additive highlight
      float wv=fbm(q2*2.30+vec2(9.0,2.0));
      float warm=smoothstep(0.62,0.80,wv)*(1.0-smoothstep(1.05,1.75,T));
      dc=mix(dc,vec3(1.00,0.86,0.58),warm*0.85);
      vec3 vdir=normalize(cross(vec3(0.0,1.0,0.0),pos));
      float beta=clamp(sqrt(0.5/rr)/sqrt(max(1.0-1.0/rr,0.10)),0.0,0.90);
      float gj=1.0/sqrt(max(1.0-beta*beta,0.02));
      float mu=dot(vdir*beta,-normalize(vel));
      float D=1.0/(gj*(1.0-mu));
      float shift=D*D*D*sqrt(max(1.0-1.0/rr,0.0));
      float bm=clamp(uBeam,0.0,1.0);
      shift=mix(1.0,shift,0.62*bm);
      vec3 tint=mix(vec3(1.0),vec3(0.62,0.74,1.30),clamp((D-1.0)*1.5,0.0,1.0)*bm);
      tint=mix(tint,vec3(1.20,0.88,0.70),clamp((1.0-D)*1.4,0.0,1.0)*bm);
      float a=dens*edge*fac;
      col+=dc*tint*a*bri*shift*trans*dt*2.30*uBright;
      float hz=exp(-pos.y*pos.y/(9.0*H*H));
      col+=vec3(0.30,0.21,0.66)*hz*edge*bri*shift*trans*dt*0.26*uBright;
      col+=vec3(1.00,0.84,0.52)*warm*dens*edge*trans*dt*0.55*shift*uBright;
      trans*=1.0-min(a*dt*2.10,0.86);
    }
  }
  if(fell<0.5)col+=skyCol(normalize(vel))*trans;
  col*=uExposure;
  col=col/(1.0+col*0.62);
  col=pow(max(col,0.0),vec3(0.93));
  vec2 q=vUv-0.5;
  col*=1.0-uVignette*dot(q,q);
  col+=(h1(gl_FragCoord.xy+fract(t)*37.0)-0.5)*uGrain;
  float g=dot(col,vec3(0.299,0.587,0.114));
  g=1.0-g;
  g=clamp((g-0.5)*1.18+0.5,0.0,1.0);
  gl_FragColor=vec4(vec3(pow(g,0.92)),1.0);
}`;

export function initBlackHole(canvas: HTMLCanvasElement) {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  } catch {
    return { setActive: () => {} };
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);

  const uniforms = {
    uT: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSeed: { value: 0.37 },
    uDiskCol: { value: new THREE.Vector3(0.45, 0.41, 0.9) },
    uMass: { value: 1.8 },
    uDiskOut: { value: 9.4 },
    uBright: { value: 1.15 },
    uSpin: { value: 7.4 },
    uTurb: { value: 2.09 },
    uThick: { value: 1.35 },
    uBeam: { value: 0.6 },
    uCd: { value: 16 },
    uZoom: { value: 1.4 },
    uRoll: { value: 0.26 },
    uOrbit: { value: 0.12 },
    uEl: { value: 0.13 },
    uStars: { value: 1.15 },
    uNeb: { value: 0.12 },
    uExposure: { value: 1.02 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.006 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: V,
    fragmentShader: F,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  const resize = () => {
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 600;
    const w = Math.max(320, Math.round(Math.min(1100, cssW)));
    const h = Math.max(320, Math.round(Math.min(1100, cssH)));
    renderer.setSize(w, h, false);
    uniforms.uRes.value.set(w, h);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  let active = false;
  let visible = true;
  let progress = 0;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  }).observe(canvas);

  const start = performance.now();
  const frame = () => {
    requestAnimationFrame(frame);
    if (!active || !visible || document.hidden) return;
    uniforms.uT.value = (performance.now() - start) / 1000;
    // 略微俯视 → 和吸积盘平齐；贴到 0 会变成一条线，留 0.02
    const t = Math.min(1, Math.max(0, (progress - 0.12) / 0.7));
    const e = t * t * (3 - 2 * t);
    uniforms.uEl.value = 0.3 + (0.02 - 0.3) * e;
    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);

  return {
    setActive(next: boolean) {
      active = next;
    },
    setProgress(next: number) {
      progress = next;
    },
  };
}
