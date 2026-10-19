"""Box-side preflight (CPU): run LatentSync's own face-detection rules on EVERY frame of each prepared input.
LatentSync raises "Face not detected" and aborts the whole clip if any single frame fails, so check before
spending CU. Mirrors latentsync/utils/face_detector.py @ a229c39 (insightface buffalo_l, det_size 512,
bbox w>=50 & h>=80, 0.2<=w/h<=1.5, det_score>=0.5, largest face wins).
usage: preflight_faces.py <root-with-models/buffalo_l> <video>..."""
import json, sys
import cv2, numpy as np
from insightface.app import FaceAnalysis

root, videos = sys.argv[1], sys.argv[2:]
app = FaceAnalysis(allowed_modules=["detection", "landmark_2d_106"], root=root, providers=["CPUExecutionProvider"])
app.prepare(ctx_id=-1, det_size=(512, 512))
report = {}
for path in videos:
    cap = cv2.VideoCapture(path); i = 0; fails = []; ws = []; hs = []; scores = []; multi = 0; mouth = []
    while True:
        ok, bgr = cap.read()
        if not ok: break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)  # LatentSync passes RGB frames (decord/cv2->RGB)
        faces = app.get(rgb); best = None; best_sz = 0
        if len(faces) > 1: multi += 1
        for f in faces:
            x1, y1, x2, y2 = f.bbox.astype(int).tolist(); w, h = x2 - x1, y2 - y1
            if w < 50 or h < 80 or w / h > 1.5 or w / h < 0.2 or f.det_score < 0.5: continue
            if w * h > best_sz: best_sz = w * h; best = (f, w, h)
        if best is None: fails.append(i)
        else:
            f, w, h = best; ws.append(w); hs.append(h); scores.append(float(f.det_score))
            l = f.landmark_2d_106; mouth.append(float(np.ptp(l[52:72, 0])))  # mouth landmark span (px)
        i += 1
    r = {"frames": i, "failedFrames": fails, "framesWithMultipleFaces": multi}
    if ws:
        r.update(bboxW=[min(ws), max(ws)], bboxH=[min(hs), max(hs)], detScore=[round(min(scores), 3), round(max(scores), 3)],
                 mouthSpanPx=[round(min(mouth)), round(max(mouth))])
    report[path] = r
print(json.dumps(report, indent=1))
sys.exit(1 if any(r["failedFrames"] or r["frames"] == 0 for r in report.values()) else 0)
