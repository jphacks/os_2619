// Texture-backed electric attacks. Main bolts are real 3D segments; PNGs add sharp local detail.
import * as THREE from 'three';
import { THUNDER_TIERS, THUNDER_LIFETIME, thunderTier, thunderPreviewSample } from './thunder-profile.js';

const TAU=Math.PI*2,CAP=3072,STRIDE=16;
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const clamp=v=>Math.max(0,Math.min(1,v));
const rand=i=>{const x=Math.sin(i*127.1+311.7)*43758.5453;return x-Math.floor(x);};
const fade=(t,end,tail=.25)=>clamp((end-t)/tail);
const blend={transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide,
  blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor};
const VS=`
attribute vec4 iA,iB,iC,iD;varying vec2 vUv;varying vec4 vData;varying vec3 vColor;
void main(){vec4 p=modelViewMatrix*vec4(iA.xyz,1.);vec2 c=position.xy;float a=iB.y;
 if(iD.w>.5){vec2 d=(modelViewMatrix*vec4(iD.xyz,0.)).xy;if(length(d)>.001)a=atan(d.y,d.x);}
 c=mat2(cos(a),sin(a),-sin(a),cos(a))*(c*vec2(iA.w,iB.x));p.xy+=c;gl_Position=projectionMatrix*p;
 vUv=position.xy+.5;vData=vec4(iB.z,iB.w,iC.w,0.);vColor=iC.rgb;}`;
const FS=`
uniform sampler2D uArc,uBurst,uGlow,uSpark;varying vec2 vUv;varying vec4 vData;varying vec3 vColor;
void main(){float m=vData.x;vec4 s=m<.5?texture2D(uArc,vUv):m<1.5?texture2D(uBurst,vUv):m<2.5?texture2D(uGlow,vUv):texture2D(uSpark,vUv);
 float a=s.a*vData.y;if(a<.008)discard;vec3 c=vColor*(.45+1.35*s.r)*vData.z;float occ=m<2.5?.18:0.;gl_FragColor=vec4(c*a,a*occ);}`;
const MVS=`varying vec3 vN,vEye;void main(){vec4 p=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vEye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`;
const MFS=`varying vec3 vN,vEye;uniform vec3 uColor;uniform float uOpacity;void main(){float rim=pow(1.-abs(dot(vN,vEye)),1.6);vec3 c=mix(uColor,vec3(1.,.98,.68),.45+rim*.35);gl_FragColor=vec4(c*uOpacity*1.8,uOpacity*.16);}`;

export function createThunderEffects(scene,{onShake=()=>{}}={}){
  const group=new THREE.Group();group.name='texture-thunder';scene.add(group);
  const loader=new THREE.TextureLoader(),textures=[],loaded=[],errors=[];
  const load=name=>{const t=loader.load(new URL('./assets/thunder/'+name,import.meta.url).href,()=>loaded.push(name),undefined,
    ()=>{errors.push(name);console.error('Thunder texture could not be loaded:',name);});t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.colorSpace=THREE.NoColorSpace;textures.push(t);return t;};
  const mat=new THREE.ShaderMaterial({...blend,vertexShader:VS,fragmentShader:FS,uniforms:{
    uArc:{value:load('electric-arc-v2.png')},uBurst:{value:load('electric-burst-v2.png')},
    uGlow:{value:load('glow.png')},uSpark:{value:load('spark.png')},
  }});
  const geo=new THREE.InstancedBufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0],3));geo.setIndex([0,1,2,0,2,3]);
  const buf=new THREE.InstancedInterleavedBuffer(new Float32Array(CAP*STRIDE),STRIDE).setUsage(THREE.DynamicDrawUsage);
  ['iA','iB','iC','iD'].forEach((name,i)=>geo.setAttribute(name,new THREE.InterleavedBufferAttribute(buf,4,i*4)));
  const particles=new THREE.Mesh(geo,mat);particles.frustumCulled=false;particles.renderOrder=5;group.add(particles);
  const geometries={segment:new THREE.CylinderGeometry(1,1,1,6,1,false),sphere:new THREE.SphereGeometry(1,18,12)};
  const pools={},used={};let n=0,time=0,previewTime=0,sequence=0;
  const shots=new Map(),events=[],previews=[];
  const previewState={paused:false,speed:1,tier:null,age:0};
  const point=V(),dir=V(),side=V(),up=V(),mid=V(),UP=V(0,1,0);

  function mesh(kind,p,scale,color,opacity=1){pools[kind]??=[];const idx=used[kind]??0;used[kind]=idx+1;let m=pools[kind][idx];
    if(!m){m=new THREE.Mesh(geometries[kind],new THREE.ShaderMaterial({...blend,vertexShader:MVS,fragmentShader:MFS,uniforms:{uColor:{value:new THREE.Color()},uOpacity:{value:1}}}));m.frustumCulled=false;group.add(m);pools[kind].push(m);}
    m.visible=true;m.position.copy(p);m.scale.set(...(Array.isArray(scale)?scale:[scale,scale,scale]));m.rotation.set(0,0,0);m.material.uniforms.uColor.value.setRGB(...color);m.material.uniforms.uOpacity.value=opacity;m.renderOrder=3;return m;
  }
  function particle(mode,p,w,h,opacity=1,intensity=1,color=[1,.82,.03],rotation=0,axis=null){if(n>=CAP||opacity<=0)return;const o=n++*STRIDE,a=buf.array;
    a.set([p.x,p.y,p.z,w,h,rotation,mode,opacity,...color,intensity,axis?.x??0,axis?.y??0,axis?.z??0,axis?1:0],o);
  }
  const glow=(p,size,opacity=1,color=[1,.78,.02])=>particle(2,p,size,size,opacity,1.8,color);
  function segment(a,b,w,opacity,color=[1,.78,.015]){dir.copy(b).sub(a);const len=dir.length();if(len<1e-4)return;mid.copy(a).add(b).multiplyScalar(.5);
    const outer=mesh('segment',mid,[w*2.3,len,w*2.3],color,opacity*.45);outer.quaternion.setFromUnitVectors(UP,dir.normalize());
    const core=mesh('segment',mid,[w*.72,len,w*.72],[1,1,.72],opacity);core.quaternion.copy(outer.quaternion);
  }
  function bolt(a,b,seed,jag=.2,w=.025,opacity=1,branches=.15){dir.copy(b).sub(a);const len=dir.length();if(len<1e-4)return;dir.normalize();side.crossVectors(dir,UP);if(side.lengthSq()<.01)side.set(1,0,0);side.normalize();up.crossVectors(side,dir).normalize();
    const count=9,pts=[];for(let i=0;i<count;i++){const u=i/(count-1),env=Math.sin(Math.PI*u);point.copy(a).lerp(b,u);if(i&&i<count-1)point.addScaledVector(side,(rand(seed+i*7)-.5)*jag*env).addScaledVector(up,(rand(seed+i*11+2)-.5)*jag*env);pts.push(point.clone());}
    for(let i=1;i<pts.length;i++)segment(pts[i-1],pts[i],w*(1-i/count*.25),opacity);
    for(let i=2;i<count-1;i+=3)if(rand(seed+i*19)<branches){const ang=rand(seed+i*23)*TAU,bl=.16+rand(seed+i*29)*.22;point.copy(pts[i]).addScaledVector(side,Math.cos(ang)*bl).addScaledVector(up,Math.sin(ang)*bl);segment(pts[i],point,w*.45,opacity*.7);}
  }
  function sparks(p,t,count,size,seed){for(let i=0;i<count;i++){const j=seed*83+i,life=.18+rand(j+3)*.28;if(t<0||t>life)continue;const z=rand(j)*2-1,a=rand(j+1)*TAU,r=Math.sqrt(1-z*z),speed=(.5+rand(j+2)*1.7)*size;
    dir.set(Math.cos(a)*r,z,Math.sin(a)*r);point.copy(p).addScaledVector(dir,speed*t);particle(3,point,.018*size,(.08+speed*.05)*size,fade(t,life,.12),2.4,[1,.9,.12],0,dir);}}
  function head(tier,p,d,t,seed){if(tier==='small'){particle(0,p,.45,.16,1,1.55,[1,.84,.02],0,d);glow(p,.38,.55);}
    else{const m=mesh('sphere',p,.15,[1,.86,.03],1);m.rotation.y=t*4;glow(p,.58,.65);particle(0,p,.5,.18,.9,1.5,[1,.82,.015],0,d);
      for(let i=0;i<3;i++){const a=i*TAU/3+t*5;point.copy(p).add(V(Math.cos(a)*.08,Math.sin(a)*.08,Math.sin(a*1.7)*.06));dir.set(Math.cos(a),Math.sin(a),Math.sin(a*1.7)).normalize();particle(0,point,.27,.095,.7,1.4,[1,.9,.08],0,dir);}}
  }
  function trail(s,t){if(s.tier!=='medium')return;for(let i=0;i<s.history.length;i++){const h=s.history[i],age=t-h.at;if(age<0||age>.28)continue;const f=1-age/.28;particle(0,h.p,.25*f+.08,.075*f+.025,f*.55,1.2,[1,.78,.015],rand(i+s.seed)*.5,s.dir);}}
  function impact(tier,p,t,seed){if(t<0||t>THUNDER_LIFETIME[tier])return;
    if(tier==='small'){const f=fade(t,.42,.24);particle(1,p,.42,.42,f,1.8,[1,.88,.05],t*3);glow(p,.55,fade(t,.18)*.85);if(t<.32)for(let i=0;i<6;i++){const a=i*TAU/6+rand(seed)*.4;point.copy(p).add(V(Math.cos(a)*.27,(i%2?1:-1)*.11,Math.sin(a)*.27));bolt(p,point,seed+i*17+Math.floor(t*20)*101,.05,.014,f,.1);}sparks(p,t,14,.65,seed);
    }else if(tier==='medium'){const f=fade(t,.62,.3);const k=1-Math.exp(-12*t),r=.2+.16*k;const m=mesh('sphere',p,r*.42,[1,.86,.02],f);m.rotation.y=t*5;particle(1,p,.62,.62,f,1.9,[1,.84,.015],t*2);glow(p,.78,fade(t,.28)*.9);
      if(t<.46)for(let i=0;i<10;i++){const a=i*TAU/10+rand(seed)*.3,z=(i%3-1)*.22;point.copy(p).add(V(Math.cos(a)*r,z,Math.sin(a)*r));bolt(p,point,seed+i*31+Math.floor(t*18)*97,.07,.017,f,.18);}sparks(p,t,26,.9,seed);
    }else{const strike=fade(t,.38,.2),frame=Math.floor(t*18),sky=V(p.x+(rand(seed)-.5)*.45,p.y+4.6,p.z+(rand(seed+1)-.5)*.45);
      if(strike>0){bolt(sky,p,seed+frame*137,.34,.07,strike,.42);bolt(sky.clone().lerp(p,.28),p,seed+frame*137+51,.48,.026,strike*.75,.28);}
      const burst=fade(t,.72,.35);particle(1,p,.95,.95,burst,2.2,[1,.86,.02],t*2.4);glow(p,1.25,fade(t,.22)*1.05,[1,.9,.18]);
      if(t<.42)for(let i=0;i<12;i++){const a=i*TAU/12+rand(seed+2)*.2,z=(i%3-1)*.28;point.copy(p).add(V(Math.cos(a)*(.48+rand(seed+i)*.18),z,Math.sin(a)*(.48+rand(seed+i)*.18)));bolt(p,point,seed+i*43+frame*79,.1,.022,strike,.2);}sparks(p,t,52,1.35,seed);
    }
  }
  function addHit(tier,p,preview=false){events.push({tier,p:p.clone(),at:preview?previewTime:time,seed:++sequence,preview});if(events.length>64)events.shift();onShake(tier==='large'?.75:tier==='medium'?.25:.12);}
  return{
    shot(id,pos,d,power){const tier=thunderTier(power);shots.set(id,{tier,p:pos.clone(),dir:d.clone().normalize(),seed:++sequence,history:[],next:time,at:time});},
    moveShot(id,p){const s=shots.get(id);if(!s)return;s.p.copy(p);if(time>=s.next){s.history.push({p:p.clone(),at:time});s.next=time+1/60;}},
    endShot(id){shots.delete(id);},hit(pos,power){addHit(thunderTier(power),pos);},special(from,to){addHit('large',to);},
    preview(tier,from,to,getTarget=null){if(!THUNDER_TIERS.includes(tier))return;previews.length=0;previewTime=0;previewState.paused=false;previewState.tier=tier;previews.push({tier,from:from.clone(),to:to.clone(),dir:to.clone().sub(from).normalize(),seed:++sequence,getTarget,impactPoint:null});},
    previewControl({paused,speed,step}={}){if(paused!==undefined)previewState.paused=!!paused;if(speed!==undefined)previewState.speed=clamp(speed);if(step){previewState.paused=true;previewTime+=Math.min(.1,Math.max(0,step));}},
    step(dt){time+=dt;if(!previewState.paused)previewTime+=dt*previewState.speed;previewState.age=previewTime;n=0;for(const k of Object.keys(used))used[k]=0;for(const pool of Object.values(pools))for(const m of pool)m.visible=false;
      for(const s of shots.values()){head(s.tier,s.p,s.dir,time-s.at,s.seed);s.history=s.history.filter(h=>time-h.at<.3);trail(s,time);}
      for(let i=events.length-1;i>=0;i--){const e=events[i],age=(e.preview?previewTime:time)-e.at;if(age>THUNDER_LIFETIME[e.tier])events.splice(i,1);else impact(e.tier,e.p,age,e.seed);}
      for(const s of previews){const q=thunderPreviewSample(s.tier,previewTime);if(!previewState.paused&&!s.impactPoint&&s.getTarget){const p=s.getTarget();if(p)s.to.copy(p);s.dir.copy(s.to).sub(s.from).normalize();}if(!s.impactPoint&&q.impactAge>=0)s.impactPoint=s.to.clone();
        if(q.flying){const p=s.from.clone().lerp(s.to,q.progress);head(s.tier,p,s.dir,previewTime,s.seed);if(s.tier==='medium'){const history=[];for(let age=0;age<.28;age+=1/60){const born=previewTime-age;if(born<0)continue;history.push({p:s.from.clone().lerp(s.to,clamp(born/.46)),at:born});}trail({...s,history},previewTime);}}
        if(q.alive)impact(s.tier,s.impactPoint??s.to,q.impactAge,s.seed);}
      geo.instanceCount=n;buf.clearUpdateRanges();if(n){buf.addUpdateRange(0,n*STRIDE);buf.needsUpdate=true;}group.visible=n>0||Object.values(used).some(x=>x>0);
    },
    get active(){return group.visible;},stats(){return{particles:n,shots:shots.size,events:events.length,loaded:[...loaded],errors:[...errors],preview:{...previewState}};},
    dispose(){scene.remove(group);geo.dispose();mat.dispose();textures.forEach(t=>t.dispose());Object.values(geometries).forEach(g=>g.dispose());for(const pool of Object.values(pools))for(const m of pool)m.material.dispose();},
  };
}
