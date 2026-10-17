// Charging: rising body aura plus an element-coloured energy sphere at the wand tip.
import * as THREE from 'three';

const TAU=Math.PI*2,CAP=2048,STRIDE=16;
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const rand=i=>{const x=Math.sin(i*127.1+311.7)*43758.5453;return x-Math.floor(x);};
const blend={transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide,
  blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor};
const VS=`attribute vec4 iA,iB,iC,iD;varying vec2 vUv;varying vec4 vData;varying vec3 vColor;
void main(){vec4 p=modelViewMatrix*vec4(iA.xyz,1.);vec2 c=position.xy;float a=iB.y;
 if(iD.w>.5){vec2 d=(modelViewMatrix*vec4(iD.xyz,0.)).xy;if(length(d)>.001)a=atan(d.y,d.x)-1.5707963;}
 c=mat2(cos(a),sin(a),-sin(a),cos(a))*(c*vec2(iA.w,iB.x));p.xy+=c;gl_Position=projectionMatrix*p;
 vUv=position.xy+.5;vData=vec4(iB.z,iB.w,iC.w,0.);vColor=iC.rgb;}`;
const FS=`uniform sampler2D uAura,uPlasma,uElectric,uGlow,uSpark;varying vec2 vUv;varying vec4 vData;varying vec3 vColor;
void main(){float m=vData.x;vec4 s=m<.5?texture2D(uAura,vUv):m<1.5?texture2D(uPlasma,vUv):m<2.5?texture2D(uElectric,vUv):m<3.5?texture2D(uGlow,vUv):texture2D(uSpark,vUv);
 float a=s.a*vData.y;if(a<.008)discard;vec3 c=vColor*(.35+1.5*s.r)*vData.z;float occ=m<3.5?.16:0.;gl_FragColor=vec4(c*a,a*occ);}`;
const MVS=`varying vec3 vN,vEye;void main(){vec4 p=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vEye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`;
const MFS=`varying vec3 vN,vEye;uniform vec3 uColor;uniform float uOpacity;void main(){float rim=pow(1.-abs(dot(vN,vEye)),1.5);vec3 c=mix(uColor,vec3(1.),.35+rim*.35);gl_FragColor=vec4(c*uOpacity*1.7,uOpacity*.18);}`;

export function createChargeEffects(scene){
  const group=new THREE.Group();group.name='charge-effects';scene.add(group);
  const loader=new THREE.TextureLoader(),textures=[],loaded=[],errors=[];
  const load=name=>{const t=loader.load(new URL('./assets/charge/'+name,import.meta.url).href,()=>loaded.push(name),undefined,()=>errors.push(name));t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.colorSpace=THREE.NoColorSpace;textures.push(t);return t;};
  const mat=new THREE.ShaderMaterial({...blend,vertexShader:VS,fragmentShader:FS,uniforms:{uAura:{value:load('aura-wisp.png')},uPlasma:{value:load('plasma-flow.png')},uElectric:{value:load('electric-filament.png')},uGlow:{value:load('glow.png')},uSpark:{value:load('spark.png')}}});
  const geo=new THREE.InstancedBufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0],3));geo.setIndex([0,1,2,0,2,3]);
  const buf=new THREE.InstancedInterleavedBuffer(new Float32Array(CAP*STRIDE),STRIDE).setUsage(THREE.DynamicDrawUsage);['iA','iB','iC','iD'].forEach((name,i)=>geo.setAttribute(name,new THREE.InterleavedBufferAttribute(buf,4,i*4)));
  const particles=new THREE.Mesh(geo,mat);particles.frustumCulled=false;particles.renderOrder=5;group.add(particles);
  const geometries={sphere:new THREE.SphereGeometry(1,20,14),ring:new THREE.TorusGeometry(1,.018,6,64)};
  const pools={},used={},states=new Map();let n=0,time=0,sequence=0;
  const point=V(),axis=V();
  const colors={fire:[1,.22,.008],fireHot:[1,.82,.08],thunder:[1,.78,.02],thunderHot:[1,.97,.62]};

  function particle(mode,p,w,h,opacity,intensity,color,rotation=0,direction=null){if(n>=CAP||opacity<=0)return;const o=n++*STRIDE,a=buf.array;a.set([p.x,p.y,p.z,w,h,rotation,mode,opacity,...color,intensity,direction?.x??0,direction?.y??0,direction?.z??0,direction?1:0],o);}
  function mesh(kind,p,scale,color,opacity=1){pools[kind]??=[];const idx=used[kind]??0;used[kind]=idx+1;let m=pools[kind][idx];if(!m){m=new THREE.Mesh(geometries[kind],new THREE.ShaderMaterial({...blend,vertexShader:MVS,fragmentShader:MFS,uniforms:{uColor:{value:new THREE.Color()},uOpacity:{value:1}}}));m.frustumCulled=false;group.add(m);pools[kind].push(m);}m.visible=true;m.position.copy(p);m.scale.set(...(Array.isArray(scale)?scale:[scale,scale,scale]));m.rotation.set(0,0,0);m.material.uniforms.uColor.value.setRGB(...color);m.material.uniforms.uOpacity.value=opacity;return m;}
  function renderState(s){const L=s.level,pulse=1+(L>=.999?.1*Math.sin(time*20+s.seed):.025*Math.sin(time*9+s.seed));const col=colors[s.element],hot=colors[s.element+'Hot'];
    const count=14+Math.round(14*L);for(let i=0;i<count;i++){const q=(time*(.34+.12*L)+rand(s.seed*97+i*13))%1,a=i*2.399+s.seed,r=.22+rand(i+s.seed*7)*(.16+.08*L);point.set(s.chest.x+Math.cos(a)*r,s.chest.y-1.05+q*1.75,s.chest.z+Math.sin(a)*r);const edge=Math.min(1,q/.12,(1-q)/.18);particle(0,point,.14+.09*L,.48+.25*L,edge*(.28+.45*L),1.25,col,(rand(i+s.seed)-.5)*.28);}
    point.copy(s.chest);point.y-=.15;particle(3,point,.9+.35*L,1.8+.35*L,.13+.2*L,1.4,col);
    const radius=(.07+.18*L)*pulse;mesh('sphere',s.tip,radius,hot,.92);particle(3,s.tip,(.24+.5*L)*pulse,(.24+.5*L)*pulse,.38+.4*L,1.8,col);
    const patches=6+Math.round(7*L);for(let i=0;i<patches;i++){const y=1-2*(i+.5)/patches,a=i*2.399+time*(s.element==='fire'?1.6:2.6),rr=Math.sqrt(1-y*y),r=radius*(.75+rand(i+s.seed)*.35);point.copy(s.tip).add(V(Math.cos(a)*rr*r,y*r,Math.sin(a)*rr*r));axis.copy(point).sub(s.tip).normalize();particle(s.element==='fire'?1:2,point,.16+.14*L,.2+.16*L,.55+.35*L,1.55,hot,a,axis);}
    for(let i=0;i<2;i++){const ring=mesh('ring',s.tip,radius*(1.15+i*.18),hot,.48+.32*L);ring.rotation.set(i*.9+time*.7,i*.65-time*.5,i*.4);}
    const sparks=5+Math.round(11*L);for(let i=0;i<sparks;i++){const a=i*2.399+time*(2.2+rand(i+s.seed)),y=Math.sin(i*1.7+time*1.4)*.6,r=radius*(1.2+.8*rand(i+s.seed*3));axis.set(Math.cos(a),y,Math.sin(a)).normalize();point.copy(s.tip).addScaledVector(axis,r);particle(4,point,.014,.07+.05*L,.45+.4*L,2.1,hot,0,axis);}
    if(L>=.999){const phase=(time*1.7+s.seed)%1;const ring=mesh('ring',s.tip,.22+.48*phase,hot,(1-phase)*.7);ring.rotation.set(Math.PI/2,0,time);}
  }
  return{
    request(element,chest,tip,level,key=element){let s=states.get(key);if(!s){s={element,chest:V(),tip:V(),level:0,seen:0,seed:++sequence};states.set(key,s);}s.element=element;s.chest.copy(chest);s.tip.copy(tip);s.level=Math.max(0,Math.min(1,level));s.seen=time;},
    step(dt){time+=dt;n=0;for(const k of Object.keys(used))used[k]=0;for(const pool of Object.values(pools))for(const m of pool)m.visible=false;for(const [key,s] of states){if(time-s.seen>.18){states.delete(key);continue;}renderState(s);}geo.instanceCount=n;buf.clearUpdateRanges();if(n){buf.addUpdateRange(0,n*STRIDE);buf.needsUpdate=true;}group.visible=n>0||Object.values(used).some(v=>v>0);},
    get active(){return group.visible;},stats(){return{states:states.size,particles:n,loaded:[...loaded],errors:[...errors]};},
    dispose(){scene.remove(group);geo.dispose();mat.dispose();textures.forEach(t=>t.dispose());Object.values(geometries).forEach(g=>g.dispose());for(const pool of Object.values(pools))for(const m of pool)m.material.dispose();},
  };
}
