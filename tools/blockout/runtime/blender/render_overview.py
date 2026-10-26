# blender -b scene.blend -P render_overview.py -- out.png
# The layout still: the overview camera, the helper meshes (paths, camera frusta) shown.
import sys

import bpy

out_png = sys.argv[sys.argv.index("--") + 1]
scene = bpy.context.scene
for ob in bpy.data.objects:
    if ob.get("blockout_overview_only"):
        ob.hide_render = False
scene.camera = bpy.data.objects["blockout-overview"]
scene.frame_set(int(scene["blockout_overview_frame"]))
scene.render.filepath = out_png
scene.render.use_file_extension = False
bpy.ops.render.render(write_still=True)
print("BLOCKOUT-OVERVIEW", out_png)
