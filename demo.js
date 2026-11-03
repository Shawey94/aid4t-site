/* AID4T Engine — static demo layer (GitHub Pages).
   Answers the web client's /api/* requests in the browser from a JSON snapshot in data/.
   Search and filters run locally; accounts, downloads, processing and free-form Ask T need the full engine. */
(() => {
  const DEMO_MSG = "Not available in the static demo: accounts, data downloads and server-side processing run on the full AID4T Engine.";
  const realFetch = window.fetch.bind(window);
  const cache = {};
  const load = async (p) => { const d = (window.AID4T_DEMO_DATA || {})[p]; if (d === undefined) throw new Error(p); return d; };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const deny = () => json({ detail: DEMO_MSG }, 403);

  // ---------------------------------------------------------------- geometry
  const R = 6371.0088, rad = (d) => (d * Math.PI) / 180;
  function hav(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pointPathKm(p, path) {
    if (path.length === 1) return hav(p, path[0]);
    const kx = 111.32 * Math.cos(rad(p[0])), ky = 110.57;
    const xy = (q) => [(q[1] - p[1]) * kx, (q[0] - p[0]) * ky];
    let best = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, ay] = xy(path[i]), [bx, by] = xy(path[i + 1]);
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }
  function segHitsBox(a, b, [x0, y0, x1, y1]) { // a,b = [lat,lon]; Liang-Barsky in lon/lat
    let t0 = 0, t1 = 1;
    const dx = b[1] - a[1], dy = b[0] - a[0];
    for (const [p, q] of [[-dx, a[1] - x0], [dx, x1 - a[1]], [-dy, a[0] - y0], [dy, y1 - a[0]]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  }
  const pathInBox = (path, box) => path.length === 1 ? segHitsBox(path[0], path[0], box)
    : path.slice(1).some((q, i) => segHitsBox(path[i], q, box));
  const boxAround = (lat, lon, km) => { const dl = km / 110.57, dn = km / (111.32 * Math.cos(rad(lat))); return [lon - dn, lat - dl, lon + dn, lat + dl]; };

  // ------------------------------------------------------------------- query
  const ms = (s) => Date.parse(s.length <= 10 ? s + "T00:00:00Z" : /Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
  const isoS = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  async function runQuery(spec) {
    const [events, mods, gz] = await Promise.all([load("events.json"), load("modalities.json"), load("gazetteer.json")]);
    const allMods = mods.modalities.map((m) => m.id);
    const stateCode = (s) => { s = String(s).trim(); const u = s.toUpperCase(); if (gz.states[u]) return u;
      const byName = Object.entries(gz.states).find(([, v]) => v[0].toLowerCase() === s.toLowerCase()); return byName ? byName[0] : gz.state_zh[s] || null; };
    const q = JSON.parse(JSON.stringify(spec));
    const facets = [];
    if ((q.event_ids || []).length || q.text || q.ef_min != null || q.ef_max != null) facets.push("event");
    if (q.bbox || q.point || q.place || (q.states || []).length) facets.push("location");
    if ((q.modalities || []).length) facets.push("modality");
    if (q.start || q.end) facets.push("time");
    q.modalities = (q.modalities || []).flatMap((m) => allMods.includes(m) ? [m]
      : mods.modalities.filter((x) => (x.name + " " + x.id + " " + x.category).toLowerCase().includes(String(m).toLowerCase())).map((x) => x.id));
    q.modalities = [...new Set(q.modalities)];
    q.states = (q.states || []).map(stateCode).filter(Boolean);
    if (q.place && !q.point && !q.bbox) {
      const p = gz.places[q.place.trim().toLowerCase()] || gz.places[q.place.trim()];
      if (p) q.point = { lat: p[0], lon: p[1], radius_km: q.radius_km || 40 };
      else if (stateCode(q.place)) q.states.push(stateCode(q.place));
    }
    let start = q.start ? ms(q.start) : null, end = q.end ? ms(q.end) : null;
    if (q.start && !q.end) end = start + (q.start.length <= 10 ? 864e5 : 6 * 36e5);
    else if (q.end && q.end.length <= 10) end = end + 864e5 - 1000;
    if (end != null) q.end = isoS(end);
    const box = q.bbox || (q.point ? boxAround(q.point.lat, q.point.lon, q.point.radius_km) : q.states.length === 1 ? gz.states[q.states[0]][1] : null);
    const wanted = q.modalities.length ? q.modalities : allMods;
    const ids = (q.event_ids || []).map((i) => String(i).toUpperCase().replace(/^TDN-/, "AID4T-"));
    const text = (q.text || "").toLowerCase();
    let rows = [];
    for (const ev of events) {
      if (ids.length) { if (!ids.includes(ev.tdn_id)) continue; }
      else {
        if (start != null && ms(ev.end_utc) < start) continue;
        if (end != null && ms(ev.start_utc) > end) continue;
        if (q.states.length && !q.states.includes(ev.state)) continue;
        if (q.ef_min != null && ev.ef < q.ef_min) continue;
        if (q.ef_max != null && ev.ef > q.ef_max) continue;
        if (text && !(ev.name + " " + ev.tdn_id + " " + JSON.stringify(ev.tags)).toLowerCase().includes(text)) continue;
      }
      const rec = { ...ev, distance_km: null };
      if (q.point) {
        const d = pointPathKm([q.point.lat, q.point.lon], ev.path);
        if (d > q.point.radius_km) continue;
        rec.distance_km = Math.round(d * 10) / 10;
      } else if (q.bbox && !pathInBox(ev.path, q.bbox)) continue;
      const avail = Object.fromEntries(wanted.map((m) => [m, ev.availability[m] || "unavailable"]));
      const ok = wanted.filter((m) => avail[m] === "available");
      if (q.require === "all" && ok.length < wanted.length) continue;
      if (q.require === "any" && !ok.length) continue;
      rows.push({ ...rec, availability: avail, n_obtainable: ok.length });
    }
    rows.sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0) || a.start_utc.localeCompare(b.start_utc));
    rows = rows.slice(0, q.limit || 200);
    return { query: q, facets, n_events: rows.length, modalities: wanted, events: rows,
      events_per_modality: Object.fromEntries(wanted.map((m) => [m, rows.filter((r) => r.availability[m] === "available").length])),
      free_window: null, search_bbox: box, generated_utc: isoS(Date.now()) };
  }

  // --------------------------------------------------------------------- ask
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  async function ask(body) {
    const asks = await load("asks.json");
    const hit = Object.entries(asks).find(([k]) => norm(k) === norm(body.question));
    if (hit) return { ...hit[1], conversation_id: "demo", turn: 1 };
    return { backend: "askt", conversation_id: "demo", turn: 1, ask_id: "demo",
      answer: "In this static demo, T answers the example questions below. Free-form questions and follow-ups run on the full AID4T Engine. " +
              "You can also use the filters on the left — search runs in your browser.",
      parsed: { understood: false, query: null }, trace: [], sources: [],
      options: Object.keys(asks).map((k) => ({ label: k })) };
  }

  // ------------------------------------------------------------- the router
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const p = url.pathname.replace(/^.*?(\/api\/)/, "/api/");
    if (!p.startsWith("/api/")) return realFetch(input, opts);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    try {
      if (p === "/api/health") return json(await load("health.json"));
      if (p === "/api/modalities") return json(await load("modalities.json"));
      if (p === "/api/workflows") return json(await load("workflows.json"));
      if (p === "/api/query" && method === "POST") return json(await runQuery(body));
      if (p === "/api/ask" && method === "POST") return json(await ask(body));
      if (p === "/api/auth/me") return json({ user: null });
      if (p === "/api/auth/logout") return json({ ok: true });
      if (method === "GET" && ["/api/datasets", "/api/downloads", "/api/jobs"].includes(p)) return json([]);
      const m = p.match(/^\/api\/events\/([^/]+)\/(inventory|features|arco)$/);
      if (m && method === "GET") return json((await load(`events/${decodeURIComponent(m[1]).toUpperCase().replace(/^TDN-/, "AID4T-")}.json`))[m[2]]);
    } catch (e) { return json({ detail: "Not in the demo snapshot: " + e.message }, 404); }
    return deny();
  };

  document.addEventListener("DOMContentLoaded", () => {
    const body = document.getElementById("authBody");
    if (body) body.insertAdjacentHTML("beforeend", `<p class="hint demo-note">${DEMO_MSG}</p>`);
  });
})();
