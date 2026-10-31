#!/usr/bin/env python3
"""Local server for Tiny Radar.

Serves this folder and proxies live traffic. Browsers cannot call the public
feeds directly (they omit Access-Control-Allow-Origin), and airplanes.live
refuses unapproved clients. adsb.fi is the primary feed; adsb.lol is the fallback.

    python3 server.py

Then open the printed URL. Personal, non-commercial use only — cite adsb.fi.
"""

import json
import os
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
UPSTREAMS = (
    ("adsb.fi", "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}"),
    ("adsb.lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}"),
)
CACHE_SECONDS = 9
cache = {}


def num(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize(raw):
    alt_raw = raw.get("alt_baro")
    if alt_raw == "ground":
        return None
    alt = num(alt_raw)
    lat = num(raw.get("lat"))
    lon = num(raw.get("lon"))
    if alt is None or lat is None or lon is None or alt < -50:
        return None
    gs = num(raw.get("gs"))
    if alt < 150 and (gs is None or gs < 60):
        return None
    hex_id = str(raw.get("hex") or "").strip().lower()
    if not hex_id:
        return None
    track = num(raw.get("track"))
    if track is None:
        track = num(raw.get("true_heading"))
    if track is None:
        track = num(raw.get("mag_heading"))
    return {
        "hex": hex_id,
        "callsign": str(raw.get("flight") or "").strip().upper(),
        "lat": lat,
        "lon": lon,
        "track": track,
        "gs": gs,
        "alt": alt,
        "vert": num(raw.get("baro_rate")),
        "registration": str(raw.get("r") or "").strip().upper(),
        "type": str(raw.get("t") or "").strip().upper(),
        "description": str(raw.get("desc") or "").strip(),
    }


def pull(lat, lon, nm):
    failures = []
    headers = {
        "User-Agent": "TinyRadar/1.0 (personal local scanner)",
        "Accept": "application/json",
    }
    for name, template in UPSTREAMS:
        url = template.format(lat=f"{lat:.4f}", lon=f"{lon:.4f}", nm=int(nm))
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            code = getattr(exc, "code", "")
            print(f"traffic {name} failed: {exc.__class__.__name__} {code}", flush=True)
            failures.append(code)
            continue
        rows = payload.get("ac")
        if rows is None:
            rows = payload.get("aircraft") or []
        aircraft = []
        for raw in rows:
            item = normalize(raw)
            if item:
                aircraft.append(item)
        aircraft.sort(key=lambda item: (item["lat"] - lat) ** 2 + (item["lon"] - lon) ** 2)
        return {
            "source": name,
            "count": len(aircraft[:400]),
            "aircraft": aircraft[:400],
        }
    if 429 in failures:
        raise RuntimeError("The traffic feed is busy. Trying again shortly.")
    raise RuntimeError("The traffic feed is unreachable.")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/traffic":
            self.traffic(parsed)
            return
        super().do_GET()

    def traffic(self, parsed):
        query = parse_qs(parsed.query)
        try:
            lat = float(query["lat"][0])
            lon = float(query["lon"][0])
            nm = float(query.get("nm", ["40"])[0])
        except (KeyError, ValueError, IndexError):
            self.respond(400, {"error": "A latitude, longitude, and radius are required."})
            return
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            self.respond(400, {"error": "That location is out of range."})
            return
        nm = max(5, min(100, round(nm)))
        key = (round(lat, 2), round(lon, 2), nm)
        cached = cache.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < CACHE_SECONDS:
            self.respond(200, cached[1])
            return
        try:
            payload = pull(lat, lon, nm)
        except RuntimeError as exc:
            self.respond(502, {"error": str(exc)})
            return
        cache[key] = (now, payload)
        self.respond(200, payload)

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

def main():
    chosen = os.environ.get("TINY_RADAR_PORT", "").strip()
    ports = [int(chosen)] if chosen else range(8765, 8775)
    server = None
    for port in ports:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            if chosen:
                raise SystemExit(f"Port {chosen} is already in use.")
            continue
    if server is None:
        raise SystemExit("No free port between 8765 and 8774.")
    host, port = server.server_address
    print(f"Tiny Radar  http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
