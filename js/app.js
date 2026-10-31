const REFRESH_MS = 10000;
const AHEAD_MINUTES = 5;
const EARTH_NM = 3440.065;
const CALLSIGN_RE = /^[A-Z]{3}\d[A-Z0-9]{0,5}$/;
const FLOWN = "#e2a84a";
const AHEAD = "#79c7ff";
const PHOSPHOR = "rgba(200, 245, 216, 0.9)";

const NAME_OVERRIDES = {
  AZA: "ITA Airways",
  BEL: "Brussels Airlines",
  TOM: "TUI Airways",
  TFL: "TUI fly",
  JAF: "TUI fly",
  FDB: "flydubai",
  EJU: "easyJet",
  EZS: "easyJet",
  RUK: "Ryanair",
  WMT: "Wizz Air",
  WUK: "Wizz Air",
  LAN: "LATAM",
  TAM: "LATAM",
  LPE: "LATAM",
  SWR: "SWISS",
  SAS: "SAS",
  IBE: "Iberia",
  AIC: "Air India",
  VTI: "Air India",
  MSR: "EgyptAir",
  SEJ: "SpiceJet",
};

const statusEl = document.querySelector("#status");
const updatedEl = document.querySelector("#updated");
const liveDot = document.querySelector("#live-dot");
const gateEl = document.querySelector("#gate");
const detailEl = document.querySelector("#detail");
const sourceLink = document.querySelector("#source-link");
const rangeButtons = [...document.querySelectorAll(".range button")];

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

const planes = new Map();
const routes = new Map();
const routeQueued = new Set();
const routeQueue = [];
let routeActive = 0;
let airlines = {};
let center = null;
let rangeNm = 40;
let trackNm = 40;
let expandedKey = "";
let armPin = false;
let selected = null;
let hits = [];
let scanGen = 0;
let scanAbort = null;
let pollTimer = 0;
let rangeTimer = 0;
let detailStamp = 0;
let map;

function motionOn() {
  return !motionQuery.matches;
}

function rad(deg) {
  return (deg * Math.PI) / 180;
}

function deg(value) {
  return (value * 180) / Math.PI;
}

function wrapLon(lon) {
  return ((lon + 540) % 360) - 180;
}

function wrapDelta(delta) {
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

function distanceNm(a, b) {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δφ = φ2 - φ1;
  const Δλ = rad(wrapDelta(b.lon - a.lon));
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(wrapDelta(b.lon - a.lon));
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  if (Math.abs(x) < 1e-8 && Math.abs(y) < 1e-8) return 0;
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function destination(lat, lon, bearingDeg, nm) {
  const δ = nm / EARTH_NM;
  const θ = rad(bearingDeg);
  const φ1 = rad(lat);
  const λ1 = rad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );
  return { lat: deg(φ2), lon: wrapLon(deg(λ2)) };
}

function slerp(a, b, f) {
  const φ1 = rad(a.lat);
  const λ1 = rad(a.lon);
  const φ2 = rad(b.lat);
  const λ2 = rad(b.lon);
  const Δ = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ));
  if (Δ < 1e-6) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * Δ) / Math.sin(Δ);
  const B = Math.sin(f * Δ) / Math.sin(Δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: deg(Math.atan2(z, Math.hypot(x, y))),
    lon: wrapLon(deg(Math.atan2(y, x))),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpLon(a, b, t) {
  return wrapLon(a + wrapDelta(b - a) * t);
}

function lerpAngle(a, b, t) {
  const delta = wrapDelta(b - a);
  return (a + delta * t + 360) % 360;
}

function buildPath(airports) {
  const points = [{ lat: airports[0].lat, lon: airports[0].lon }];
  for (let i = 0; i < airports.length - 1; i += 1) {
    const from = airports[i];
    const to = airports[i + 1];
    const dist = distanceNm(from, to);
    const steps = Math.max(1, Math.round(dist / 35));
    for (let step = 1; step <= steps; step += 1) {
      points.push(slerp(from, to, step / steps));
    }
  }
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    cum.push(cum[i - 1] + distanceNm(points[i - 1], points[i]));
  }
  return { points, cum, totalNm: cum[cum.length - 1] || 0 };
}

function projectSegment(p, a, b) {
  const cos = Math.max(0.2, Math.cos(rad((a.lat + b.lat) / 2)));
  const bx = wrapDelta(b.lon - a.lon) * 60 * cos;
  const by = (b.lat - a.lat) * 60;
  const px = wrapDelta(p.lon - a.lon) * 60 * cos;
  const py = (p.lat - a.lat) * 60;
  const len2 = bx * bx + by * by;
  if (len2 < 1e-6) {
    return { lat: a.lat, lon: a.lon, t: 0, crossNm: Math.hypot(px, py) };
  }
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const x = bx * t;
  const y = by * t;
  return {
    lat: a.lat + y / 60,
    lon: wrapLon(a.lon + x / (60 * cos)),
    t,
    crossNm: Math.hypot(px - x, py - y),
  };
}

function nearest(path, pos) {
  let best = null;
  for (let i = 0; i < path.points.length - 1; i += 1) {
    const a = path.points[i];
    const b = path.points[i + 1];
    const proj = projectSegment(pos, a, b);
    const alongNm = path.cum[i] + proj.t * (path.cum[i + 1] - path.cum[i]);
    if (!best || proj.crossNm < best.crossNm) {
      best = {
        lat: proj.lat,
        lon: proj.lon,
        crossNm: proj.crossNm,
        alongNm,
        bearing: bearing(a, b),
        index: i,
      };
    }
  }
  return best;
}

function matchLimit(totalNm) {
  return Math.min(12, Math.max(6, totalNm * 0.015));
}

function matchRoute(path, pos) {
  const hit = nearest(path, pos);
  if (!hit || hit.crossNm > matchLimit(path.totalNm)) return null;
  return hit;
}

function slicePath(path, hit) {
  const flown = path.points.slice(0, hit.index + 1);
  flown.push({ lat: hit.lat, lon: hit.lon });
  const ahead = [{ lat: hit.lat, lon: hit.lon }, ...path.points.slice(hit.index + 1)];
  return { flown, ahead };
}

function spanNm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distanceNm(points[i - 1], points[i]);
  return total;
}

function ringCross(a, b, origin, radiusNm) {
  let lo = 0;
  let hi = 1;
  const aInside = distanceNm(origin, a) <= radiusNm;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    const point = { lat: lerp(a.lat, b.lat, mid), lon: lerpLon(a.lon, b.lon, mid) };
    if ((distanceNm(origin, point) <= radiusNm) === aInside) lo = mid;
    else hi = mid;
  }
  const t = aInside ? hi : lo;
  return { lat: lerp(a.lat, b.lat, t), lon: lerpLon(a.lon, b.lon, t) };
}

function clipToDisk(points, origin, radiusNm) {
  if (!origin || points.length < 2) return [];
  const runs = [];
  let run = [];
  const push = (point) => {
    const last = run[run.length - 1];
    if (last && distanceNm(last, point) > radiusNm) {
      if (run.length > 1) runs.push(run);
      run = [point];
      return;
    }
    if (!last || distanceNm(last, point) > 0.05) run.push(point);
  };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const aInside = distanceNm(origin, a) <= radiusNm;
    const bInside = distanceNm(origin, b) <= radiusNm;
    if (aInside && bInside) {
      if (!run.length) push(a);
      push(b);
      continue;
    }
    if (aInside !== bInside) {
      const hit = ringCross(a, b, origin, radiusNm);
      if (aInside) {
        if (!run.length) push(a);
        push(hit);
      } else {
        push(hit);
        push(b);
      }
      continue;
    }
    const foot = projectSegment(origin, a, b);
    if (foot.crossNm <= radiusNm && foot.t > 0 && foot.t < 1) {
      const mid = { lat: foot.lat, lon: foot.lon };
      push(ringCross(a, mid, origin, radiusNm));
      push(mid);
      push(ringCross(mid, b, origin, radiusNm));
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function labelName(full) {
  let name = full.replace(/\s+\([^)]*\)\s*$/, "").trim();
  name = name.replace(/\s+(Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?|Company|Co\.?|System|Services)$/i, "").trim();
  if (name.length > 16) {
    const stripped = name.replace(/\s+(Airlines|Airways|Air Lines|Airline)$/i, "").trim();
    if (stripped.length >= 3 && stripped.length < name.length) name = stripped;
  }
  const words = name.split(/\s+/);
  while (words.length > 1 && words.join(" ").length > 16) words.pop();
  return words.join(" ");
}

function usableName(name) {
  if (!name) return "";
  const trimmed = name.trim();
  if (trimmed.length < 2 || /^\d+$/.test(trimmed)) return "";
  return trimmed;
}

function airlineCode(callsign, route) {
  if (route?.airlineCode && (NAME_OVERRIDES[route.airlineCode] || airlines[route.airlineCode])) {
    return route.airlineCode;
  }
  if (CALLSIGN_RE.test(callsign)) return callsign.slice(0, 3);
  return "";
}

function operatorOf(callsign, route) {
  const code = airlineCode(callsign, route);
  const full = usableName(NAME_OVERRIDES[code] || airlines[code] || "");
  return { code, full, short: full ? labelName(full) : "" };
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setLive(mode) {
  liveDot.classList.remove("ok", "wait", "bad");
  liveDot.classList.add(mode);
}

function showGate(text) {
  gateEl.hidden = false;
  gateEl.textContent = text;
}

function hideGate() {
  gateEl.hidden = true;
}

function setUpdated(date) {
  updatedEl.textContent = `Updated ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

function noteSource(source) {
  if (!source) return;
  sourceLink.textContent = source;
  sourceLink.href = source === "adsb.lol" ? "https://adsb.lol/" : "https://adsb.fi/";
}

function formatAlt(ft) {
  if (!Number.isFinite(ft)) return "—";
  if (ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, "0")}`;
  return `${Math.round(ft).toLocaleString()} ft`;
}

function formatNm(nm) {
  return `${Math.max(0, Math.round(nm)).toLocaleString()} nm`;
}

function sample(ac, now) {
  let t = ac.animMs <= 0 ? 1 : (now - ac.animStart) / ac.animMs;
  t = Math.max(0, Math.min(1, t));
  return {
    lat: lerp(ac.from.lat, ac.to.lat, t),
    lon: lerpLon(ac.from.lon, ac.to.lon, t),
    track: lerpAngle(ac.from.track || 0, ac.to.track || 0, t),
  };
}

function targetFor(row, callsign) {
  const reported = Number.isFinite(row.track) ? row.track : 0;
  const raw = { lat: row.lat, lon: row.lon, track: reported, onRoute: false };
  const route = routes.get(callsign);
  if (!route?.path) return raw;
  const hit = matchRoute(route.path, raw);
  if (!hit) return raw;
  return {
    lat: hit.lat,
    lon: hit.lon,
    track: Number.isFinite(hit.bearing) ? hit.bearing : reported,
    onRoute: true,
    alongNm: hit.alongNm,
  };
}

function pushHistory(ac) {
  const fix = ac.fix;
  if (!fix) return;
  const point = { lat: fix.lat, lon: fix.lon };
  const last = ac.history[ac.history.length - 1];
  if (last && distanceNm(last, point) < 0.12) return;
  ac.history.push(point);
  if (ac.history.length > 60) ac.history.shift();
}

function upsert(row, now) {
  const callsign = row.callsign || "";
  wantRoute(callsign);
  const prev = planes.get(row.hex);
  if (!prev) {
    const to = targetFor(row, callsign);
    planes.set(row.hex, {
      hex: row.hex,
      callsign,
      registration: row.registration || "",
      type: row.type || "",
      description: row.description || "",
      alt: row.alt,
      gs: row.gs,
      vert: row.vert,
      fix: row,
      history: [],
      from: to,
      to,
      animStart: now,
      animMs: 1,
      missingSince: 0,
    });
    return;
  }
  pushHistory(prev);
  prev.callsign = callsign;
  prev.registration = row.registration || prev.registration;
  prev.type = row.type || prev.type;
  prev.description = row.description || prev.description;
  prev.alt = row.alt;
  prev.gs = row.gs;
  prev.vert = row.vert;
  prev.fix = row;
  prev.missingSince = 0;
  const to = targetFor(row, callsign);
  if (to.onRoute && !prev.to.onRoute) {
    prev.from = to;
    prev.to = to;
    prev.animMs = 1;
  } else {
    const cur = sample(prev, now);
    prev.from = { lat: cur.lat, lon: cur.lon, track: cur.track };
    prev.to = to;
    prev.animMs = motionOn() ? REFRESH_MS : 1;
  }
  prev.animStart = now;
}

function applyTraffic(list, now) {
  const seen = new Set();
  for (const row of list) {
    if (!row?.hex) continue;
    seen.add(row.hex);
    upsert(row, now);
  }
  for (const [hex, ac] of planes) {
    if (seen.has(hex)) {
      ac.missingSince = 0;
      continue;
    }
    const place = ac.fix || ac.to;
    const outside = center && place && distanceNm(center, place) > rangeNm + 2;
    if (outside || (ac.missingSince && now - ac.missingSince > 30000)) {
      planes.delete(hex);
      if (selected === hex) clearSelection();
      continue;
    }
    if (!ac.missingSince) ac.missingSince = now;
  }
}

function attachRoute(callsign) {
  const now = performance.now();
  for (const ac of planes.values()) {
    if (ac.callsign !== callsign || !ac.fix || ac.to.onRoute) continue;
    const to = targetFor(ac.fix, callsign);
    if (!to.onRoute) continue;
    ac.from = to;
    ac.to = to;
    ac.animStart = now;
    ac.animMs = 1;
  }
}

function wantRoute(callsign) {
  if (!CALLSIGN_RE.test(callsign)) return;
  if (routes.has(callsign) || routeQueued.has(callsign)) return;
  routeQueued.add(callsign);
  routeQueue.push(callsign);
  pumpRoutes();
}

function pumpRoutes() {
  while (routeActive < 4 && routeQueue.length) {
    const callsign = routeQueue.shift();
    routeActive += 1;
    fetchRoute(callsign).finally(() => {
      routeActive -= 1;
      pumpRoutes();
    });
  }
}

async function fetchRoute(callsign) {
  const prefix = callsign.slice(0, 2);
  const url = `https://vrs-standing-data.adsb.lol/routes/${prefix}/${encodeURIComponent(callsign)}.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      routes.set(callsign, null);
      return;
    }
    const data = await response.json();
    const airports = (data._airports || [])
      .filter((airport) => Number.isFinite(airport.lat) && Number.isFinite(airport.lon))
      .map((airport) => ({
        name: airport.name || "",
        iata: airport.iata || "",
        icao: airport.icao || "",
        city: airport.location || airport.iata || airport.icao || "",
        lat: airport.lat,
        lon: airport.lon,
      }));
    if (airports.length < 2) {
      routes.set(callsign, null);
      return;
    }
    routes.set(callsign, {
      airlineCode: data.airline_code || "",
      airports,
      path: buildPath(airports),
    });
    attachRoute(callsign);
  } catch {
    routes.set(callsign, null);
  }
}

function fadeAlpha(ac, now) {
  if (!ac.missingSince) return 1;
  const age = now - ac.missingSince;
  if (age < 4000) return 1;
  return Math.max(0, 1 - (age - 4000) / 22000);
}

function paintLine(ctx, trace, color, width, dash) {
  ctx.beginPath();
  trace();
  ctx.lineWidth = width + 1.6;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.beginPath();
  trace();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);
}

function tracePoints(mapRef, points) {
  return () => {
    if (points.length < 2) return;
    const start = mapRef.latLngToContainerPoint([points[0].lat, points[0].lon]);
    ctxMove(start);
    for (let i = 1; i < points.length; i += 1) {
      const point = mapRef.latLngToContainerPoint([points[i].lat, points[i].lon]);
      ctxLine(point);
    }
  };
}

let drawCtx = null;
function ctxMove(point) { drawCtx.moveTo(point.x, point.y); }
function ctxLine(point) { drawCtx.lineTo(point.x, point.y); }

function drawPlane(ctx, track) {
  ctx.save();
  ctx.rotate(rad(track || 0));
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(4.4, 7);
  ctx.lineTo(0, 3.4);
  ctx.lineTo(-4.4, 7);
  ctx.closePath();
  ctx.fillStyle = "#f6fffa";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(6, 18, 14, 0.85)";
  ctx.stroke();
  ctx.restore();
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const RadarLayer = L.Layer.extend({
  onAdd(layerMap) {
    this._map = layerMap;
    this._canvas = L.DomUtil.create("canvas", "radar-canvas");
    this._canvas.setAttribute("aria-hidden", "true");
    layerMap.getPane("overlayPane").appendChild(this._canvas);
    layerMap.on("resize", this._resize, this);
    this._resize();
    const loop = (now) => {
      this._draw(now);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  },
  onRemove(layerMap) {
    cancelAnimationFrame(this._raf);
    layerMap.off("resize", this._resize, this);
    this._canvas.remove();
  },
  _resize() {
    const size = this._map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._size = size;
    this._dpr = dpr;
    this._canvas.width = Math.max(1, Math.round(size.x * dpr));
    this._canvas.height = Math.max(1, Math.round(size.y * dpr));
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
  },
  _draw(now) {
    const size = this._map.getSize();
    if (!this._size || size.x !== this._size.x || size.y !== this._size.y) this._resize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    const ctx = this._canvas.getContext("2d");
    drawCtx = ctx;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = "middle";

    const nextHits = [];
    if (center) this._drawScope(ctx, now, size);
    this._drawTraffic(ctx, now, size, nextHits);
    hits = nextHits;
    if (selected && now - detailStamp > 200) {
      detailStamp = now;
      renderDetail(now);
    }
  },
  _drawScope(ctx, now, size) {
    const origin = this._map.latLngToContainerPoint([center.lat, center.lon]);
    if (origin.x < -size.x || origin.y < -size.y || origin.x > size.x * 2 || origin.y > size.y * 2) return;
    const east = destination(center.lat, center.lon, 90, rangeNm);
    const edge = this._map.latLngToContainerPoint([east.lat, east.lon]);
    const radius = Math.max(12, Math.hypot(edge.x - origin.x, edge.y - origin.y));
    ctx.setLineDash([]);
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      const ring = radius * fraction;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, ring, 0, Math.PI * 2);
      ctx.lineWidth = fraction === 1 ? 1.25 : 1;
      ctx.strokeStyle = fraction === 1 ? "rgba(200, 245, 216, 0.38)" : "rgba(200, 245, 216, 0.18)";
      ctx.stroke();
      const label = `${Math.round(rangeNm * fraction)}`;
      ctx.fillStyle = "rgba(200, 245, 216, 0.55)";
      ctx.textAlign = "left";
      ctx.fillText(label, origin.x + ring + 4, origin.y);
    }
    ctx.fillStyle = "rgba(200, 245, 216, 0.7)";
    ctx.textAlign = "center";
    ctx.fillText("N", origin.x, origin.y - radius - 10);

    if (motionOn()) {
      const sweep = ((now / 14000) % 1) * Math.PI * 2;
      for (let i = 16; i >= 0; i -= 1) {
        const angle = sweep - i * 0.045;
        const alpha = 0.2 * (1 - i / 16) ** 1.6;
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(origin.x + Math.sin(angle) * radius, origin.y - Math.cos(angle) * radius);
        ctx.lineWidth = i === 0 ? 1.4 : 1;
        ctx.strokeStyle = `rgba(200, 245, 216, ${alpha})`;
        ctx.stroke();
      }
    }

    const pulse = motionOn() ? 0.5 + 0.5 * Math.sin(now / 420) : 0.4;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 9 + pulse * 7, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(200, 245, 216, ${0.35 - pulse * 0.15})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#f4fff8";
    ctx.fill();
  },
  _drawTraffic(ctx, now, size, nextHits) {
    const drawn = [];
    for (const ac of planes.values()) {
      const alpha = fadeAlpha(ac, now);
      if (alpha <= 0.02) continue;
      const pos = sample(ac, now);
      const point = this._map.latLngToContainerPoint([pos.lat, pos.lon]);
      drawn.push({ ac, pos, point, alpha });
    }
    drawn.sort((a, b) => {
      if (a.ac.hex === selected) return 1;
      if (b.ac.hex === selected) return -1;
      return 0;
    });

    const labels = [];
    for (const item of drawn) {
      const { ac, pos, point, alpha } = item;
      ctx.save();
      ctx.globalAlpha = alpha * (ac.hex === selected ? 1 : 0.72);
      this._drawLocus(ctx, ac, pos);
      ctx.globalAlpha = alpha;
      if (point.x >= -20 && point.y >= -20 && point.x <= size.x + 20 && point.y <= size.y + 20) {
        ctx.save();
        ctx.translate(point.x, point.y);
        if (ac.hex === selected) {
          ctx.beginPath();
          ctx.arc(0, 0, 13, 0, Math.PI * 2);
          ctx.strokeStyle = PHOSPHOR;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.scale(1.2, 1.2);
        }
        drawPlane(ctx, pos.track);
        ctx.restore();
        nextHits.push({ hex: ac.hex, x: point.x, y: point.y });
        labels.push(item);
      }
      ctx.restore();
    }

    const occupied = [];
    labels.sort((a, b) => {
      if (a.ac.hex === selected) return 1;
      if (b.ac.hex === selected) return -1;
      return distanceNm(center, a.pos) - distanceNm(center, b.pos);
    });
    for (const item of labels) {
      this._drawLabel(ctx, item, occupied, nextHits);
    }
  },
  _drawLocus(ctx, ac, pos) {
    const width = ac.hex === selected ? 2.5 : 1.65;
    const route = routes.get(ac.callsign);
    if (ac.to.onRoute && route?.path) {
      const hit = nearest(route.path, pos) || nearest(route.path, ac.to);
      if (hit) {
        const { flown, ahead } = slicePath(route.path, hit);
        this._strokeClipped(ctx, flown, FLOWN, width, []);
        this._strokeClipped(ctx, ahead, AHEAD, width, [5, 6]);
        return;
      }
    }
    const trail = ac.history.length ? [...ac.history, pos] : [];
    this._strokeClipped(ctx, trail, FLOWN, width, []);
    const speed = Number(ac.gs);
    if (speed >= 45) {
      const end = destination(pos.lat, pos.lon, pos.track || 0, speed * (AHEAD_MINUTES / 60));
      this._strokeClipped(ctx, [pos, end], AHEAD, width, [5, 6]);
    }
  },
  _strokeClipped(ctx, points, color, width, dash) {
    if (!center || points.length < 2) return;
    for (const run of clipToDisk(points, center, trackNm)) {
      if (spanNm(run) > 0.25) paintLine(ctx, tracePoints(this._map, run), color, width, dash);
    }
  },
  _drawLabel(ctx, item, occupied, nextHits) {
    const { ac, pos, point, alpha } = item;
    const route = routes.get(ac.callsign);
    const named = operatorOf(ac.callsign, route);
    const crowded = planes.size > 50;
    const text = named.short || (!crowded || ac.hex === selected
      ? (ac.registration || ac.callsign || ac.hex.toUpperCase())
      : "");
    if (!text) return;
    const heading = rad(pos.track || 0);
    let ox = Math.cos(heading);
    let oy = Math.sin(heading);
    if (ox < 0) {
      ox *= -1;
      oy *= -1;
    }
    if (Math.abs(ox) < 0.35) ox = 0.7;
    const anchorX = point.x + ox * 14;
    const anchorY = point.y + oy * 14;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = ox < 0 ? "right" : "left";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(text).width;
    const left = ctx.textAlign === "right" ? anchorX - width : anchorX;
    const box = { left: left - 5, top: anchorY - 8, right: left + width + 5, bottom: anchorY + 8 };
    const force = ac.hex === selected;
    if (!force && occupied.some((other) => boxesOverlap(box, other))) {
      ctx.restore();
      return;
    }
    occupied.push(box);
    nextHits.push({
      hex: ac.hex,
      x: (box.left + box.right) / 2,
      y: anchorY,
      pad: Math.max(22, width / 2 + 8),
    });
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(4, 12, 9, 0.88)";
    ctx.strokeText(text, anchorX, anchorY);
    ctx.fillStyle = force ? "#ffffff" : "rgba(244, 248, 242, 0.92)";
    ctx.fillText(text, anchorX, anchorY);
    ctx.restore();
  },
});

function renderDetail(now) {
  const ac = planes.get(selected);
  if (!ac) {
    clearSelection();
    return;
  }
  const pos = sample(ac, now || performance.now());
  const route = routes.get(ac.callsign);
  const named = operatorOf(ac.callsign, route);
  const op = named.full || ac.registration || ac.callsign || ac.hex.toUpperCase();
  const bits = [];
  if (named.full && ac.callsign) bits.push(ac.callsign);
  if (ac.description) bits.push(ac.description);
  else if (ac.type) bits.push(ac.type);
  document.querySelector("#detail-op").textContent = op;
  document.querySelector("#detail-sub").textContent = bits.join(" · ");
  const routeEl = document.querySelector("#detail-route");
  const progressEl = document.querySelector("#detail-progress");
  routeEl.hidden = true;
  progressEl.hidden = true;
  if (ac.to.onRoute && route?.path) {
    const hit = nearest(route.path, pos);
    if (hit) {
      routeEl.hidden = false;
      routeEl.textContent = route.airports.map((airport) => airport.city).filter(Boolean).join(" → ");
      progressEl.hidden = false;
      const left = Math.max(0, route.path.totalNm - hit.alongNm);
      progressEl.textContent = `${formatNm(hit.alongNm)} flown · ${formatNm(left)} along the direct track`;
    }
  }
  document.querySelector("#detail-alt").textContent = formatAlt(ac.alt);
  document.querySelector("#detail-gs").textContent = Number.isFinite(ac.gs) ? `${Math.round(ac.gs)} kt` : "—";
  document.querySelector("#detail-hdg").textContent = Number.isFinite(pos.track) ? `${Math.round(pos.track)}°` : "—";
  detailEl.hidden = false;
}

function clearSelection() {
  selected = null;
  detailEl.hidden = true;
}

function selectHex(hex) {
  selected = hex;
  detailStamp = 0;
  renderDetail(performance.now());
}

function pick(point) {
  let best = null;
  let bestDistance = Infinity;
  for (const hit of hits) {
    const limit = hit.pad || 22;
    const distance = Math.hypot(hit.x - point.x, hit.y - point.y);
    if (distance <= limit && distance < bestDistance) {
      best = hit.hex;
      bestDistance = distance;
    }
  }
  return best;
}

function fitBounds(points, maxZoom) {
  map.fitBounds(points, {
    paddingTopLeft: [28, 86],
    paddingBottomRight: [28, 78],
    animate: motionOn(),
    maxZoom,
  });
}

function fit() {
  if (!center) return;
  if (trackNm > rangeNm + 5 && planes.size) {
    const points = [[center.lat, center.lon]];
    for (const ac of planes.values()) {
      const place = ac.fix || ac.to;
      if (place) points.push([place.lat, place.lon]);
    }
    fitBounds(points, 7);
    return;
  }
  const corners = [0, 90, 180, 270].map((deg) => destination(center.lat, center.lon, deg, rangeNm));
  fitBounds(corners.map((point) => [point.lat, point.lon]), 12);
}

function fitExpanded(aircraft) {
  if (!center || !aircraft.length) return;
  const points = [[center.lat, center.lon], ...aircraft.map((item) => [item.lat, item.lon])];
  fitBounds(points, 7);
}

function adopt(lat, lon, fitView) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  if (!fitView && Math.abs(lat) < 0.02 && Math.abs(lon) < 0.02) return;
  const next = { lat, lon };
  const first = !center;
  const shifted = !center || distanceNm(center, next) >= 0.05;
  const relocated = first || fitView || distanceNm(center, next) >= 0.5;
  if (!first && !shifted && !fitView) return;
  center = next;
  expandedKey = "";
  hideGate();
  armPin = false;
  document.querySelector("#place").setAttribute("aria-pressed", "false");
  setLive("wait");
  if (first || fitView) fit();
  if (relocated) {
    scan();
    schedule();
  }
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = setInterval(scan, REFRESH_MS);
}

async function scan() {
  if (!center || document.hidden) return;
  const here = center;
  const nm = rangeNm;
  const gen = ++scanGen;
  scanAbort?.abort();
  const abort = new AbortController();
  scanAbort = abort;
  try {
    const url = `/api/traffic?lat=${here.lat.toFixed(4)}&lon=${here.lon.toFixed(4)}&nm=${nm}`;
    const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (gen !== scanGen) return;
    if (!response.ok) throw new Error(body.error || "The traffic feed is unavailable.");
    applyTraffic(body.aircraft || [], performance.now());
    noteSource(body.source);
    const count = body.count ?? (body.aircraft || []).length;
    if (body.expanded && body.nearestNm) {
      const way = body.direction ? ` ${body.direction}` : "";
      setStatus(`No flights inside ${nm} nm. Nearest is ${body.nearestNm} nm${way}.`);
      trackNm = Math.max(nm, body.nearestNm + 70);
      const key = `${here.lat.toFixed(1)}:${here.lon.toFixed(1)}:${nm}:${Math.round(body.nearestNm / 25)}`;
      if (expandedKey !== key) {
        expandedKey = key;
        fitExpanded(body.aircraft || []);
      }
    } else {
      expandedKey = "";
      trackNm = nm;
      setStatus(count === 0 ? "No airborne traffic in range" : `${count} airborne`);
    }
    setUpdated(new Date());
    setLive("ok");
  } catch (error) {
    if (error.name === "AbortError" || gen !== scanGen) return;
    setStatus(error.message || "The traffic feed is unavailable.");
    setLive("bad");
  }
}

function setRange(nm) {
  rangeNm = nm;
  trackNm = nm;
  expandedKey = "";
  for (const button of rangeButtons) {
    button.setAttribute("aria-pressed", button.dataset.nm === String(nm) ? "true" : "false");
  }
  if (!center) return;
  fit();
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(() => {
    scan();
    schedule();
  }, 200);
}

function requestGeo() {
  if (!navigator.geolocation) {
    armPin = true;
    showGate("This browser has no location service. Click the map to place the scanner.");
    setStatus("Click the map to place the scanner");
    setLive("wait");
    return;
  }
  showGate("Requesting this device’s location…");
  setStatus("Locating");
  setLive("wait");
  navigator.geolocation.watchPosition(
    (position) => adopt(position.coords.latitude, position.coords.longitude, false),
    (error) => {
      if (center) return;
      armPin = true;
      const denied = error.code === error.PERMISSION_DENIED;
      const message = denied
        ? "Location permission was denied. Click the map to place the scanner."
        : "Location is unavailable. Click the map to place the scanner.";
      showGate(message);
      setStatus("Click the map to place the scanner");
      setLive("wait");
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 },
  );
}

function bootMap() {
  map = L.map("map", {
    zoomControl: false,
    minZoom: 3,
    worldCopyJump: true,
    attributionControl: true,
  }).setView([20, 0], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  }).addTo(map);
  new RadarLayer().addTo(map);

  map.on("click", (event) => {
    if (armPin || !center) {
      adopt(event.latlng.lat, event.latlng.lng, true);
      return;
    }
    const hex = pick(event.containerPoint);
    if (hex) selectHex(hex);
    else clearSelection();
  });

  map.on("mousemove", (event) => {
    const container = map.getContainer();
    if (armPin || !center) {
      container.style.cursor = "crosshair";
      return;
    }
    container.style.cursor = pick(event.containerPoint) ? "pointer" : "";
  });
}

for (const button of rangeButtons) {
  button.addEventListener("click", () => setRange(Number(button.dataset.nm)));
}

document.querySelector("#recenter").addEventListener("click", () => {
  if (center) fit();
});

document.querySelector("#place").addEventListener("click", () => {
  armPin = !armPin;
  document.querySelector("#place").setAttribute("aria-pressed", armPin ? "true" : "false");
  if (armPin) {
    setStatus("Click the map to place the scanner");
    showGate("Click the map to place the scanner.");
    return;
  }
  if (center) {
    hideGate();
    setStatus("Scanning");
  }
});

document.querySelector("#detail-close").addEventListener("click", clearSelection);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearSelection();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && center) {
    scan();
    schedule();
  }
});

bootMap();

const params = new URLSearchParams(location.search);
const latArg = params.get("lat");
const lonArg = params.get("lon");
const queryLat = Number(latArg);
const queryLon = Number(lonArg);
if (latArg !== null && lonArg !== null && Number.isFinite(queryLat) && Number.isFinite(queryLon)) {
  adopt(queryLat, queryLon, true);
} else {
  requestGeo();
}

fetch("data/airlines.json")
  .then((response) => response.json())
  .then((payload) => {
    airlines = payload.names || {};
  })
  .catch(() => {
    airlines = {};
  });
