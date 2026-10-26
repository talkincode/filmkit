# blender -b scene.blend -P verify_seek.py -- bake.json outdir f1,f2,f3
# Random access, for real: jump to each listed frame IN THE GIVEN ORDER (not 0..N),
#   1. compare every animated object's world pose with what the evaluator baked, and
#   2. render that frame to outdir/seek_<frame>.png.
# The caller then compares those pixels with the sequentially rendered frames.
import json
import os
import sys

import bpy

bake_path, outdir, frame_list = sys.argv[sys.argv.index("--") + 1:][:3]
frames = [int(f) for f in frame_list.split(",") if f != ""]
os.makedirs(outdir, exist_ok=True)
with open(bake_path, "r", encoding="utf-8") as fh:
    bake = json.load(fh)

scene = bpy.context.scene
tolerance = 1e-4
worst = 0.0
for frame in frames:
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    for node_id, rows in bake["frames"].items():
        ob = bpy.data.objects[node_id]
        px, py, pz, qx, qy, qz, qw = rows[frame]
        loc, quat, _ = ob.matrix_world.decompose()
        err = max(abs(loc.x - px), abs(loc.y - py), abs(loc.z - pz))
        # q and -q are the same rotation
        dot = abs(quat.w * qw + quat.x * qx + quat.y * qy + quat.z * qz)
        err = max(err, 1.0 - min(1.0, dot))
        worst = max(worst, err)
        if err > tolerance:
            print("BLOCKOUT-STATE-MISMATCH frame=%d node=%s err=%g" % (frame, node_id, err))
            sys.exit(7)
    cam = bpy.data.objects["blockout-camera"]
    px, py, pz, qx, qy, qz, qw, focal = bake["camera"][frame]
    loc, quat, _ = cam.matrix_world.decompose()
    err = max(abs(loc.x - px), abs(loc.y - py), abs(loc.z - pz), abs(cam.data.lens - focal))
    worst = max(worst, err)
    if err > tolerance:
        print("BLOCKOUT-STATE-MISMATCH frame=%d node=camera err=%g" % (frame, err))
        sys.exit(7)
    scene.render.filepath = os.path.join(outdir, "seek_%04d" % frame)
    scene.render.use_file_extension = True
    bpy.ops.render.render(write_still=True)
print("BLOCKOUT-SEEK-OK frames=%s worst=%g" % (",".join(str(f) for f in frames), worst))
