# blender -b scene.blend -P validate_scene.py -- bake.json
# Blender validating its own native project: the file opens, and it contains exactly
# what the bake says (frame range, fps, resolution, objects, animation, camera).
import json
import sys

import bpy

with open(sys.argv[sys.argv.index("--") + 1], "r", encoding="utf-8") as fh:
    bake = json.load(fh)

scene = bpy.context.scene
errors = []

def check(ok, message):
    if not ok:
        errors.append(message)

check(scene.render.fps == bake["fps"] and scene.render.fps_base == 1.0, "fps is %s/%s, want %s" % (scene.render.fps, scene.render.fps_base, bake["fps"]))
check(scene.frame_start == 0 and scene.frame_end == bake["durationFrames"] - 1, "frame range %d..%d, want 0..%d" % (scene.frame_start, scene.frame_end, bake["durationFrames"] - 1))
check(scene.render.resolution_x == bake["width"] and scene.render.resolution_y == bake["height"], "resolution %dx%d" % (scene.render.resolution_x, scene.render.resolution_y))
check(scene.render.engine == "BLENDER_WORKBENCH", "render engine %s" % scene.render.engine)
check(scene.camera is not None and scene.camera.name == "blockout-camera", "scene camera is not blockout-camera")
check(scene.get("blockout_scene_sha256") == bake["scene"]["sha256"], "the .blend was built from a different declaration")
names = {ob.name for ob in bpy.data.objects}
for node in bake["nodes"]:
    check(node["id"] in names, "missing object %s" % node["id"])
for node_id in bake["frames"]:
    ob = bpy.data.objects.get(node_id)
    action = ob.animation_data.action if ob is not None and ob.animation_data else None
    check(action is not None, "%s has no animation" % node_id)
cam = bpy.data.objects.get("blockout-camera")
check(cam is not None and cam.data.sensor_fit == "HORIZONTAL" and abs(cam.data.sensor_width - bake["sensorWidth"]) < 1e-6, "camera sensor is not the declared horizontal width")
check(cam is not None and cam.animation_data is not None and cam.data.animation_data is not None, "camera or lens is not animated")
check("blockout-overview" in names, "missing overview camera")

print("BLOCKOUT-VALIDATE " + json.dumps({"ok": not errors, "errors": errors, "objects": len(bake["nodes"]), "frames": bake["durationFrames"], "blender": bpy.app.version_string}))
sys.exit(0 if not errors else 7)
