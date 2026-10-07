"""Общие утилиты процедурного моделирования (Blender bpy, headless).

Модели строятся из профилей реальных размеров (мм -> м), затем фаски, булевы операции
и PBR-материалы. Каждый генератор создаёт .glb для импорта в UE и превью-рендеры.
"""
from __future__ import annotations

import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

MM = 0.001


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def chaikin(points, iterations=2, closed=True, keep=()):
    """Скругление ломаной. keep — индексы исходных вершин, которые остаются острыми."""
    pts = [(tuple(p), i in keep) for i, p in enumerate(points)]
    for _ in range(iterations):
        out = []
        n = len(pts)
        for i in range(n if closed else n - 1):
            (p, pk), (q, qk) = pts[i], pts[(i + 1) % n]
            if pk:
                out.append((p, True))
            else:
                out.append((tuple(0.75 * a + 0.25 * b for a, b in zip(p, q)), False))
            if not qk:
                out.append((tuple(0.25 * a + 0.75 * b for a, b in zip(p, q)), False))
        pts = out
    return [p for p, _ in pts]


def extrude_profile(name, profile_xz, y0, y1, mm=True):
    """Профиль в плоскости XZ, выдавленный по Y от y0 до y1."""
    s = MM if mm else 1.0
    bm = bmesh.new()
    front = [bm.verts.new((x * s, y0 * s, z * s)) for x, z in profile_xz]
    back = [bm.verts.new((x * s, y1 * s, z * s)) for x, z in profile_xz]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    n = len(profile_xz)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _to_object(name, bm)


def extrude_section_x(name, section_yz, x0, x1, mm=True):
    """Сечение в плоскости YZ, выдавленное по X."""
    s = MM if mm else 1.0
    bm = bmesh.new()
    a = [bm.verts.new((x0 * s, y * s, z * s)) for y, z in section_yz]
    b = [bm.verts.new((x1 * s, y * s, z * s)) for y, z in section_yz]
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    n = len(section_yz)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _to_object(name, bm)


def box(name, x0, x1, y0, y1, z0, z1, mm=True):
    s = MM if mm else 1.0
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((
            (x0 if v.co.x < 0 else x1) * s,
            (y0 if v.co.y < 0 else y1) * s,
            (z0 if v.co.z < 0 else z1) * s,
        ))
    return _to_object(name, bm)


def cylinder_x(name, x0, x1, y, z, r, segments=48, mm=True):
    s = MM if mm else 1.0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r * s, radius2=r * s, depth=(x1 - x0) * s)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=_rot_y90())
    bmesh.ops.translate(bm, verts=bm.verts, vec=(((x0 + x1) / 2) * s, y * s, z * s))
    return _to_object(name, bm)


def _rot_y90():
    from mathutils import Matrix
    return Matrix.Rotation(math.radians(90), 3, "Y")


def _to_object(name, bm):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def boolean(target, cutter, op="DIFFERENCE", apply=True):
    mod = target.modifiers.new(f"bool_{cutter.name}", "BOOLEAN")
    mod.operation = op
    mod.solver = "EXACT"
    mod.object = cutter
    if apply:
        apply_modifiers(target)
        bpy.data.objects.remove(cutter, do_unlink=True)


def apply_modifiers(obj):
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def finish(obj, bevel_mm=0.6, segments=3, angle=35, apply=True):
    """Фаска по углу + взвешенные нормали: убирает «пластиковую коробку»."""
    bev = obj.modifiers.new("bevel", "BEVEL")
    bev.width = bevel_mm * MM
    bev.segments = segments
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(angle)
    tri = obj.modifiers.new("tri", "TRIANGULATE")
    tri.min_vertices = 5  # только n-гоны после булевых операций; квады остаются
    if apply:
        apply_modifiers(obj)
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))
    return obj


def material(name, color, metallic=0.0, roughness=0.5, bump_scale=0.0, bump_strength=0.0,
             rough_var=0.0, edge_wear=0.0, coat=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
    if rough_var:
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 180.0
        ramp = nt.nodes.new("ShaderNodeMapRange")
        ramp.inputs["To Min"].default_value = roughness - rough_var
        ramp.inputs["To Max"].default_value = roughness + rough_var
        nt.links.new(noise.outputs["Fac"], ramp.inputs["Value"])
        nt.links.new(ramp.outputs["Result"], bsdf.inputs["Roughness"])
    if edge_wear:
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.56
        ramp.color_ramp.elements[0].color = (*color, 1)
        ramp.color_ramp.elements[1].position = 0.56 + edge_wear
        ramp.color_ramp.elements[1].color = (*(min(1, c * 2.5 + 0.05) for c in color), 1)
        nt.links.new(geo.outputs["Pointiness"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    if bump_scale:
        coord = nt.nodes.new("ShaderNodeTexCoord")
        tex = nt.nodes.new("ShaderNodeTexVoronoi")
        tex.inputs["Scale"].default_value = bump_scale
        nt.links.new(coord.outputs["Object"], tex.inputs["Vector"])
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_strength
        bump.inputs["Distance"].default_value = 0.0004
        nt.links.new(tex.outputs["Distance"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def studio(target=(0, 0, 0), size=0.4, floor_z=0.0):
    """Студийный свет + циклорама. size — характерный размер объекта, м."""
    scene = bpy.context.scene
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.02, 0.022, 0.025, 1)
    scene.world = world
    # Циклорама
    bpy.ops.mesh.primitive_plane_add(size=size * 30, location=(target[0], target[1], floor_z))
    floor = bpy.context.active_object
    floor.name = "Backdrop"
    assign(floor, material("backdrop", (0.32, 0.33, 0.35), roughness=0.8))
    for name, loc, energy, scale in (
        ("Key", (size * 1.2, -size * 1.6, size * 2.0), 14, size * 2.5),
        ("Fill", (-size * 1.8, -size * 1.0, size * 1.0), 4, size * 3.0),
        ("Rim", (-size * 0.5, size * 2.0, size * 1.5), 10, size * 1.5),
    ):
        light = bpy.data.lights.new(name, "AREA")
        light.energy = energy * (size / 0.25) ** 2
        light.size = scale
        obj = bpy.data.objects.new(name, light)
        obj.location = loc
        _look_at(obj, target)
        bpy.context.collection.objects.link(obj)


def _look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render(path: Path, cam_loc, target, lens=85, res=(1600, 900), samples=96):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = cam_loc
    _look_at(cam, target)
    scene.camera = cam
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.view_settings.view_transform = "AgX"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)


def export_glb(path: Path, objects):
    for o in bpy.context.scene.objects:
        o.select_set(o in objects)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), use_selection=True, export_apply=True)
