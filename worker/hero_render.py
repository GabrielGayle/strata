"""Render Strata's model.glb as a hero picture with Blender Cycles.

    python hero_render.py model.glb out.png settings.json

Runs with the `bpy` module (pip install bpy), on the GPU when there is one (OptiX,
then CUDA) and on the CPU otherwise, so the same script renders on Modal's L4 and on
a laptop. The GLB comes from src/core/hero.ts: metres, one mesh per look, materials
named "strata:<kind>" with the look in their extras, a camera node, and empty
"flame.*" nodes where candle flames are.

settings.json: {"light": "studio" | "daylight" | "candle", "width": px, "height": px,
"samples": n}. Prints one JSON line: {"device", "seconds", "width", "height"}.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time

import bpy
from mathutils import Vector


def hex_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    c = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)  # type: ignore[return-value]


def rgba(h: str) -> tuple[float, float, float, float]:
    return (*hex_rgb(h), 1.0)


def mix(a, b, t):
    return tuple(x * (1 - t) + y * t for x, y in zip(a, b))


def use_gpu() -> str:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
        except TypeError:
            continue
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            bpy.context.scene.cycles.device = "GPU"
            return kind
    bpy.context.scene.cycles.device = "CPU"
    return "CPU"


def new_material(name: str):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m, nt, bsdf


def noise(nt, scale: float, detail: float = 8.0, coords: str = "Object"):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = detail
    nz.inputs["Roughness"].default_value = 0.6
    nt.links.new(tc.outputs[coords], nz.inputs["Vector"])
    return nz


def bump(nt, bsdf, height_socket, strength: float, distance: float):
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = strength
    b.inputs["Distance"].default_value = distance
    nt.links.new(height_socket, b.inputs["Height"])
    nt.links.new(b.outputs["Normal"], bsdf.inputs["Normal"])


def ramp(nt, fac_socket, stops: list[tuple[float, tuple]], constant: bool = False):
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.interpolation = "CONSTANT" if constant else "LINEAR"
    els = r.color_ramp.elements
    while len(els) > 1:
        els.remove(els[-1])
    els[0].position, els[0].color = stops[0]
    for pos, col in stops[1:]:
        e = els.new(pos)
        e.color = col
    nt.links.new(fac_socket, r.inputs["Fac"])
    return r


def plate_material(ex: dict):
    """Corten rusts in patches, steel and aluminium are brushed or milled, powder coat is plain."""
    look = hex_rgb(ex.get("color", "#8b4a2a"))
    metal, finish = ex.get("metal", "steel"), ex.get("finish", "")
    m, nt, bsdf = new_material(f"plate {metal} {finish}")
    base = ex["_pbr"]
    bsdf.inputs["Metallic"].default_value = base["metallic"]
    bsdf.inputs["Roughness"].default_value = base["roughness"]
    if metal == "corten" and finish != "fresh":
        nz = noise(nt, 160.0, 10.0)
        dark, light = mix(look, (0.02, 0.008, 0.004), 0.45), mix(look, (0.55, 0.22, 0.07), 0.35)
        r = ramp(nt, nz.outputs["Fac"], [(0.3, (*dark, 1)), (0.55, (*look, 1)), (0.75, (*light, 1))])
        nt.links.new(r.outputs["Color"], bsdf.inputs["Base Color"])
        rough = ramp(nt, nz.outputs["Fac"], [(0.3, (0.95,) * 3 + (1,)), (0.75, (0.7,) * 3 + (1,))])
        nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
        bump(nt, bsdf, nz.outputs["Fac"], 0.25, 0.0004)
    elif finish == "brushed" and metal in ("steel", "aluminium"):
        bsdf.inputs["Base Color"].default_value = (*look, 1)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (1.0, 1.0, 400.0)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 60.0
        nz.inputs["Detail"].default_value = 4.0
        nt.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
        bump(nt, bsdf, nz.outputs["Fac"], 0.08, 0.0002)
    else:
        bsdf.inputs["Base Color"].default_value = (*look, 1)
        if metal == "steel" and finish in ("", "mill", "blackened"):
            # bare mild steel has a dull mill scale: as glossy as the app's preview it mirrors the
            # next plate along and a dense stack renders black
            bsdf.inputs["Metallic"].default_value = min(base["metallic"], 0.6)
            nz = noise(nt, 120.0, 6.0)
            rough = ramp(nt, nz.outputs["Fac"], [(0.35, (0.5,) * 3 + (1,)), (0.7, (0.68,) * 3 + (1,))])
            nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    return m


def concrete_material(ex: dict):
    """The pour bands stacked up the base (world height), with a little aggregate in them."""
    m, nt, bsdf = new_material("concrete")
    bsdf.inputs["Roughness"].default_value = 0.92
    bands = ex.get("bands") or []
    nz = noise(nt, 90.0, 6.0)
    if len(bands) > 1:
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(geo.outputs["Position"], sep.inputs["Vector"])
        top = max(b["y1"] for b in bands) or 1.0
        div = nt.nodes.new("ShaderNodeMath")
        div.operation = "DIVIDE"
        div.inputs[1].default_value = top
        nt.links.new(sep.outputs["Z"], div.inputs[0])
        stops = [(max(0.0, min(1.0, b["y0"] / top)), rgba(b["color"])) for b in bands]
        stops[0] = (0.0, stops[0][1])
        col = ramp(nt, div.outputs["Value"], stops, constant=True)
        colour = col.outputs["Color"]
    else:
        flat = nt.nodes.new("ShaderNodeRGB")
        flat.outputs[0].default_value = rgba(ex.get("color", "#b8b4ab"))
        colour = flat.outputs[0]
    grit = nt.nodes.new("ShaderNodeMix")
    grit.data_type = "RGBA"
    grit.blend_type = "MULTIPLY"
    grit.inputs["Factor"].default_value = 0.18
    nt.links.new(colour, grit.inputs["A"])
    nt.links.new(nz.outputs["Color"], grit.inputs["B"])
    nt.links.new(grit.outputs["Result"], bsdf.inputs["Base Color"])
    bump(nt, bsdf, nz.outputs["Fac"], 0.15, 0.0005)
    return m


def plain_material(name: str, ex: dict, sss: bool = False):
    m, nt, bsdf = new_material(name)
    bsdf.inputs["Base Color"].default_value = rgba(ex.get("color", "#ffffff"))
    bsdf.inputs["Metallic"].default_value = ex["_pbr"]["metallic"]
    bsdf.inputs["Roughness"].default_value = ex["_pbr"]["roughness"]
    if sss:
        bsdf.inputs["Subsurface Weight"].default_value = 0.35
        bsdf.inputs["Subsurface Radius"].default_value = (0.004, 0.003, 0.002)
    return m


def restyle(obj) -> None:
    for slot in obj.material_slots:
        old = slot.material
        if old is None or not old.name.startswith("strata:"):
            continue
        ex = {k: (v.to_dict() if hasattr(v, "to_dict") else (list(v) if hasattr(v, "__len__") and not isinstance(v, str) else v)) for k, v in old.items()}
        bsdf = next((n for n in old.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if old.use_nodes else None
        ex["_pbr"] = {
            "metallic": bsdf.inputs["Metallic"].default_value if bsdf else 0.0,
            "roughness": bsdf.inputs["Roughness"].default_value if bsdf else 0.8,
        }
        kind = ex.get("strata", old.name.split(":", 1)[1].split(".")[0])
        if kind == "plate":
            slot.material = plate_material(ex)
        elif kind == "concrete":
            slot.material = concrete_material(ex)
        elif kind == "wax":
            slot.material = plain_material("wax", ex, sss=True)
        else:
            slot.material = plain_material(kind, ex)


def floor(size: float, z: float, colour: str, rough: float):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
    f = bpy.context.active_object
    m, nt, bsdf = new_material("floor")
    bsdf.inputs["Base Color"].default_value = rgba(colour)
    bsdf.inputs["Roughness"].default_value = rough
    f.data.materials.append(m)
    return f


def world(colour: tuple, strength: float, sky: bool = False, sun_dir: Vector | None = None):
    w = bpy.data.worlds.new("hero") if not bpy.context.scene.world else bpy.context.scene.world
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    bg.inputs["Strength"].default_value = strength
    if sky:
        s = nt.nodes.new("ShaderNodeTexSky")
        for t in ("MULTIPLE_SCATTERING", "NISHITA", "HOSEK_WILKIE"):
            try:
                s.sky_type = t
                break
            except TypeError:
                continue
        if sun_dir is not None and hasattr(s, "sun_elevation"):
            s.sun_elevation = math.asin(max(0.05, sun_dir.normalized().z))
            s.sun_rotation = math.atan2(sun_dir.y, sun_dir.x) + math.pi / 2
        if hasattr(s, "sun_disc"):
            s.sun_disc = False
        nt.links.new(s.outputs["Color"], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (*colour, 1)


def area(name: str, loc: Vector, target: Vector, size: float, power: float, colour=(1, 1, 1)):
    d = bpy.data.lights.new(name, "AREA")
    d.shape = "DISK"
    d.size = size
    d.energy = power
    d.color = colour
    o = bpy.data.objects.new(name, d)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
    return o


def main(argv: list[str]) -> None:
    glb, out, settings_path = argv
    with open(settings_path) as f:
        settings = json.load(f)
    t0 = time.time()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    device = use_gpu()
    bpy.ops.import_scene.gltf(filepath=glb)

    # read what hero.ts put in the file
    cam = next((o for o in sc.objects if o.type == "CAMERA"), None)
    flames = [o for o in sc.objects if o.name.startswith("flame")]
    meshes = [o for o in sc.objects if o.type == "MESH"]
    for o in meshes:
        restyle(o)
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))) if pts else Vector((0, 0, 0))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))) if pts else Vector((1, 1, 1))
    centre = (lo + hi) / 2
    span = max((hi - lo).length, 0.05)

    if cam is None:
        cd = bpy.data.cameras.new("camera")
        cam = bpy.data.objects.new("camera", cd)
        sc.collection.objects.link(cam)
        cam.location = centre + Vector((1.2, -1.6, 0.9)).normalized() * span * 2.2
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    cam.data.clip_start = span / 1000
    cam.data.clip_end = span * 200
    cam.data.sensor_fit = "VERTICAL"
    # everything in focus: a model this small blurs to mush at the back with any depth of field
    cam.data.dof.use_dof = False

    w, h = int(settings.get("width", 1600)), int(settings.get("height", 1067))
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.cycles.samples = int(settings.get("samples", 256))
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    # thin plate edges shimmer into moiré: a wider pixel filter and an edge-aware denoise keep
    # them as fine lines rather than smearing or striping them
    sc.cycles.filter_width = 2.0
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
        sc.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
        sc.cycles.denoising_prefilter = "ACCURATE"
    except (AttributeError, TypeError):
        pass
    sc.cycles.max_bounces = 8
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = "AgX - Punchy"
    except TypeError:
        pass
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.image_settings.color_depth = "8"
    sc.render.image_settings.compression = 90

    light = settings.get("light", "studio")
    if light == "candle" and not flames:
        light = "studio"
    ground = lo.z
    view = (cam.location - centre)
    view.z = 0
    view = view.normalized() if view.length > 1e-6 else Vector((0, -1, 0))
    side = view.cross(Vector((0, 0, 1))).normalized()

    if light == "studio":
        floor(span * 60, ground, "#d9d5ce", 0.85)
        world((0.85, 0.83, 0.8), 0.3)
        key = centre + (view * 1.1 + side * 1.0) * span + Vector((0, 0, 1.4 * span))
        area("key", key, centre, span * 1.2, 110 * span * span)
        area("fill", centre + (view * 1.4 - side * 1.3) * span + Vector((0, 0, 0.5 * span)), centre, span * 1.6, 40 * span * span)
        area("rim", centre - view * 1.4 * span + Vector((0, 0, 1.2 * span)), centre, span * 0.9, 110 * span * span)
    elif light == "daylight":
        floor(span * 200, ground, "#a8a395", 0.95)
        sun_dir = (view * 0.6 + side * 0.9 + Vector((0, 0, 0.55))).normalized()
        world((0.6, 0.7, 0.9), 0.22, sky=True, sun_dir=sun_dir)
        d = bpy.data.lights.new("sun", "SUN")
        d.energy = 3.2
        d.angle = math.radians(1.2)
        s = bpy.data.objects.new("sun", d)
        sc.collection.objects.link(s)
        s.rotation_euler = sun_dir.to_track_quat("Z", "Y").to_euler()
    else:
        floor(span * 60, ground, "#3a332c", 0.8)
        world((0.01, 0.012, 0.02), 1.0)
        for f in flames:
            size = float(f.get("size", 0.015))
            d = bpy.data.lights.new(f.name, "POINT")
            d.energy = 0.08 + 6 * size
            d.shadow_soft_size = size * 0.25
            d.color = (1.0, 0.58, 0.24)
            o = bpy.data.objects.new(f.name + ".light", d)
            sc.collection.objects.link(o)
            o.location = f.matrix_world.translation
            bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 3.8, location=o.location)
            fl = bpy.context.active_object
            fl.scale = (1, 1, 1.9)
            m, nt, bsdf = new_material("flame")
            em = nt.nodes.new("ShaderNodeEmission")
            em.inputs["Color"].default_value = (1.0, 0.62, 0.22, 1)
            em.inputs["Strength"].default_value = 18.0
            nt.links.new(em.outputs[0], nt.nodes["Material Output"].inputs["Surface"])
            fl.data.materials.append(m)
            fl.visible_shadow = False
        # a little moonlight so the base isn't lost
        area("moon", centre + (view + side * 0.6) * 2 * span + Vector((0, 0, 1.5 * span)), centre, span, 1.5 * span * span, (0.6, 0.7, 1.0))

    sc.render.filepath = os.path.abspath(out)
    bpy.ops.render.render(write_still=True)
    print(json.dumps({"device": device, "seconds": round(time.time() - t0, 2), "width": w, "height": h, "light": light}))


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    main(args)
