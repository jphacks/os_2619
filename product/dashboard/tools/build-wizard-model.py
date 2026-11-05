# Builds public/assets/models/wizard.glb from the rigged FBX (AccuRig) and its textured GLB (same mesh, same UVs).
#   blender --background --factory-startup --python tools/build-wizard-model.py -- <dir with the sources> <out.glb> [triangles]
# The source has 97 k triangles cut into ~2000 UV islands, 71 bones, and a gown that follows the calves. What the game uses:
#   - welded and decimated, with no UVs or texture: the look is one colour per part. Each face's part comes from where it is and from the colour of the nearest
#     source triangle, then a vote among neighbouring faces cleans up the edges (the texture is ~2000 patches).
#   - four materials: 'cloth' (hat and gown: the player's colour at run time), 'skin', 'boot', 'face' (wizardmodel.js sets their colours).
#   - about 20 bones, twist bones merged; wizardmodel.js poses them. The hat and head are on the head alone; the gown below the waist is on
#     Skirt_F / Skirt_B, not the legs, so a kneel can lift its front and lay down its back. Eyes are not in here: too few vertices (wizardmodel.js).
import bpy, bmesh, colorsys, os, sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = args[0], args[1]
TRIS = int(args[2]) if len(args) > 2 else 14000
ARM = ('Clavicle', 'Upperarm', 'Forearm', 'Hand')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, 'wizard3dmodel-t.glb'))
image = next(n.image for m in bpy.data.materials for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and any(l.to_socket.name == 'Base Color' for l in n.outputs[0].links))
image.pixels[0] # load
W, H = image.size; px = list(image.pixels)
for o in list(bpy.data.objects): bpy.data.objects.remove(o)

bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, 'wizard3dmodel-t-rigged.fbx'))
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ob = next(o for o in bpy.data.objects if o.type == 'MESH')
ob.shape_key_clear()
arm.animation_data_clear()
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
bpy.context.view_layer.objects.active = arm
for o in (arm, ob): o.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
me = ob.data

def tex(u, v):
    x = min(W - 1, int(u % 1 * W)); y = min(H - 1, int(v % 1 * H)); i = (y * W + x) * 4
    return px[i], px[i + 1], px[i + 2]
def blue(c):
    h, s, v = colorsys.rgb_to_hsv(*c)
    return .5 < h < .75 and s > .1

# ---- the source triangles and their colours, for reading parts later
me.calc_loop_triangles()
src_v = [v.co.copy() for v in me.vertices]
src_tris = [tuple(me.loops[l].vertex_index for l in t.loops) for t in me.loop_triangles]
uvs = me.uv_layers[0].data
src_uv = [tuple(uvs[l].uv.copy() for l in t.loops) for t in me.loop_triangles]
bvh = BVHTree.FromPolygons(src_v, src_tris, all_triangles=True)
def source_colour(p):
    _, _, i, _ = bvh.find_nearest(p)
    if i is None: return (0, 0, 1)
    u = (src_uv[i][0] + src_uv[i][1] + src_uv[i][2]) / 3 # the triangles are small next to the colour patches
    return tex(u.x, u.y)

# ---- the head: measured off the mesh. Round below its widest (z .665), straight up above it into the hat; the collar stops at .572
vuv = {}
for l in me.loops: vuv.setdefault(l.vertex_index, l.index)
HEAD_C, HEAD_R = Vector((0, -.02, .665)), .13
def in_head(p):
    d = p - HEAD_C
    return p.z > .572 and d.x ** 2 + d.y ** 2 + min(0, d.z) ** 2 < (HEAD_R if d.z < 0 else .118) ** 2 # narrower above the widest line: the hat's inside is close there

# ---- weights: merge the twist bones, then set the parts where the auto-rig does not suit
def merged(name):
    n = name.replace('CC_Base_', '')
    for a, b in (('ThighTwist01', 'Thigh'), ('ThighTwist02', 'Thigh'), ('CalfTwist01', 'Calf'), ('CalfTwist02', 'Calf'), ('UpperarmTwist01', 'Upperarm'), ('UpperarmTwist02', 'Upperarm'),
                 ('ForearmTwist01', 'Forearm'), ('ForearmTwist02', 'Forearm'), ('ToeBase', 'Foot'), ('NeckTwist01', 'Neck'), ('NeckTwist02', 'Neck')):
        if n.endswith(a): n = n[:-len(a)] + b
    return n
old_names = [g.name for g in ob.vertex_groups]
weights = []
for v in me.vertices:
    d = {}
    for g in v.groups:
        k = merged(old_names[g.group]); d[k] = d.get(k, 0) + g.weight
    c, u = v.co, tex(*uvs[vuv[v.index]].uv)
    top = max(d, key=d.get) if d else 'Hip'
    if c.z > .585 or in_head(c): d = {'Head': 1}
    elif any(top.endswith(a) for a in ARM): pass
    elif c.z < .17 and not blue(u): # boots and what rises from them under the gown
        d = {k: w for k, w in d.items() if k.endswith(('Foot', 'Calf', 'Thigh'))} or {('L_Calf' if c.x > 0 else 'R_Calf'): 1}
    elif c.z < .30: # the gown below the waist
        t = max(0, min(1, (c.z - .24) / .06)); f = max(0, min(1, .5 - c.y / .14)) # front: -y
        d = {'Hip': t, 'Skirt_F': (1 - t) * f, 'Skirt_B': (1 - t) * (1 - f)}
    else: d = {k: w for k, w in d.items() if not k.endswith(('Foot', 'Calf', 'Thigh'))} or {'Hip': 1}
    weights.append({k: w for k, w in d.items() if w > 1e-3})
for g in list(ob.vertex_groups): ob.vertex_groups.remove(g)
groups = {}
for i, d in enumerate(weights):
    for k, w in d.items():
        if k not in groups: groups[k] = ob.vertex_groups.new(name=k)
        groups[k].add([i], w, 'REPLACE')

# ---- the bones: only those that move something
KEEP = {'CC_Base_Hip': 'Hip', 'CC_Base_Waist': 'Waist', 'CC_Base_Spine01': 'Spine01', 'CC_Base_Spine02': 'Spine02', 'CC_Base_NeckTwist01': 'Neck', 'CC_Base_Head': 'Head'}
for s in 'LR':
    for b in ('Clavicle', 'Upperarm', 'Forearm', 'Hand', 'Thigh', 'Calf', 'Foot'): KEEP[f'CC_Base_{s}_{b}'] = f'{s}_{b}'
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
hip = eb['Hip']
for n, dy in (('Skirt_F', -.1), ('Skirt_B', .1)):
    s = eb.new(n); s.head = (0, 0, .27); s.tail = (0, dy, .27); s.parent = hip
if eb['Head'].length < .01: eb['Head'].tail = eb['Head'].head + Vector((0, 0, .1))
bpy.ops.object.mode_set(mode='OBJECT')
print('bones', [b.name for b in arm.data.bones])

# ---- weld the UV islands, then decimate; UVs go so that seams hold nothing back
bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
while me.uv_layers: me.uv_layers.remove(me.uv_layers[0])
bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5); bm.to_mesh(me); bm.free()
print('welded', len(me.vertices), 'verts', len(me.polygons), 'polys')
ratio = TRIS / sum(len(p.vertices) - 2 for p in me.polygons)
dm = ob.modifiers.new('d', 'DECIMATE'); dm.ratio = min(1, ratio)
ob.modifiers.move(ob.modifiers.find('d'), 0)
bpy.ops.object.modifier_apply(modifier='d')
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
print('decimated', len(me.vertices), 'verts', len(me.polygons), 'polys')

# ---- the cuffs: the mesh is cut across each arm where the cloth ends, so that the colour changes along a clean line and not along the triangles' edges
CUFF = .009 # past the wrist, measured on the source: 99 % of the cloth ends here on both arms
def arm_frame(side):
    fo, ha = arm.data.bones[side + '_Forearm'].head_local, arm.data.bones[side + '_Hand'].head_local
    return ha.copy(), (ha - fo).normalized()
ARMS = [arm_frame('L'), arm_frame('R')]
def past_cuff(p):
    for ha, ax in ARMS:
        d = p - ha; t = d.dot(ax)
        if t > CUFF and (d - ax * t).length < .13: return True
    return False
bm = bmesh.new(); bm.from_mesh(me)
for ha, ax in ARMS:
    near = [f for f in bm.faces if all(abs((v.co - ha).dot(ax)) < .1 and ((v.co - ha) - ax * (v.co - ha).dot(ax)).length < .13 for v in f.verts)]
    geom = list({e for f in near for e in f.edges}) + near + list({v for f in near for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=ha + ax * CUFF, plane_no=ax, clear_inner=False, clear_outer=False)
bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
bm.to_mesh(me); bm.free()
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4) # the cut's new vertices mix their neighbours' weights
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
print('cut', len(me.vertices), 'verts', len(me.polygons), 'polys')

# ---- parts and materials, per face
NAMES = ('cloth', 'skin', 'boot', 'face')
me.materials.clear()
for n in NAMES: me.materials.append(bpy.data.materials.new(n))
parts = []
for p in me.polygons:
    c = p.center; isblue = blue(source_colour(c)); part = 'cloth'
    if in_head(c) and c.z < .72: part = 'face' # by place: the texture's patches are unreliable here, and above this the hat covers it
    elif c.z < .095 or (c.z < .17 and not isblue): part = 'boot'
    parts.append(part)
# a vote among the faces sharing an edge, three times over: the texture's patches leave a ragged edge
bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
near = [[g.index for e in f.edges for g in e.link_faces if g is not f] for f in bm.faces]
bm.free()
for _ in range(3):
    nxt = parts[:]
    for i, ns in enumerate(near):
        count = {parts[i]: 1}
        for n in ns: count[parts[n]] = count.get(parts[n], 0) + 1
        best = max(count, key=count.get)
        if count[best] >= 2 and count[best] > count.get(parts[i], 0): nxt[i] = best
    parts = nxt
parts = ['skin' if past_cuff(p.center) else part for p, part in zip(me.polygons, parts)] # after the vote: this edge is exact
counts = {}
for p, part in zip(me.polygons, parts):
    counts[part] = counts.get(part, 0) + 1
    p.material_index = NAMES.index(part)
print('parts', counts)
for p in me.polygons: p.use_smooth = True

for o in bpy.data.objects: o.select_set(o in (arm, ob))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False, export_skins=True, export_morph=False, export_yup=True, export_texcoords=False,
                          export_tangents=False, export_materials='EXPORT', export_vertex_color='NONE', export_def_bones=False, export_image_format='NONE')
print('wrote', OUT, os.path.getsize(OUT))
