# Builds public/assets/models/chaoben.glb (チャオベン, the special character) from AccuRig's chaoben_rigged.fbx and the photo the model was made from (chaoben_body.jpg).
#   blender --background --factory-startup --python tools/build-chaoben-model.py -- <dir with the sources> <out.glb> [triangles]
# The source: 97 k triangles in an A-pose (the photo's), 101 bones from AccuRig, no texture (its image was not kept). What the game uses:
#   - welded (the three crumbs dropped) and decimated, scaled to H tall, soles at 0.
#   - AccuRig's skeleton cut to about 20 bones, named as in wizard.glb (Hip, Waist, Spine01, Spine02, Neck, Head, L_/R_ Clavicle Upperarm Forearm Hand
#     Thigh Calf Foot); the weights of the bones dropped (twists, fingers, toes, face, breasts) go to the nearest kept one up the chain. The head and the
#     hair on it are put on the head alone, so the hair does not stretch with the neck.
#   - the look is the photo itself, projected from the front (the mesh was made from it and matches its silhouette): 'body' (the whole photo, half size),
#     'face' (the head's front, a full-size crop) and 'hair' (one colour, chaobenmodel.js: the head's back and sides, which the photo does not show).
#     Both images are embedded in the glb.
import bpy, bmesh, os, sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = args[0], args[1]
TRIS = int(args[2]) if len(args) > 2 else 16000
H = 1.73                      # the model's height, m (soles to the top of the hair): the photo's scale below is per this metre
PHOTO = os.path.join(SRC, 'chaoben_body.jpg')
PX_M, PX_X0, PX_Y0 = 1163.6, 848.5, 2410  # the photo: pixels per metre, the body's centre line, the soles (measured off its silhouette)
CROP = (690, 380, 1010, 780)  # the head in the photo (x0, y0, x1, y1), kept as the face's texture
HEAD_Z = 1.50                 # above this (m at H) all is the head's

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, 'chaoben_rigged.fbx'))
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ob = next(o for o in bpy.data.objects if o.type == 'MESH'); me = ob.data
ob.shape_key_clear(); arm.animation_data_clear()
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
def apply():
    bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active = arm
    for o in (arm, ob): o.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
apply()
z0 = min(v.co.z for v in me.vertices); k = H / (max(v.co.z for v in me.vertices) - z0)
arm.scale = (k, k, k); arm.location.z = -z0 * k; bpy.context.view_layer.update(); apply()
while me.uv_layers: me.uv_layers.remove(me.uv_layers[0])
me.materials.clear()

# ---- the bones: only those that move something; the weights of the rest go up the chain
KEEP = {'CC_Base_Hip': 'Hip', 'CC_Base_Waist': 'Waist', 'CC_Base_Spine01': 'Spine01', 'CC_Base_Spine02': 'Spine02', 'CC_Base_NeckTwist01': 'Neck', 'CC_Base_Head': 'Head'}
for s in 'LR':
    for b in ('Clavicle', 'Upperarm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot'): KEEP[f'CC_Base_{s}_{b}'] = f'{s}_{b}'
def kept(name):
    b = arm.data.bones.get(name)
    while b and b.name not in KEEP: b = b.parent
    return KEEP[b.name] if b else 'Hip'
old = {g.index: g.name for g in ob.vertex_groups}
weights = []
for v in me.vertices:
    d = {}
    for g in v.groups:
        n = kept(old[g.group]); d[n] = d.get(n, 0) + g.weight
    if v.co.z > HEAD_Z: d = {'Head': 1}
    weights.append({n: w for n, w in d.items() if w > 1e-3} or {'Hip': 1})
for g in list(ob.vertex_groups): ob.vertex_groups.remove(g)
groups = {}
for i, d in enumerate(weights):
    for n, w in d.items():
        if n not in groups: groups[n] = ob.vertex_groups.new(name=n)
        groups[n].add([i], w, 'REPLACE')
bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
def kept_parent(b):
    p = b.parent
    while p and p.name not in KEEP: p = p.parent
    return p
for b in list(eb):
    if b.name in KEEP: b.use_connect = False; b.parent = kept_parent(b)
for b in list(eb):
    if b.name not in KEEP: eb.remove(b)
for b in eb: b.name = KEEP[b.name]
bpy.ops.object.mode_set(mode='OBJECT')
print('bones', [b.name for b in arm.data.bones])

# ---- weld (4 islands: the body and three crumbs, dropped), decimate
bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.verts.ensure_lookup_table(); seen, islands = set(), []
for v in bm.verts:
    if v.index in seen: continue
    st, isl = [v], [v]; seen.add(v.index)
    while st:
        a = st.pop()
        for e in a.link_edges:
            b = e.other_vert(a)
            if b.index not in seen: seen.add(b.index); st.append(b); isl.append(b)
    islands.append(isl)
for isl in islands:
    if len(isl) < 1000: bmesh.ops.delete(bm, geom=isl, context='VERTS')
bm.to_mesh(me); bm.free()
dm = ob.modifiers.new('d', 'DECIMATE'); dm.ratio = min(1, TRIS / sum(len(p.vertices) - 2 for p in me.polygons))
ob.modifiers.move(ob.modifiers.find('d'), 0)
bpy.ops.object.modifier_apply(modifier='d')
bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3]); bm.to_mesh(me); bm.free()
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
print('decimated', len(me.vertices), 'verts', len(me.polygons), 'tris')

# ---- the look: the photo, projected from the front onto everything but the hair at the head's sides and back
#   'body': the whole photo (its background filled with the nearest body colour, so a face at the silhouette's edge takes the body's, not the wall's)
#   'face': the head's front, in a sharper crop of the same photo; 'hair': one colour, where the photo only shows the face
import numpy as np
img = bpy.data.images.load(PHOTO); W, Hp = img.size
P = np.array(img.pixels[:], dtype=np.float32).reshape(Hp, W, 4)[::-1, :, :3].copy() # rows from the top
known = ~((P.min(2) > .62) & (P.max(2) - P.min(2) < .07)) # the wall: light and grey (its shading too)
known[:, :40] = known[:, -40:] = False; known[-60:] = False # the photo's frame and the floor's shadow
for _ in range(4): known &= np.roll(known, 1, 0) & np.roll(known, -1, 0) & np.roll(known, 1, 1) & np.roll(known, -1, 1) # drop the edge's halo, half wall
def fill(a, k, steps):
    a = a.copy(); k = k.copy()
    for _ in range(steps):
        acc = np.zeros_like(a); cnt = np.zeros(k.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ks = np.roll(k, (dy, dx), (0, 1)); acc += np.roll(a, (dy, dx), (0, 1)) * ks[..., None]; cnt += ks
        new = ~k & (cnt > 0); a[new] = acc[new] / cnt[new][:, None]; k |= new
    a[~k] = a[k].mean(0); return a
def image(name, a):
    h, w = a.shape[:2]; im = bpy.data.images.new(name, w, h)
    im.pixels.foreach_set(np.concatenate([a[::-1], np.ones((h, w, 1), np.float32)], 2).ravel()); im.file_format = 'JPEG'
    return im
BODY = (40, 360, 1660, 2420) # x0 y0 x1 y1 in the photo
x0, y0, x1, y1 = BODY; step = 2 # half size for the body
body = fill(P[y0:y1:step, x0:x1:step], known[y0:y1:step, x0:x1:step], 60)
x0f, y0f, x1f, y1f = CROP
face = fill(P[y0f:y1f, x0f:x1f], known[y0f:y1f, x0f:x1f], 40)
TEX = {'body': (image('chaoben_body', body), BODY), 'face': (image('chaoben_face', face), CROP)}
NAMES = ('body', 'face', 'hair')
parts = []
for p in me.polygons:
    c, n = p.center, p.normal
    if c.z > 1.47 and abs(c.x) < .15 and n.y > -.25 and c.z > (1.52 if n.y > .3 else 1.555): part = 'hair' # the head's back and sides
    elif c.z > 1.47 and abs(c.x) < .09 and n.y < -.3: part = 'face'
    else: part = 'body'
    parts.append(part)
for n in NAMES: me.materials.append(bpy.data.materials.new(n))
counts = {}
for p, part in zip(me.polygons, parts):
    p.material_index = NAMES.index(part); p.use_smooth = True; counts[part] = counts.get(part, 0) + 1
print('parts', counts)
uv = me.uv_layers.new(name='UVMap').data
for p, part in zip(me.polygons, parts):
    x0, y0, x1, y1 = TEX[part][1] if part in TEX else BODY
    nape = part == 'body' and p.normal.y > .2 and 1.38 < p.center.z < 1.56 and abs(p.center.x) < .1 # the back of the neck: the photo has the face there, so the neck's skin
    for li in p.loop_indices:
        c = Vector((0, 0, 1.46)) if nape else me.vertices[me.loops[li].vertex_index].co
        uv[li].uv = ((PX_X0 + c.x * PX_M - x0) / (x1 - x0), 1 - (PX_Y0 - c.z * PX_M - y0) / (y1 - y0))
for name, (im, _) in TEX.items():
    m = me.materials[NAMES.index(name)]; m.use_nodes = True
    nt = m.node_tree; bsdf = nt.nodes.get('Principled BSDF'); tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = im
    nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color']); bsdf.inputs['Roughness'].default_value = .8

for o in bpy.data.objects: o.select_set(o in (arm, ob))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False, export_skins=True, export_morph=False, export_yup=True, export_texcoords=True,
                          export_tangents=False, export_materials='EXPORT', export_vertex_color='NONE', export_def_bones=False, export_image_format='JPEG', export_image_quality=85)
print('wrote', OUT, os.path.getsize(OUT))
