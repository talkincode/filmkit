# Runs INSIDE Blender (blender -b --factory-startup -P build_scene.py -- bake.json scene.blend).
# Native Python on purpose: this is the only language Blender speaks. It contains no
# scene logic: it creates what bake.json lists, keys the per-frame poses it carries,
# configures a Workbench render, and saves a .blend that renders with plain
#   blender -b scene.blend -a
import json
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
bake_path, out_blend = argv

with open(bake_path, "r", encoding="utf-8") as fh:
    bake = json.load(fh)
assert bake["protocol"] == "blockout-bake/v1alpha1", "unsupported bake protocol %r" % bake["protocol"]

bpy.ops.wm.read_factory_settings(use_empty=True)
# every keyframe is linear: values are exact on integer frames, and in between they are straight lines
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"

scene = bpy.context.scene
scene.name = "blockout"
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0

# frame i is absolute time i / fps; the video has exactly durationFrames frames
scene.render.fps = bake["fps"]
scene.render.fps_base = 1.0
scene.frame_start = 0
scene.frame_end = bake["durationFrames"] - 1
scene.frame_current = 0

render = scene.render
render.engine = "BLENDER_WORKBENCH"
render.resolution_x = bake["width"]
render.resolution_y = bake["height"]
render.resolution_percentage = 100
render.pixel_aspect_x = 1.0
render.pixel_aspect_y = 1.0
render.film_transparent = False
render.image_settings.file_format = "PNG"
render.image_settings.color_mode = "RGB"
render.image_settings.color_depth = "8"
render.filepath = "//render/f_"
render.use_file_extension = True
render.use_overwrite = True
render.use_placeholder = False
render.dither_intensity = 0.0  # no noise: smaller PNGs, identical pixels on every render
# PNG metadata would carry the absolute .blend path, a date and a time: none of that belongs in a deterministic artifact
for flag in dir(render):
    if flag.startswith("use_stamp"):
        setattr(render, flag, False)

scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0
scene.display_settings.display_device = "sRGB"

shading = scene.display.shading
shading.light = "STUDIO"
# "paint.sl" lights the floor the way the Three.js side does; the default studio light leaves it almost black
assert "paint.sl" in [s.name for s in bpy.context.preferences.studio_lights if s.type == "STUDIO"], "Blender is missing the paint.sl studio light"
shading.studio_light = "paint.sl"
shading.color_type = "OBJECT"
shading.show_object_outline = False
shading.show_cavity = False
shading.show_shadows = False
shading.show_specular_highlight = False

world = bpy.data.worlds.new("blockout-world")
world.color = tuple(bake["background"])
scene.world = world

# ---- meshes ----
meshes = {}
for key, spec in bake["meshes"].items():
    mesh = bpy.data.meshes.new(key)
    mesh.from_pydata([tuple(p) for p in spec["positions"]], [], [tuple(f) for f in spec["faces"]])
    mesh.update()
    if spec["smooth"]:
        mesh.shade_smooth()
    else:
        mesh.shade_flat()
    meshes[key] = mesh

# ---- objects ----
objects = {}
for node in bake["nodes"]:
    ob = bpy.data.objects.new(node["id"], meshes[node["mesh"]])
    ob.color = tuple(node["color"])
    ob.rotation_mode = "QUATERNION"
    ob["blockout_group"] = node["group"]
    if "static" in node:
        ob.location = tuple(node["static"]["pos"])
        x, y, z, w = node["static"]["quat"]
        ob.rotation_quaternion = (w, x, y, z)
    if node.get("overviewOnly"):
        ob["blockout_overview_only"] = True
        ob.hide_render = True  # the reference video never shows the overview helpers
    scene.collection.objects.link(ob)
    objects[node["id"]] = ob

n_frames = bake["durationFrames"]
for node_id, rows in bake["frames"].items():
    assert len(rows) == n_frames, "%s: %d rows for %d frames" % (node_id, len(rows), n_frames)
    ob = objects[node_id]
    for frame, (px, py, pz, qx, qy, qz, qw) in enumerate(rows):
        ob.location = (px, py, pz)
        ob.rotation_quaternion = (qw, qx, qy, qz)
        ob.keyframe_insert("location", frame=frame)
        ob.keyframe_insert("rotation_quaternion", frame=frame)

# ---- cameras ----
def make_camera(name, focal):
    data = bpy.data.cameras.new(name)
    data.sensor_fit = "HORIZONTAL"  # focal length and sensor width are horizontal, like the Three.js side assumes
    data.sensor_width = bake["sensorWidth"]
    data.lens = focal
    data.clip_start = 0.05
    data.clip_end = 500.0
    ob = bpy.data.objects.new(name, data)
    ob.rotation_mode = "QUATERNION"
    scene.collection.objects.link(ob)
    return ob

cam = make_camera("blockout-camera", bake["camera"][0][7])
for frame, (px, py, pz, qx, qy, qz, qw, focal) in enumerate(bake["camera"]):
    cam.location = (px, py, pz)
    cam.rotation_quaternion = (qw, qx, qy, qz)
    cam.data.lens = focal
    cam.keyframe_insert("location", frame=frame)
    cam.keyframe_insert("rotation_quaternion", frame=frame)
    cam.data.keyframe_insert("lens", frame=frame)
scene.camera = cam

ov = bake["overview"]
ov_cam = make_camera("blockout-overview", ov["focalLength"])
ov_cam.location = tuple(ov["pos"])
x, y, z, w = ov["quat"]
ov_cam.rotation_quaternion = (w, x, y, z)

# the .blend says what it is, so it can be checked without the tool that made it
scene["blockout_scene_id"] = bake["scene"]["id"]
scene["blockout_scene_sha256"] = bake["scene"]["sha256"]
scene["blockout_overview_frame"] = ov["frame"]
scene["blockout_frames"] = n_frames

bpy.ops.wm.save_as_mainfile(filepath=out_blend, compress=False)
print("BLOCKOUT-BUILT objects=%d frames=%d" % (len(objects), n_frames))
