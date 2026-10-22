#!/usr/bin/env python3
"""PROTOTYPE — find barcodes (waybill / tracking numbers) in a packing video.

Runs on the LOCAL recorder PC, never on Railway. Needs only `ffmpeg` and
`zbarimg` (zbar-tools) on PATH — no pip packages.

  python3 surveillance-detect-waybill.py VIDEO [--fps 3] [--start ISO] [--scale 2]
         [--post https://idealone/api/public/surveillance/recordings --key KEY --station "PACKING STATION 4"]

Prints JSON: {"fileName", "detections": [{"offsetSec", "time", "value", "type"}]}
(consecutive duplicates collapsed). With --post it registers the recording
plus its detections through the Surveillance recorder index API.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, tempfile, urllib.request, glob

def frames(video, fps, scale, crop, tmp):
    vf = [f"fps={fps}"]
    if crop: vf.append(f"crop={crop}")
    if scale and scale != 1: vf.append(f"scale=iw*{scale}:ih*{scale}:flags=lanczos")
    vf.append("format=gray")
    subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vf", ",".join(vf), os.path.join(tmp, "f_%06d.png")], check=True)
    return sorted(glob.glob(os.path.join(tmp, "f_*.png")))

def scan(png):
    r = subprocess.run(["zbarimg", "--quiet", "--raw", "-Sdisable", "-Scode128.enable", "-Scode39.enable",
                        "-Sqrcode.enable", "-Sean13.enable", "-Si25.enable", png], capture_output=True, text=True)
    # --raw drops the symbology; re-run without it only when something was found
    if not r.stdout.strip(): return []
    r2 = subprocess.run(["zbarimg", "--quiet", png], capture_output=True, text=True)
    out = []
    for line in r2.stdout.splitlines():
        m = re.match(r"([A-Za-z0-9\-]+):(.*)", line)
        if m: out.append((m.group(2).strip(), m.group(1)))
    return out

def ocr(png, pattern):
    """Fallback when the barcode is too small to decode: OCR the printed tracking
    number. Less reliable (look-alike characters: O/0, E/B) — results are
    tagged type 'OCR' and the server only links EXACT matches."""
    r = subprocess.run(["tesseract", png, "-", "--psm", "11"], capture_output=True, text=True)
    return [(v, "OCR") for v in sorted(set(re.findall(pattern, r.stdout)))]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video"); ap.add_argument("--fps", type=float, default=3); ap.add_argument("--scale", type=float, default=2)
    ap.add_argument("--crop", help="ffmpeg crop w:h:x:y — e.g. just the box-sealing panel"); ap.add_argument("--start", help="recording start ISO time (default: from OBS file name, SGT)")
    ap.add_argument("--ocr", action="store_true", help="also OCR printed tracking numbers (needs tesseract)")
    ap.add_argument("--ocr-pattern", default=r"\b[0-9]{6}[A-Z0-9]{6,10}\b", help="regex for a tracking number")
    ap.add_argument("--post"); ap.add_argument("--key"); ap.add_argument("--station")
    a = ap.parse_args()
    start = None
    if a.start: start = dt.datetime.fromisoformat(a.start)
    else:
        m = re.search(r"(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})", os.path.basename(a.video))
        if m: start = dt.datetime(*map(int, m.groups()), tzinfo=dt.timezone(dt.timedelta(hours=8)))
    dets, last = [], {}
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames(a.video, a.fps, a.scale, a.crop, tmp)):
            off = round(i / a.fps, 2)
            found = scan(f)
            if a.ocr: found += ocr(f, a.ocr_pattern)
            for value, typ in found:
                if value in last and off - last[value] <= 2: last[value] = off; continue
                last[value] = off
                d = {"offsetSec": off, "value": value, "type": typ}
                if start: d["time"] = (start + dt.timedelta(seconds=off)).isoformat()
                dets.append(d)
    out = {"fileName": os.path.basename(a.video), "detections": dets}
    print(json.dumps(out, indent=2))
    if a.post:
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", a.video], capture_output=True, text=True).stdout or 0)
        body = {"fileName": out["fileName"], "station": a.station, "durationSec": round(dur),
                "detections": [{"offsetSec": d["offsetSec"], "value": d["value"], "type": d["type"]} for d in dets]}
        if start: body["startTime"] = start.isoformat()
        req = urllib.request.Request(a.post, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Recorder-Key": a.key or ""})
        print(urllib.request.urlopen(req).read().decode(), file=sys.stderr)

if __name__ == "__main__":
    main()
