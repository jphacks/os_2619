// Texture-backed fire, rendered in effects.js's HDR scene before its existing bloom/composite.
// All shapes are in world metres. Fixed particle indices + event age determine their motion.
import * as THREE from 'three';
import { fireTier, FIRE_TIERS, FIRE_LIFETIME, firePreviewSample } from './fire-profile.js';

const TAU = Math.PI * 2, CAP = 4096, STRIDE = 16;
// Keep the fire readable without covering as much of either player on the final video.
// This affects rendering only; projectile movement and gameplay collision stay unchanged.
const FIRE_VISUAL_SCALE = .82;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = v => Math.max(0, Math.min(1, v));
const rand = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const fade = (t, end, tail = .3) => clamp((end - t) / tail);
const blend = { transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
const VS = `
attribute vec4 iA, iB, iC, iD;
varying vec2 vUv; varying vec4 vData; varying vec3 vColor;
void main(){
  vec4 p=modelViewMatrix*vec4(iA.xyz,1.); vec2 c=position.xy;
  float a=iB.y;
  if(iD.w>0.5){vec2 d=(modelViewMatrix*vec4(iD.xyz,0.)).xy; if(length(d)>0.001)a=atan(d.y,d.x)-1.5707963;}
  c=mat2(cos(a),sin(a),-sin(a),cos(a))*(c*vec2(iA.w,iB.x));
  p.xy+=c; gl_Position=projectionMatrix*p;
  vUv=position.xy+.5; vData=vec4(iB.z,iB.w,iC.w,0.); vColor=iC.rgb;
}`;
const FS = `
uniform sampler2D uLobe,uTongue,uSmoke,uGlow,uSpark;
varying vec2 vUv; varying vec4 vData; varying vec3 vColor;
vec3 ramp(float h){vec3 c=mix(vec3(.7,.025,.002),vec3(1.,.27,.006),smoothstep(.08,.45,h));
 c=mix(c,vec3(1.,.78,.06),smoothstep(.35,.72,h));return mix(c,vec3(1.,.98,.73),smoothstep(.72,.98,h));}
void main(){
 float mode=vData.x; vec4 s;
 if(mode<.5)s=texture2D(uLobe,vUv); else if(mode<1.5)s=texture2D(uTongue,vUv);
 else if(mode<2.5)s=texture2D(uSmoke,vUv); else if(mode<3.5)s=texture2D(uGlow,vUv); else s=texture2D(uSpark,vUv);
 float a=s.a*vData.y; if(a<.008)discard;
 vec3 color; float occ;
 if(mode<.5){color=s.rgb*vColor;occ=.83;}
 else if(mode<1.5){color=ramp(s.r*.65+s.a*.35)*vColor;occ=.8;}
 else if(mode<2.5){color=vColor*(.55+.45*s.r);occ=.65;}
 else {color=vColor;occ=0.;}
 gl_FragColor=vec4(color*a*vData.z,a*occ);
}`;
const MVS = `varying vec3 vP,vN,vEye;void main(){vP=position;vec4 p=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vEye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`;
const MFS = `varying vec3 vP,vN,vEye;uniform vec3 uColor;uniform float uOpacity,uTime,uKind;
void main(){vec3 c=uColor;float a=uOpacity;
 if(uKind>.5){float n=.5+.19*sin(vP.x*11.+vP.y*8.-uTime*11.)+.15*sin(vP.z*16.-vP.y*9.+uTime*7.);
 float rim=pow(1.-abs(dot(normalize(vN),normalize(vEye))),1.8);
 if(uKind<1.5)c=mix(vec3(1.,.19,.004),vec3(1.,.97,.57),smoothstep(.12,.8,n+.25-rim*.4));
 else {c=mix(vec3(.48,.006,.001),vec3(1.,.19,.002),n);c=mix(c,vec3(1.,.72,.015),smoothstep(.55,.95,n+rim*.6));}
 }gl_FragColor=vec4(c*a*1.3,a*(uKind>.5?.94:.12));}`;

export function createFireEffects(scene, { onShake = () => {} } = {}) {
  const group = new THREE.Group(); group.name = 'texture-fire'; scene.add(group);
  const loader = new THREE.TextureLoader(), textures = [], loaded = [], errors = [];
  const load = (name, color = false) => {
    const t = loader.load(new URL('./assets/fire/' + name, import.meta.url).href, () => loaded.push(name), undefined,
      () => { errors.push(name); console.error('Fire texture could not be loaded:', name); });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    textures.push(t); return t;
  };
  const mat = new THREE.ShaderMaterial({ ...blend, vertexShader: VS, fragmentShader: FS, uniforms: {
    uLobe: { value: load('fire-lobe-v2.png', true) }, uTongue: { value: load('flame-tongue.png') },
    uSmoke: { value: load('smoke-puff.png') }, uGlow: { value: load('glow.png') }, uSpark: { value: load('spark.png') },
  } });
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0],3)); geo.setIndex([0,1,2,0,2,3]);
  const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(CAP * STRIDE), STRIDE).setUsage(THREE.DynamicDrawUsage);
  ['iA','iB','iC','iD'].forEach((n,i) => geo.setAttribute(n,new THREE.InterleavedBufferAttribute(buf,4,i*4)));
  const particles = new THREE.Mesh(geo,mat); particles.frustumCulled=false; particles.renderOrder=4; group.add(particles);
  const shape = new THREE.Shape(); [[-.45,.18],[.5,.02],[.01,.025],[.23,-.18],[-.5,-.025],[-.15,-.02]].forEach(([x,y],i) => i ? shape.lineTo(x,y) : shape.moveTo(x,y)); shape.closePath();
  const geometries = { bolt: new THREE.ExtrudeGeometry(shape,{depth:.055,bevelEnabled:false}), sphere: new THREE.SphereGeometry(1,24,16),
    ring: new THREE.TorusGeometry(1,.018,6,72), ray: new THREE.ConeGeometry(1,1,5) };
  const pools = {}, used = {}; let n=0, time=0, previewTime=0, sequence=0;
  const shots = new Map(), events = [], previews = [];
  const previewState = { paused: false, speed: 1, tier: null, age: 0 };
  const point=V(), dir=V(), up=V(), side=V(), basis=new THREE.Matrix4(), UP=V(0,1,0);

  function mesh(kind,p,scale,color,opacity=1,style=0,t=0){
    pools[kind]??=[];const idx=used[kind]??0;used[kind]=idx+1;
    let m=pools[kind][idx];if(!m){m=new THREE.Mesh(geometries[kind],new THREE.ShaderMaterial({...blend,vertexShader:MVS,fragmentShader:MFS,
      uniforms:{uColor:{value:new THREE.Color()},uOpacity:{value:1},uTime:{value:0},uKind:{value:0}}}));m.frustumCulled=false;group.add(m);pools[kind].push(m);}
    const scaled=Array.isArray(scale)?scale.map(v=>v*FIRE_VISUAL_SCALE):[scale*FIRE_VISUAL_SCALE,scale*FIRE_VISUAL_SCALE,scale*FIRE_VISUAL_SCALE];
    m.visible=true;m.position.copy(p);m.scale.set(...scaled);m.rotation.set(0,0,0);
    const u=m.material.uniforms;u.uColor.value.setRGB(...color);u.uOpacity.value=opacity;u.uKind.value=style;u.uTime.value=t;
    m.renderOrder=kind==='sphere'?1:6;return m;
  }
  function particle(mode,p,w,h,opacity=1,intensity=1,color=[1,1,1],rotation=0,axis=null){
    if(n>=CAP||opacity<=0)return;const o=n++*STRIDE,a=buf.array;
    a.set([p.x,p.y,p.z,w*FIRE_VISUAL_SCALE,h*FIRE_VISUAL_SCALE,rotation,mode,opacity,...color,intensity,axis?.x??0,axis?.y??0,axis?.z??0,axis?1:0],o);
  }
  const glow=(p,size,opacity=1,color=[1,.24,.008])=>particle(3,p,size,size,opacity,1.8,color);
  function ring(p,r,opacity,rotation=[0,0,0]) { const m=mesh('ring',p,r,[1,.38,.005],opacity);m.rotation.set(...rotation);return m; }
  function sparkCloud(p,t,count=24,size=1,seed=1){
    for(let i=0;i<count;i++){const j=i+seed*97,life=.25+rand(j+3)*.5;if(t<0||t>life)continue;
      const a=rand(j)*TAU,y=rand(j+1)*2-1,r=Math.sqrt(1-y*y),speed=(.7+rand(j+2)*2.5)*size;
      dir.set(Math.cos(a)*r,y,Math.sin(a)*r);point.copy(p).addScaledVector(dir,speed*t*FIRE_VISUAL_SCALE);point.y-=t*t*.65*FIRE_VISUAL_SCALE;
      particle(4,point,.025*size,(.10+speed*.035)*size,fade(t,life,.2),2.2,[1,.58,.06],0,dir);
    }
  }
  function head(tier,p,d,t,seed){
    if(tier==='small'){
      const m=mesh('bolt',p,[.48,.48,.48],[1,.93,.035],1);
      dir.copy(d).normalize();side.crossVectors(dir,UP);if(side.lengthSq()<.001)side.set(0,0,1);side.normalize();up.crossVectors(side,dir).normalize();
      basis.makeBasis(dir,up,side);m.quaternion.setFromRotationMatrix(basis);
      glow(p,.52,.5,[1,.67,.012]);
    }else{
      const m=mesh('sphere',p,[.22,.19,.19],[1,1,1],1,1,t);m.rotation.y=t*2;
      glow(p,.8,.45);
      for(let i=0;i<9;i++){const a=i*2.399+t*3,r=.14*FIRE_VISUAL_SCALE;point.copy(p).add(V(Math.cos(a)*r,Math.sin(a)*r,Math.sin(a*1.7)*r));
        particle(0,point,.31,.42,.82,1.25,[1,1,1],a);}
    }
  }
  function trail(s,t){
    if(s.tier==='small')return;
    // History is stored at a fixed 60 Hz sampling rate, independently of draw rate.
    for(let i=0;i<s.history.length;i++){const h=s.history[i],age=t-h.at;if(age<0||age>.38)continue;
      const j=i+s.seed*91,a=age/.38;point.copy(h.p);point.y+=age*(.35+rand(j)*.5)*FIRE_VISUAL_SCALE;point.z+=(rand(j+2)-.5)*age*.4*FIRE_VISUAL_SCALE;
      particle(0,point,.27*(1-a)+.10,.38*(1-a)+.15,Math.pow(1-a,1.3)*.8,1.2,[1,1,1],rand(j)*TAU);
    }
  }
  function impact(tier,p,t,seed){
    if(t<0||t>FIRE_LIFETIME[tier])return;
    if(tier==='small'){
      // Short flame-tongue particles keep the source texture's natural 2:3 aspect ratio.
      const end=FIRE_LIFETIME.small;
      for(let i=0;i<11;i++){const j=i+seed*31,born=i*.13,age=t-born,life=.4+rand(j)*.16;if(age<0||age>life)continue;
        const w=.2+rand(j+3)*.07+age*.025,h=w*1.5;
        point.copy(p);point.x+=(rand(j+1)-.5)*.18*FIRE_VISUAL_SCALE;point.z+=(rand(j+2)-.5)*.18*FIRE_VISUAL_SCALE;
        point.y+=h*FIRE_VISUAL_SCALE*.42+age*.08*FIRE_VISUAL_SCALE;
        particle(1,point,w,h,fade(age,life,.2)*fade(t,end),1.25,[1,1,1],(rand(j+4)-.5)*.22);
      }
      glow(p,.7,fade(t,end)*.45);sparkCloud(p,t,15,.6,seed);
      if(t>.65)for(let i=0;i<5;i++){const age=t-.65-i*.12;if(age<0)continue;point.copy(p);point.y+=(.16+age*.12)*FIRE_VISUAL_SCALE;point.x+=(rand(i+seed)-.5)*.28*FIRE_VISUAL_SCALE;
        const size=.15+age*.08;particle(2,point,size,size,fade(age,.8)*.28,.8,[.13,.08,.07],i);}
    }else if(tier==='medium'){
      // A compact Explosive Flame: a coherent fireball with rings and a short central flash.
      const impactScale=2,expand=1-Math.exp(-12*t),baseR=.05+expand*.17,r=baseR*impactScale,hold=fade(t,.72,.25);
      if(hold>0){const m=mesh('sphere',p,r,[1,1,1],hold,2,t);m.rotation.y=t*.65;
        for(let i=0;i<14;i++){const j=i+seed*23,y=1-2*(i+.5)/14,a=i*2.399+t,rr=Math.sqrt(1-y*y);point.copy(p).add(V(Math.cos(a)*rr,y,Math.sin(a)*rr).multiplyScalar(.14*expand*impactScale*FIRE_VISUAL_SCALE));
          particle(0,point,(.23+baseR*.2)*impactScale,(.27+baseR*.24)*impactScale,hold*.78,1.15,[1,1,1],rand(j)*TAU+t*.7);}
        for(let i=0;i<2;i++)ring(p,r*(1.02+i*.035),hold*.8,[i*.9+t*.9,i*.65,i*1.1]);
        glow(p,r*2.7,hold*.38);
      }
      if(t<.2){const f=fade(t,.2,.15);glow(p,.55*impactScale,f,[1,.85,.45]);
        for(let i=0;i<5;i++){const a=i*TAU/5+.35;dir.set(Math.cos(a),Math.sin(a),Math.sin(i*1.7)*.3).normalize();
          point.copy(p).addScaledVector(dir,.14*impactScale*FIRE_VISUAL_SCALE);const m=mesh('ray',point,[.018*impactScale,.32*impactScale,.018*impactScale],[1,.95,.65],f);m.quaternion.setFromUnitVectors(UP,dir);}
      }
      sparkCloud(p,t,14,.35*impactScale,seed);
    }else{
      // Explosive Flame: expand in place, a red-hot sphere, golden orbit rings and a brief central flash.
      const expand=1-Math.exp(-10*t),r=.12+expand*.95,hold=fade(t,1.35,.45);
      if(hold>0){const m=mesh('sphere',p,r,[1,1,1],hold,2,t);m.rotation.y=t*.4;
        for(let i=0;i<28;i++){const j=i+seed*61,y=1-2*(i+.5)/28,a=i*2.399+t*.7,rr=Math.sqrt(1-y*y);point.copy(p).add(V(Math.cos(a)*rr,y,Math.sin(a)*rr).multiplyScalar(r*.95*FIRE_VISUAL_SCALE));
          const pulse=.9+.1*Math.sin(t*24+j);particle(0,point,.40+r*.35,.44+r*.4,hold*.8,pulse*1.15,[1,1,1],rand(j)*TAU+t*.5);}
        for(let i=0;i<3;i++)ring(p,r*(1.02+i*.025),hold*.95,[i*.8+t*.6,i*.7, i*.95]);
        glow(p,r*3.0,hold*.4);
      }
      if(t<.3){const f=fade(t,.3,.23);glow(p,1.3,f,[1,.85,.45]);
        for(let i=0;i<7;i++){const a=i*TAU/7+.2;dir.set(Math.cos(a),Math.sin(a),Math.sin(i*1.9)*.35).normalize();
          point.copy(p).addScaledVector(dir,.40*FIRE_VISUAL_SCALE);const m=mesh('ray',point,[.035,.95,.035],[1,.95,.65],f);m.quaternion.setFromUnitVectors(UP,dir);}
      }
      sparkCloud(p,t,55,1.6,seed);
      for(let i=0;i<10;i++){const age=t-.7-i*.04;if(age<0)continue;const a=i*2.399;point.copy(p);point.x+=Math.cos(a)*.55*FIRE_VISUAL_SCALE;point.z+=Math.sin(a)*.55*FIRE_VISUAL_SCALE;point.y+=(.4+age*.8)*FIRE_VISUAL_SCALE;
        particle(2,point,.4+age*.45,.5+age*.5,fade(age,1)*.25,.8,[.16,.09,.07],i);}
    }
  }
  function addHit(tier,p,preview=false){const e={tier,p:p.clone(),at:preview?previewTime:time,seed:++sequence,preview};events.push(e);if(events.length>64)events.shift();onShake(tier==='large'?.65:.16);}
  return {
    shot(id,pos,d,power){const tier=fireTier(power);shots.set(id,{tier,p:pos.clone(),dir:d.clone().normalize(),seed:++sequence,history:[],next:time,at:time});},
    moveShot(id,p){const s=shots.get(id);if(!s)return;s.p.copy(p);if(time>=s.next){s.history.push({p:p.clone(),at:time});s.next=time+1/60;}},
    endShot(id){shots.delete(id);},
    hit(pos,power){addHit(fireTier(power),pos);},
    special(from,to){addHit('large',to);},
    preview(tier,from,to,getTarget=null){
      if(!FIRE_TIERS.includes(tier))return;
      previews.length=0;previewTime=0;previewState.paused=false;previewState.tier=tier;
      previews.push({tier,from:from.clone(),to:to.clone(),dir:to.clone().sub(from).normalize(),seed:++sequence,history:[],at:0,getTarget,impactPoint:null});
    },
    previewControl({paused,speed,step}={}){if(paused!==undefined)previewState.paused=!!paused;if(speed!==undefined)previewState.speed=clamp(speed);if(step){previewState.paused=true;previewTime+=Math.min(.1,Math.max(0,step));}},
    step(dt){
      time+=dt;if(!previewState.paused)previewTime+=dt*previewState.speed;previewState.age=previewTime;
      n=0;for(const k of Object.keys(used))used[k]=0;for(const pool of Object.values(pools))for(const m of pool)m.visible=false;
      for(const s of shots.values()){head(s.tier,s.p,s.dir,time-s.at,s.seed);s.history=s.history.filter(h=>time-h.at<.4);trail(s,time);}
      for(let i=events.length-1;i>=0;i--){const e=events[i],age=(e.preview?previewTime:time)-e.at;if(age>FIRE_LIFETIME[e.tier])events.splice(i,1);else impact(e.tier,e.p,age,e.seed);}
      for(const s of previews){const q=firePreviewSample(s.tier,previewTime);
        if(!previewState.paused&&!s.impactPoint&&s.getTarget){const p=s.getTarget();if(p)s.to.copy(p);s.dir.copy(s.to).sub(s.from).normalize();}
        if(!s.impactPoint&&q.impactAge>=0)s.impactPoint=s.to.clone();
        if(q.flying){const p=s.from.clone().lerp(s.to,q.progress);head(s.tier,p,s.dir,previewTime,s.seed);
          if(s.tier==='medium'){const history=[];for(let age=0;age<.38;age+=1/60){const born=previewTime-age;if(born<0)continue;history.push({p:s.from.clone().lerp(s.to,clamp(born/.46)),at:born});}trail({...s,history},previewTime);}}
        if(q.alive)impact(s.tier,s.impactPoint??s.to,q.impactAge,s.seed);}
      geo.instanceCount=n;buf.clearUpdateRanges();if(n){buf.addUpdateRange(0,n*STRIDE);buf.needsUpdate=true;}
      group.visible=n>0||Object.values(used).some(x=>x>0);
    },
    get active(){return group.visible;},
    stats(){return {particles:n,shots:shots.size,events:events.length,loaded:[...loaded],errors:[...errors],preview:{...previewState}};},
    dispose(){scene.remove(group);geo.dispose();mat.dispose();textures.forEach(t=>t.dispose());Object.values(geometries).forEach(g=>g.dispose());for(const p of Object.values(pools))for(const m of p)m.material.dispose();},
  };
}
