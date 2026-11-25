/*
 * 黑洞 · 引力透镜 —— three.js 生成器（`black-hole-three`）。
 *
 * 来自 2027 新春会复核工程 artmatic-programs/three-js-test 的那条黑洞片段，原样搬过来：
 * 一个全屏 quad + 手写着色器，每像素一条射线在施瓦西时空里按测地线积分，体积吸积盘
 * 沿路径累积辐射。**默认值是那条片段里调好的那一组**，不是 params() 最初写的那组。
 *
 * 这个文件是 raw 文本（`?raw` 导入），不参与 TS 编译：它会被 `new Function` 执行，
 * 与片段里手写的内容同一形态（契约见 src/three/code.ts）。
 */
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
  for(int i=0;i<320;i++){
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
  gl_FragColor=vec4(col,1.0);
}`;
function params(){
  return [
    {key:'mass',type:'range',label:'引力强度 (测地线弯曲)',min:0.2,max:4,step:0.05,defaultValue:1.8},
    {key:'diskOut',type:'range',label:'吸积盘外径',min:5,max:22,step:0.1,defaultValue:10.7},
    {key:'bright',type:'range',label:'盘亮度',min:0,max:3,step:0.01,defaultValue:1.21},
    {key:'diskCol',type:'color',label:'盘主色',defaultValue:'#7369e7'},
    {key:'spin',type:'range',label:'盘自转速度',min:0,max:10,step:0.1,defaultValue:8.2},
    {key:'turb',type:'range',label:'湍流尺度',min:0.2,max:3,step:0.01,defaultValue:2.09},
    {key:'thick',type:'range',label:'盘厚度',min:0.2,max:2.5,step:0.01,defaultValue:1.22},
    {key:'doppler',type:'range',label:'多普勒增亮',min:0,max:1,step:0.01,defaultValue:1},
    {key:'camDist',type:'range',label:'机位距离',min:7,max:32,step:0.1,defaultValue:13.2},
    {key:'zoom',type:'range',label:'焦距',min:0.8,max:3.5,step:0.01,defaultValue:2.12},
    {key:'roll',type:'range',label:'机位翻滚',min:-0.8,max:0.8,step:0.005,defaultValue:0.255},
    {key:'orbit',type:'range',label:'环绕速度',min:0,max:0.4,step:0.002,defaultValue:0.176},
    {key:'stars',type:'range',label:'星野亮度',min:0,max:3,step:0.01,defaultValue:0.99},
    {key:'nebula',type:'range',label:'星云',min:0,max:3,step:0.01,defaultValue:1.1},
    {key:'exposure',type:'range',label:'曝光',min:0.2,max:2.5,step:0.01,defaultValue:1},
    {key:'vignette',type:'range',label:'暗角',min:0,max:1,step:0.01,defaultValue:0.42},
    {key:'grain',type:'range',label:'颗粒',min:0,max:0.06,step:0.001,defaultValue:0.014}
  ];
}
function hexv(h){const n=parseInt(String(h||'#ffffff').replace('#',''),16);const v=isNaN(n)?0xffffff:n;return [((v>>16)&255)/255,((v>>8)&255)/255,(v&255)/255];}
function create(THREE,ctx){
  const scene=new THREE.Scene();
  const cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const c0=hexv(ctx.params&&ctx.params.diskCol);
  const u={
    uT:{value:0},uRes:{value:new THREE.Vector2(ctx.width,ctx.height)},uSeed:{value:(ctx.seed%997)/997},
    uDiskCol:{value:new THREE.Vector3(c0[0],c0[1],c0[2])},
    uMass:{value:1.5},uDiskOut:{value:13},uBright:{value:1},uSpin:{value:3},uTurb:{value:1},uThick:{value:1},
    uBeam:{value:1},uCd:{value:16.5},uZoom:{value:1.85},uRoll:{value:0.255},uOrbit:{value:0.055},uEl:{value:0.125},
    uStars:{value:1},uNeb:{value:1},uExposure:{value:1},uVignette:{value:0.5},uGrain:{value:0.01}
  };
  const mat=new THREE.ShaderMaterial({uniforms:u,depthTest:false,depthWrite:false,vertexShader:V,fragmentShader:F});
  const q=new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat);q.frustumCulled=false;scene.add(q);
  function sync(){
    const p=ctx.params||{};
    const g=(k,d)=>(p[k]===undefined||p[k]===null)?d:p[k];
    u.uMass.value=g('mass',1.5);u.uDiskOut.value=g('diskOut',13);u.uBright.value=g('bright',1);
    u.uSpin.value=g('spin',3);u.uTurb.value=g('turb',1);u.uThick.value=g('thick',1);
    u.uBeam.value=g('doppler',1);u.uCd.value=g('camDist',16.5);u.uZoom.value=g('zoom',1.85);
    u.uRoll.value=g('roll',0.255);u.uOrbit.value=g('orbit',0.055);u.uStars.value=g('stars',1);
    u.uNeb.value=g('nebula',1);u.uExposure.value=g('exposure',1);u.uVignette.value=g('vignette',0.5);
    u.uGrain.value=g('grain',0.01);
    const cc=hexv(g('diskCol','#7057ff'));
    u.uDiskCol.value.set(cc[0],cc[1],cc[2]);
  }
  sync();
  return {scene,camera:cam,update(t){sync();u.uT.value=t;},resize(w,h){u.uRes.value.set(w,h);}};
}
