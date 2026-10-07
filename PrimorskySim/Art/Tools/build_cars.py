"""Процедурные городские автомобили (нейтральные, без марок): седан, хэтчбек, кроссовер.

Кузов — боковой профиль, выдавленный по ширине, со скруглением и сужением кверху; колёсные арки вырезаются;
стёкла — отдельный профиль. Материал кузова назван "Paint", игра перекрашивает его для разнообразия трафика.
Ориентация: перед машины смотрит в +Y Blender, что после экспорта glTF даёт -Z в Godot.

    python3 build_cars.py [--no-render]
"""
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).parent))
import blender_common as bc  # noqa: E402

ART = Path(__file__).resolve().parents[1]
OUT_GAME = ART.parent / "Apps" / "Godot" / "assets" / "models"

# Профили в метрах: (y вдоль машины от задка к передку, z высота). Колёса: центры по y, радиус.
CARS = {
    "car_sedan": {
        "length": 4.55, "width": 1.78, "wheel_r": 0.31, "wheels_y": (0.95, 3.65),
        "body": [(0.0, 0.32), (0.0, 0.78), (0.08, 0.95), (0.95, 1.0), (1.25, 1.03), (1.75, 1.42), (2.95, 1.45),
                 (3.45, 1.05), (4.4, 0.92), (4.55, 0.78), (4.55, 0.35), (4.35, 0.25), (0.2, 0.25)],
        "glass": [(1.33, 1.05), (1.78, 1.38), (2.92, 1.40), (3.38, 1.06)],
    },
    "car_hatch": {
        "length": 4.05, "width": 1.73, "wheel_r": 0.30, "wheels_y": (0.75, 3.3),
        "body": [(0.0, 0.32), (0.0, 0.95), (0.05, 1.12), (0.3, 1.47), (2.55, 1.5), (3.15, 1.05), (3.95, 0.92),
                 (4.05, 0.78), (4.05, 0.35), (3.85, 0.25), (0.2, 0.25)],
        "glass": [(0.12, 1.12), (0.36, 1.43), (2.52, 1.45), (3.08, 1.07)],
    },
    "car_suv": {
        "length": 4.6, "width": 1.86, "wheel_r": 0.36, "wheels_y": (0.95, 3.7),
        "body": [(0.0, 0.42), (0.0, 1.05), (0.06, 1.25), (0.25, 1.68), (3.0, 1.72), (3.55, 1.2), (4.45, 1.08),
                 (4.6, 0.92), (4.6, 0.45), (4.4, 0.33), (0.2, 0.33)],
        "glass": [(0.12, 1.26), (0.32, 1.64), (2.97, 1.67), (3.48, 1.22)],
    },
}


def profile_xz(points):
    """(y, z) -> профиль для extrude_profile в плоскости XZ (x = y)."""
    return [(y * 1000.0, z * 1000.0) for y, z in points]


def build_car(name, spec):
    bc.reset_scene()
    w = spec["width"]
    paint = bc.material("Paint", (0.5, 0.05, 0.05), metallic=0.6, roughness=0.28, coat=1.0)
    glass = bc.material("Glass", (0.02, 0.025, 0.03), metallic=0.0, roughness=0.03)
    trim = bc.material("Trim", (0.02, 0.02, 0.02), roughness=0.55)
    tyre = bc.material("Tyre", (0.025, 0.025, 0.025), roughness=0.85)
    rim = bc.material("Rim", (0.55, 0.56, 0.58), metallic=1.0, roughness=0.3)
    head = bc.material("HeadLight", (0.9, 0.9, 0.85), roughness=0.1)
    head.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 3.0
    head.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (1, 0.95, 0.85, 1)
    tail = bc.material("TailLight", (0.6, 0.02, 0.02), roughness=0.15)
    tail.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 2.0
    tail.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (1, 0.05, 0.02, 1)

    prof = bc.chaikin(profile_xz(spec["body"]), iterations=2)
    body = bc.extrude_profile("Body", prof, -w * 500, w * 500)
    # сужение верхней части кузова (завал боковин) — масштаб по X в зависимости от высоты
    for v in body.data.vertices:
        t = max(0.0, (v.co.z - 0.9) / 0.6)
        v.co.x *= 1.0 - 0.12 * min(t, 1.0)
    # колёсные арки
    r = spec["wheel_r"]
    for wy in spec["wheels_y"]:
        arch = bc.cylinder_x("Arch", -w * 600, w * 600, 0, 0, (r + 0.05) * 1000, segments=40)
        arch.rotation_euler = (0, 0, 1.5708)
        arch.location = (wy, 0, r)
        bpy.context.view_layer.update()
        bc.apply_modifiers(arch)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bc.boolean(body, arch)
    # Ось профиля: X -> длина. Поворачиваем, чтобы длина шла по +Y, ширина по X.
    bc.finish(body, bevel_mm=35, segments=4, angle=30)
    bc.assign(body, paint)
    body.rotation_euler = (0, 0, 1.5708)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.transform_apply(rotation=True)
    # После поворота: профиль x (длина) ушёл в +Y, ширина (бывший y) — в -X (симметрично).

    gl = bc.extrude_profile("Glass", bc.chaikin(profile_xz(spec["glass"]) + [(spec["glass"][-1][0] * 1000, 950), (spec["glass"][0][0] * 1000, 950)], 1), -w * 506, w * 506)
    for v in gl.data.vertices:
        t = max(0.0, (v.co.z - 0.9) / 0.6)
        v.co.x *= 1.0 - 0.12 * min(t, 1.0)
    bc.finish(gl, bevel_mm=30, segments=2, angle=30)
    bc.assign(gl, glass)
    gl.rotation_euler = (0, 0, 1.5708)
    bpy.context.view_layer.objects.active = gl
    bpy.ops.object.transform_apply(rotation=True)

    parts = [body, gl]
    L = spec["length"]
    # фары и фонари
    for side in (-1, 1):
        hl = bc.box("HeadL", side * w * 0.42 - 0.18, side * w * 0.42 + 0.18, L - 0.06, L + 0.005, 0.72, 0.84, mm=False)
        bc.finish(hl, bevel_mm=15, segments=2)
        bc.assign(hl, head)
        tl = bc.box("TailL", side * w * 0.42 - 0.2, side * w * 0.42 + 0.2, -0.005, 0.05, 0.82, 0.92, mm=False)
        bc.finish(tl, bevel_mm=10, segments=2)
        bc.assign(tl, tail)
        parts += [hl, tl]
    for side in (-1, 1):
        mirror = bc.box("Mirror", side * (w * 0.5 + 0.02) - 0.07, side * (w * 0.5 + 0.02) + 0.07, spec["glass"][-1][0] - 0.25, spec["glass"][-1][0] - 0.1, 1.0, 1.12, mm=False)
        bc.finish(mirror, bevel_mm=20, segments=2)
        bc.assign(mirror, paint)
        parts.append(mirror)
    grille = bc.box("Grille", -w * 0.28, w * 0.28, L - 0.03, L + 0.004, 0.45, 0.66, mm=False)
    bc.assign(grille, trim)
    plate_f = bc.box("PlateF", -0.26, 0.26, L, L + 0.01, 0.36, 0.47, mm=False)
    plate_r = bc.box("PlateR", -0.26, 0.26, -0.01, 0.0, 0.48, 0.59, mm=False)
    plate_mat = bc.material("Plate", (0.85, 0.85, 0.85), roughness=0.4)
    for p in (plate_f, plate_r):
        bc.assign(p, plate_mat)
    parts += [grille, plate_f, plate_r]
    # колёса
    for wy in spec["wheels_y"]:
        for side in (-1, 1):
            x = side * (w * 0.5 - 0.13)
            t = bc.cylinder_x("Tyre", (x - 0.11) * 1000, (x + 0.11) * 1000, wy * 1000, r * 1000, r * 1000, segments=40)
            bc.finish(t, bevel_mm=40, segments=3, angle=25)
            bc.assign(t, tyre)
            rm = bc.cylinder_x("Rim", (x - 0.115 * side - 0.0) * 1000 if side < 0 else (x + 0.105) * 1000,
                               (x - 0.105) * 1000 if side < 0 else (x + 0.115) * 1000, wy * 1000, r * 1000, r * 640, segments=32)
            bc.assign(rm, rim)
            parts += [t, rm]
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    for p in parts:
        p.parent = root
    bc.export_glb(OUT_GAME / f"{name}.glb", [root, *parts])
    return parts


def main():
    render = "--no-render" not in sys.argv
    for name, spec in CARS.items():
        build_car(name, spec)
        if render:
            bc.studio(target=(0, 2.2, 0.8), size=2.5, floor_z=0.0)
            bc.render(ART / "Renders" / "Vehicles" / f"{name}.png", (5.5, -1.5, 2.2), (0, 2.2, 0.75), lens=50, res=(1200, 700), samples=48)
        print("built", name)


if __name__ == "__main__":
    main()
