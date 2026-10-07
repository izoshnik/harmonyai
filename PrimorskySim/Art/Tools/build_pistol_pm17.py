"""Пистолет «ПМ-17» (нейтральное название; референс — фото Glock 17 из материалов заказчика).

Размеры приближены к референсу (длина ~186 мм, высота ~138 мм, ширина затвора ~25,5 мм).
Ось X — к дульному срезу, Z — вверх, Y — влево. Единицы в коде — мм.

Запуск:  python3 build_pistol_pm17.py [--no-render]
Выход:   Art/Export/Weapons/WPN_Pistol_PM17.glb, Art/Renders/Weapons/WPN_Pistol_PM17_*.png
"""
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).parent))
import blender_common as bc  # noqa: E402

ART = Path(__file__).resolve().parents[1]
NAME = "WPN_Pistol_PM17"


def frame():
    outline = [
        (3, 101), (-3, 99), (-1, 94), (-6, 86), (-34, 8), (-33, 6), (-28, 4), (14, 4), (18, 6),
        (22, 16), (26, 26), (27.5, 31), (31, 38), (33, 44), (36, 52), (38, 58), (42, 64), (44, 69),
        (48, 66), (98, 66), (106, 68), (113, 78), (116, 88), (119, 90.5), (176, 91.5), (181, 93.5), (183, 101),
    ]
    sharp = {0, len(outline) - 1}
    smooth = bc.chaikin(outline, iterations=2, keep=sharp)
    body = bc.extrude_profile("Frame", smooth, -12.4, 12.4)

    grip_outline = [(-1, 94), (-6, 86), (-34, 8), (-33, 6), (-28, 4), (14, 4), (18, 6), (22, 16), (26, 26),
                    (27.5, 31), (31, 38), (33, 44), (36, 52), (38, 58), (42, 64), (44, 69), (47, 82), (12, 92)]
    grip = bc.extrude_profile("Grip", bc.chaikin(grip_outline, 2), -14.6, 14.6)
    bc.finish(grip, bevel_mm=3.2, segments=5, angle=30)
    bc.boolean(body, grip, op="UNION")

    hole = [(54, 72), (98, 72), (103, 76), (108, 86), (107, 92.5), (56, 92.5), (52, 86)]
    bc.boolean(body, bc.extrude_profile("GuardHole", bc.chaikin(hole, 2), -20, 20))
    # Пазы планки под дульной частью
    for x in (142, 156):
        bc.boolean(body, bc.box("RailSlot", x, x + 5, -20, 20, 88, 93.2))
    # Колодец магазина снизу
    bc.boolean(body, bc.box("MagWell", -27, 12, -11.5, 11.5, 0, 9))
    bc.finish(body, bevel_mm=0.9, segments=3, angle=40)

    # Отдельный материал для рукоятки: полигоны ниже спусковой скобы и позади неё
    for p in body.data.polygons:
        c = p.center
        p.material_index = 1 if (c.z < 0.088 and c.x < 0.047) else 0
    return body


def slide():
    section = [(-12.75, 101), (12.75, 101), (12.75, 123.5), (9.6, 129), (-9.6, 129), (-12.75, 123.5)]
    s = bc.extrude_section_x("Slide", section, 0, 186)
    bc.boolean(s, bc.extrude_profile("NoseCut", [(168, 98), (192, 98), (192, 114)], -20, 20))
    bc.boolean(s, bc.extrude_profile("NoseTop", [(179, 133), (192, 133), (192, 122)], -20, 20))
    for i in range(8):
        x = 7 + i * 3.1
        for y0, y1 in ((12.0, 16), (-16, -12.0)):
            bc.boolean(s, bc.box("Serr", x, x + 1.5, y0, y1, 103.5, 126.5))
    bc.boolean(s, bc.box("EjectionPort", 95, 132, -16, 3.5, 117, 135))
    bc.boolean(s, bc.cylinder_x("MuzzleOpening", 170, 200, 0, 114, 6.9))
    bc.boolean(s, bc.cylinder_x("GuideRodHole", 170, 200, 0, 104.5, 3.4, segments=32))
    # Гравировка на правой стороне затвора
    bpy.ops.object.text_add(location=(0.034, -0.0131, 0.110), rotation=(1.5708, 0, 0))
    txt = bpy.context.active_object
    txt.data.body = "PM-17   9x19"
    txt.data.size = 0.0042
    txt.data.extrude = 0.0006
    bpy.ops.object.convert(target="MESH")
    bc.boolean(s, txt)
    bc.finish(s, bevel_mm=0.45, segments=2, angle=40)
    return s


def barrel():
    b = bc.cylinder_x("Barrel", 118, 185.6, 0, 114, 6.6)
    hood = bc.box("Hood", 95.5, 131.5, -9.5, 9.5, 108, 125.5)
    bc.boolean(b, hood, op="UNION")
    bc.boolean(b, bc.cylinder_x("Bore", 100, 200, 0, 114, 4.55, segments=40))
    bc.finish(b, bevel_mm=0.35, segments=2, angle=40)
    return b


def small_parts():
    parts = []
    rear = bc.extrude_profile("RearSight", [(5, 128.5), (17, 128.5), (16, 135), (7.5, 135)], -6, 6)
    bc.boolean(rear, bc.box("Notch", 4, 18, -1.7, 1.7, 131.5, 136))
    parts.append(rear)
    parts.append(bc.extrude_profile("FrontSight", [(173.5, 128.5), (180.5, 128.5), (180, 134.6), (175.5, 134.6)], -1.8, 1.8))
    parts.append(bc.extrude_profile("Trigger", bc.chaikin(
        [(70, 93), (75.5, 93), (77.5, 85), (77, 77), (74.5, 71.5), (71, 70.5), (72.3, 75), (73, 81), (71.5, 88)], 2),
        -3.1, 3.1))
    parts.append(bc.extrude_profile("TriggerSafety", bc.chaikin(
        [(74, 86), (76.2, 86), (76.4, 78), (74.8, 73.5), (73.8, 78)], 1), -0.9, 0.9))
    parts.append(bc.box("TakedownLever", 104, 115, -13.2, 13.2, 93.2, 99.2))
    parts.append(bc.box("SlideStop", 58, 90, 12.0, 13.6, 97, 100.4))
    parts.append(bc.box("MagRelease", 47, 54, -13.4, 13.4, 79, 86.5))
    base = bc.extrude_profile("MagBase", bc.chaikin([(-31, 0.5), (14.5, 0.5), (16, 4.3), (-32, 4.3)], 1), -13.6, 13.6)
    mag = bc.box("MagBody", -26.5, 11.5, -11, 11, 2, 8.5)
    bc.boolean(base, mag, op="UNION")
    parts.append(base)
    for p in parts:
        bc.finish(p, bevel_mm=0.35, segments=2, angle=40)
    for name, x, z in (("PinTrigger", 96, 95.5), ("PinLocking", 64, 95.5), ("PinHousing", 7, 92)):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.0016, depth=0.0252, location=(x * bc.MM, 0, z * bc.MM),
                                            rotation=(1.5708, 0, 0), vertices=24)
        pin = bpy.context.active_object
        pin.name = name
        parts.append(pin)
    return parts


def build(render=True):
    bc.reset_scene()
    m_poly = bc.material("M_Polymer", (0.022, 0.022, 0.024), roughness=0.62, rough_var=0.06)
    m_grip = bc.material("M_PolymerTexture", (0.02, 0.02, 0.022), roughness=0.75, bump_scale=1800, bump_strength=0.55)
    m_slide = bc.material("M_SlideNitride", (0.055, 0.056, 0.06), metallic=0.85, roughness=0.36, rough_var=0.08, edge_wear=0.025)
    m_steel = bc.material("M_Steel", (0.32, 0.32, 0.33), metallic=1.0, roughness=0.28, rough_var=0.05, edge_wear=0.02)
    m_dark = bc.material("M_DarkSteel", (0.04, 0.04, 0.045), metallic=0.9, roughness=0.45)

    f = frame()
    f.data.materials.clear()
    f.data.materials.append(m_poly)
    f.data.materials.append(m_grip)
    s = slide(); bc.assign(s, m_slide)
    b = barrel(); bc.assign(b, m_steel)
    parts = small_parts()
    for p in parts:
        bc.assign(p, m_steel if p.name.startswith("Pin") else (m_poly if p.name.startswith(("Trigger", "Mag")) else m_dark))

    root = bpy.data.objects.new(NAME, None)
    bpy.context.collection.objects.link(root)
    meshes = [f, s, b, *parts]
    for o in meshes:
        o.parent = root
    bc.export_glb(ART / "Export" / "Weapons" / f"{NAME}.glb", [root, *meshes])
    tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
    print(f"{NAME}: {len(meshes)} parts, ~{tris} tris")

    if render:
        target = (0.075, 0, 0.07)
        bc.studio(target=target, size=0.25, floor_z=-0.03)
        out = ART / "Renders" / "Weapons"
        bc.render(out / f"{NAME}_side.png", (0.075, -0.78, 0.075), target, lens=85)
        bc.render(out / f"{NAME}_34.png", (0.42, -0.55, 0.26), (0.08, 0, 0.075), lens=85)


if __name__ == "__main__":
    build(render="--no-render" not in sys.argv)
