import os, sys, time, site, glob
# CTranslate2 needs the pip-installed CUDA 12 cuBLAS/cuDNN on the loader path.
libs = [d for p in site.getsitepackages() for d in glob.glob(p + "/nvidia/*/lib")]
if os.environ.get("_ASR_LIBS") != "1":
    os.environ["LD_LIBRARY_PATH"] = ":".join(libs + [os.environ.get("LD_LIBRARY_PATH", "")])
    os.environ["_ASR_LIBS"] = "1"
    os.execv(sys.executable, [sys.executable] + sys.argv)
from faster_whisper import WhisperModel
t = time.time()
m = WhisperModel("large-v3", device="cuda", compute_type="float16", download_root=os.path.expanduser("~/models/whisper"))
print(f"load {time.time()-t:.1f}s")
for f in sys.argv[1:]:
    t = time.time()
    segs, info = m.transcribe(f, beam_size=5, vad_filter=True)
    segs = list(segs)
    print(f"{os.path.basename(f)} lang={info.language} p={info.language_probability:.2f} audio={info.duration:.0f}s took={time.time()-t:.1f}s segs={len(segs)}")
    print("  first:", segs[0].text[:70] if segs else "-")
