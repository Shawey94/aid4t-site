/* AID4T Engine — web client. Talks only to the public REST API. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, credentials: "same-origin", ...opts });
  if (r.status === 401 && !path.startsWith("/api/auth/")) {
    const expired = !!ME;
    if (expired) { ME = null; renderAuthArea(); }
    showAuth(expired ? "Your sign-in has ended — please sign in again."
      : "Sign in with a free AID4T Engine account to download data or request processed results.");
    throw new Error("401: sign in required");
  }
  if (!r.ok) {
    let msg = await r.text();
    try { msg = JSON.parse(msg).detail || msg; } catch (_) {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return r.json();
};
const EF_COLORS = ["#8fb3c9", "#6a9f58", "#d0a21b", "#d9731c", "#c23b22", "#7d1f6e"];
const STATES = { AL: "Alabama", AR: "Arkansas", CO: "Colorado", GA: "Georgia", IA: "Iowa", IL: "Illinois", IN: "Indiana", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", MN: "Minnesota", MO: "Missouri", MS: "Mississippi", NC: "North Carolina", ND: "North Dakota", NE: "Nebraska", OH: "Ohio", OK: "Oklahoma", SD: "South Dakota", TN: "Tennessee", TX: "Texas", WI: "Wisconsin", WY: "Wyoming" };
const EXAMPLES = [
  "Get radar and damage data for the Joplin tornado",
  "EF4+ tornadoes in Oklahoma between 1999 and 2015 with mobile radar",
  "NEXRAD and HRRR within 60 km of Rolla on 2019-05-23",
  "2013年5月 摩尔附近的雷达数据",
  "vortex table for El Reno 2013",
  "climatology of violent tornadoes since 2000",
  "download raw data for AID4T-20240521-IA-01",
];

let ME = null, LICENSES = {};
let MODS = [], WFS = [], map, layer, searchLayer, picking = false, lastResult = null;

// ------------------------------------------------------------------ init
async function init() {
  const sel = $('select[name="states"]');
  Object.entries(STATES).forEach(([k, v]) => sel.insertAdjacentHTML("beforeend", `<option value="${k}">${v}</option>`));
  EXAMPLES.forEach((e) => $("#examples").insertAdjacentHTML("beforeend", `<button type="button">${esc(e)}</button>`));
  $$("#examples button").forEach((b) => (b.onclick = () => { $("#askInput").value = b.textContent; $("#askForm").requestSubmit(); }));

  const [health, mods, wfs] = await Promise.all([api("/api/health"), api("/api/modalities"), api("/api/workflows")]);
  const llmOk = health.llm && health.llm.ok && health.llm_backend !== "rules";
  $("#modeBadge").textContent = `${health.mode} mode · ${health.n_events} events · Ask T: ${llmOk ? health.llm_backend + " (LLM)" : "rules only (no LLM)"}`;
  $("#modeBadge").title = health.llm?.reason || "";
  if (health.llm?.reason) { $("#askNote").hidden = false; $("#askNote").textContent = `LLM not in use: ${health.llm.reason}`; }
  MODS = mods.modalities; WFS = wfs; LICENSES = mods.licenses || {};
  await startVisit();
  await refreshMe();
  const byCat = {};
  MODS.forEach((m) => (byCat[m.category] ||= []).push(m));
  $("#modList").innerHTML = Object.entries(byCat).map(([c, ms]) => `<h4>${esc(c)}</h4>` +
    ms.map((m) => `<label title="${esc(m.provider)} — ${esc(m.description)}"><input type="checkbox" name="mod" value="${m.id}">${esc(m.name)}</label>`).join("")).join("");

  initMap();
  $("#qForm").onsubmit = (e) => { e.preventDefault(); search(); };
  $("#qForm").onreset = () => setTimeout(() => { clearLoc(); search(); }, 0);
  $("#askForm").onsubmit = (e) => { e.preventDefault(); ask(); };
  $("#newConv").onclick = newConversation;
  $$(".preset").forEach((b) => (b.onclick = () => { $('[name="start"]').value = b.dataset.s; $('[name="end"]').value = b.dataset.e; }));
  $("#pickPoint").onclick = () => { picking = !picking; $("#pickPoint").classList.toggle("active", picking); };
  $("#useExtent").onclick = useExtent;
  $("#clearLoc").onclick = clearLoc;
  $("#closeDrawer").onclick = () => ($("#drawer").hidden = true);
  $("#drawer").onclick = (e) => { if (e.target.id === "drawer") $("#drawer").hidden = true; };
  $("#refreshJobs").onclick = loadJobs;
  $("#bulkDl").onclick = bulkDownload;
  $("#dsBtn").onclick = createDataset;
  $("#refreshDs").onclick = loadDatasets;
  $("#refreshDl").onclick = loadDownloads;
  initAuthUI();
  search();
  if (ME) { loadJobs(); loadDownloads(); }
  loadDatasets();
}

function initMap() {
  if (!window.L) { $("#map").classList.add("map-fallback"); $("#map").textContent = "Map library unavailable (offline) — all queries still work."; return; }
  map = L.map("map", { worldCopyJump: true }).setView([37.5, -93], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
  layer = L.layerGroup().addTo(map);
  searchLayer = L.layerGroup().addTo(map);
  map.on("click", (e) => {
    if (!picking) return;
    $('[name="point"]').value = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
    $('[name="bbox"]').value = ""; $("#bboxHint").textContent = "";
    picking = false; $("#pickPoint").classList.remove("active");
    drawSearchArea();
  });
}

function useExtent() {
  if (!map) return;
  const b = map.getBounds();
  const bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => +x.toFixed(3));
  $('[name="bbox"]').value = bb.join(",");
  $('[name="point"]').value = "";
  $("#bboxHint").textContent = `bbox: ${bb.join(", ")}`;
  drawSearchArea();
}
function clearLoc() {
  ["point", "bbox", "place"].forEach((n) => ($(`[name="${n}"]`).value = ""));
  $('[name="states"]').value = ""; $("#bboxHint").textContent = "";
  searchLayer && searchLayer.clearLayers();
}
function drawSearchArea(res) {
  if (!map) return;
  searchLayer.clearLayers();
  const p = $('[name="point"]').value, bb = $('[name="bbox"]').value;
  if (p) {
    const [lat, lon] = p.split(",").map(Number);
    L.circle([lat, lon], { radius: (+$('[name="radius_km"]').value || 50) * 1000, color: "#2f7a5b", weight: 1.5, fillOpacity: 0.06 }).addTo(searchLayer);
  } else if (bb) {
    const [a, b, c, d] = bb.split(",").map(Number);
    L.rectangle([[b, a], [d, c]], { color: "#2f7a5b", weight: 1.5, fillOpacity: 0.04 }).addTo(searchLayer);
  } else if (res?.query?.point) {
    const q = res.query.point;
    L.circle([q.lat, q.lon], { radius: q.radius_km * 1000, color: "#2f7a5b", weight: 1.5, fillOpacity: 0.06 }).addTo(searchLayer);
  } else if (res?.search_bbox) {
    const [a, b, c, d] = res.search_bbox;
    L.rectangle([[b, a], [d, c]], { color: "#2f7a5b", weight: 1, dashArray: "4", fillOpacity: 0.02 }).addTo(searchLayer);
  }
}

// ----------------------------------------------------------------- query
function formSpec() {
  const f = new FormData($("#qForm"));
  const spec = { modalities: f.getAll("mod"), require: f.get("require") };
  if (f.get("text")) spec.text = f.get("text");
  if (f.get("event_ids")) spec.event_ids = f.get("event_ids").split(/[\s,]+/).filter(Boolean);
  if (f.get("ef_min")) spec.ef_min = +f.get("ef_min");
  if (f.get("ef_max")) spec.ef_max = +f.get("ef_max");
  if (f.get("states")) spec.states = [f.get("states")];
  if (f.get("start")) spec.start = f.get("start");
  if (f.get("end")) spec.end = f.get("end");
  const r = +f.get("radius_km") || 50;
  if (f.get("point")) { const [lat, lon] = f.get("point").split(",").map(Number); spec.point = { lat, lon, radius_km: r }; }
  else if (f.get("bbox")) spec.bbox = f.get("bbox").split(",").map(Number);
  else if (f.get("place")) { spec.place = f.get("place"); spec.radius_km = r; }
  return spec;
}

async function search(spec) {
  spec = spec || formSpec();
  try {
    const res = await api("/api/query", { method: "POST", body: JSON.stringify(spec) });
    render(res);
  } catch (e) { $("#summary").innerHTML = `<span class="chip">Query error: ${esc(e.message)}</span>`; }
}

function render(res) {
  lastResult = res;
  const facets = res.facets.length ? res.facets.join(" + ") : "all events";
  $("#summary").innerHTML = `<span class="chip">Query facets: <b>${esc(facets)}</b></span>` +
    `<span class="chip"><b>${res.n_events}</b> event(s)</span>` +
    Object.entries(res.events_per_modality).filter(([, n]) => n).slice(0, 10)
      .map(([m, n]) => `<span class="chip">${esc(modName(m))}: <b>${n}</b></span>`).join("");
  // matrix
  const asked = (res.query.modalities || []).length > 0;
  const mods = asked ? res.modalities : res.modalities.filter((m) => res.events_per_modality[m] > 0);
  const head = `<tr><th>Event</th><th>EF</th><th>Date (UTC)</th><th>km</th>${mods.map((m) => `<th class="rot"><div>${esc(modName(m))}</div></th>`).join("")}</tr>`;
  const rows = res.events.map((e) => `<tr class="ev" data-id="${e.tdn_id}"><td><b>${esc(e.name)}</b><br><small>${e.tdn_id}</small></td>
     <td><span class="ef ef${e.ef}">EF${e.ef}</span></td><td>${e.start_utc.slice(0, 16).replace("T", " ")}</td>
     <td>${e.distance_km ?? ""}</td>${mods.map((m) => e.availability[m] === "available" ? `<td class="cell" title="${esc(modName(m))}: available"><span class="available"></span></td>` : '<td class="cell"></td>').join("")}</tr>`).join("");
  $("#matrix").innerHTML = head + (rows || `<tr><td colspan="${mods.length + 4}">No catalogued events match.</td></tr>`);
  $$("#matrix tr.ev").forEach((tr) => (tr.onclick = () => openEvent(tr.dataset.id)));
  // map
  if (map) {
    layer.clearLayers();
    const bounds = [];
    res.events.forEach((e) => {
      const pl = L.polyline(e.path, { color: EF_COLORS[e.ef] || "#555", weight: 3 + (e.ef || 0) }).addTo(layer);
      pl.bindTooltip(`${e.name} · EF${e.ef} · ${e.start_utc.slice(0, 10)}`);
      pl.on("click", () => openEvent(e.tdn_id));
      bounds.push(...e.path);
    });
    drawSearchArea(res);
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
  }
  const canWin = Object.values(res.free_window || {}).some((rs) => rs.some((r) => r.status === "available"));
  $("#winLabel").hidden = !canWin;
  $("#bulkDl").disabled = !res.n_events && !canWin;
  $("#dsBtn").disabled = !res.n_events;
  $("#dsBtn").textContent = res.n_events ? `Create AI-ready dataset (${res.n_events} event${res.n_events > 1 ? "s" : ""})` : "Create AI-ready dataset";
  $("#bulkDl").textContent = `Download data for ${res.n_events} event(s)` + (canWin ? " / window" : "");
  $("#bulkOut").innerHTML = "";
  // free window
  const fw = Object.entries(res.free_window || {}).map(([m, rs]) => [m, rs.filter((r) => r.status === "available")]).filter(([, rs]) => rs.length);
  $("#freePanel").hidden = !fw.length;
  $("#free").innerHTML = fw.map(([m, rs]) => `<div class="free-group"><h3>${esc(modName(m))}</h3>${rs.map(resHTML).join("")}</div>`).join("");
}

const modName = (id) => (MODS.find((m) => m.id === id) || { name: id }).name;

function resHTML(r) {
  const link = r.url && /^https?:/.test(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">source ↗</a>` : "";
  const bits = [r.provider, r.n_files != null && r.status === "available" ? `${r.n_files} file(s)` : "",
    r.est_size_mb && r.status === "available" ? `~${r.est_size_mb} MB` : "",
    r.time_start ? `${r.time_start} → ${r.time_end}` : "", r.contributor ? `contributed by ${r.contributor}` : "",
    r.license ? `license ${r.license}` : ""].filter(Boolean).join(" · ");
  const ver = r.verified ? ' <span class="ver" title="Files listed at the source">✓ verified</span>' : "";
  return `<div class="res"><span class="dot-ok"></span><div><div class="t">${esc(r.title || "")}${ver}</div>
    <div class="n">${esc(bits)} ${link}${r.note ? `<br><i>${esc(r.note)}</i>` : ""}</div></div></div>`;
}

// -------------------------------------------------------------- downloads
const fmtMB = (b) => (b / 1e6 >= 1000 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB");

async function startDownload(spec, el) {
  if (!ME) { showAuth("Downloading data requires a free AID4T Engine account."); return; }
  el.innerHTML = '<div class="dl">Submitting request…</div>';
  try {
    const d = await api("/api/downloads", { method: "POST", body: JSON.stringify(spec) });
    pollDownload(d.id, el);
    loadDownloads();
  } catch (e) {
    el.innerHTML = `<div class="dl err">${esc(e.message)}</div>`;
  }
}

function downloadHTML(d) {
  const p = d.progress || {};
  const pct = Math.min(99, Math.max(p.items_total ? (100 * p.items_done) / p.items_total : 0,
    d.est_size_mb ? (100 * (p.bytes_done || 0)) / (d.est_size_mb * 1e6) : 0)) | 0;
  const ready = d.status === "ready" || d.status === "partial";
  const active = ["queued", "fetching", "packaging"].includes(d.status);
  const bar = !active ? "" : `<div class="bar"><span style="width:${pct}%"></span></div>
     <div class="hint">AID4T Engine is fetching from the sources: ${p.items_done || 0}/${p.items_total || 0} resources · ${p.files_done || 0} files · ${fmtMB(p.bytes_done || 0)}${d.est_size_mb ? ` of ~${fmtMB(d.est_size_mb * 1e6)}` : ""}</div>`;
  const link = d.url ? `<a class="btn" href="${d.url}">Download zip (${fmtMB(d.zip_size_mb * 1e6)}, ${d.n_files} files)</a>
     <div class="hint">Ready = prepared on the AID4T Engine server (kept ${7} days). Click to save it to your computer.</div>` : "";
  const failed = (d.failed || []).length ? `<details><summary>${d.failed.length} item(s) could not be fetched right now — try again later</summary><ul>${d.failed.map((f) => `<li>${esc(f.group)} · ${esc(modName(f.modality))}: ${esc(f.error)}</li>`).join("")}</ul></details>` : "";
  return `<div class="dl"><b>${d.id}</b> · ${esc(d.summary || "")} · <span class="st ${ready ? "available" : d.status === "failed" ? "error" : "warn"}">${d.status}</span>
    ${bar}${link}${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}${failed}</div>`;
}

async function pollDownload(id, el) {
  for (;;) {
    const d = await api(`/api/downloads/${id}`);
    if (el) el.innerHTML = downloadHTML(d);
    if (["ready", "partial", "failed"].includes(d.status)) { loadDownloads(); return d; }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function loadDownloads() {
  if (!ME) { $("#downloads").innerHTML = '<div class="hint">Sign in to download data. AID4T Engine fetches everything from the sources and prepares one zip on its server.</div>'; return; }
  const list = await api("/api/downloads");
  if (!list.length) { $("#downloads").innerHTML = '<div class="hint">No downloads yet. Select data and click “Download”. AID4T Engine fetches everything from the sources and prepares one zip on its server.</div>'; return; }
  const full = await Promise.all(list.slice(0, 6).map((d) => api(`/api/downloads/${d.id}`)));
  $("#downloads").innerHTML = full.map(downloadHTML).join("");
}

function bulkDownload() {
  if (!lastResult || !lastResult.n_events && !lastResult.free_window) return;
  const spec = { query: lastResult.query, modalities: lastResult.query.modalities || [],
    free_window: $("#withWindow").checked };
  if (lastResult.query.event_ids) spec.event_ids = lastResult.query.event_ids;
  startDownload(spec, $("#bulkOut"));
}

// ------------------------------------------------- AI-ready federated datasets
async function createDataset() {
  if (!lastResult || !lastResult.n_events) return;
  if (!ME) { showAuth("Creating datasets requires a free AID4T Engine account."); return; }
  const obj = $("#dsObjective").value.trim();
  if (obj.length < 5) { $("#bulkOut").innerHTML = '<div class="ask-warn">Describe the research objective first (it is stored with the dataset).</div>'; $("#dsObjective").focus(); return; }
  $("#bulkOut").innerHTML = '<div class="hint">Linking raw data, event metadata/labels and Zarr products…</div>';
  try {
    const spec = { research_objective: obj, query: lastResult.query, modalities: lastResult.query.modalities || [],
      feature_label: $("#dsTornadic").checked ? "tornadic" : null };
    const d = await api("/api/datasets", { method: "POST", body: JSON.stringify(spec) });
    $("#bulkOut").innerHTML = `<div class="hint">Created <b>${esc(d.id)}</b> ${esc(d.version)} — see “AI-ready datasets” below.</div>`;
    loadDatasets(d.id);
  } catch (e) { $("#bulkOut").innerHTML = `<div class="ask-warn">${esc(e.message)}</div>`; }
}

function datasetHTML(d, open) {
  return `<div class="job dsitem" data-id="${esc(d.id)}"><b>${esc(d.id)}</b> ${esc(d.version)} · ${esc(d.name)}
    ${d.synthetic ? ' <span class="st warn">includes synthetic demo input</span>' : ""}${d.shared ? ' <span class="st available">shared</span>' : ""}
    <div class="meta">${d.n_events} events · ${d.n_raw} raw-data links (~${d.size.raw_est_mb} MB at the sources, not copied) · ${d.n_feature_scans} feature rows · ${d.n_zarr} Zarr stores (${d.size.zarr_mb} MB)${d.n_gaps ? ` · ${d.n_gaps} gaps` : ""} · ${esc(d.created_utc)}</div>
    <div class="hint">Objective: ${esc(d.research_objective)}</div>
    <div class="dsbtns"><button class="ghost small" data-act="code">Python access</button>
      <a class="small" href="/api/datasets/${esc(d.id)}/manifest.json" target="_blank">manifest.json</a>
      <a class="small" href="/api/datasets/${esc(d.id)}/files/features.csv">features.csv</a>
      <button class="ghost small" data-act="zip">Fetch raw data as zip</button></div>
    <div class="snip" ${open ? "" : "hidden"}><div class="snip-bar"><span class="hint">Set <code>export TDN_API_KEY=…</code> (My account) first.</span><button class="ghost small" data-act="copy">Copy</button></div><pre>${esc(d.snippet || "")}</pre></div>
    <div class="dsout"></div></div>`;
}

async function loadDatasets(openId) {
  if (!ME) { $("#datasets").innerHTML = '<div class="hint">Sign in, search for events, describe your research objective and click “Create AI-ready dataset”. A dataset links raw data at their sources, event metadata &amp; labels and Zarr products — nothing is copied.</div>'; return; }
  const list = await api("/api/datasets");
  if (!list.length) { $("#datasets").innerHTML = '<div class="hint">No datasets yet. Search for events, describe your research objective above the results table and click “Create AI-ready dataset”.</div>'; return; }
  const full = await Promise.all(list.slice(0, 8).map((d) => api(`/api/datasets/${d.id}`)));
  $("#datasets").innerHTML = full.map((d) => datasetHTML(d, d.id === openId)).join("");
  $$("#datasets .dsitem").forEach((el) => {
    const d = full.find((x) => x.id === el.dataset.id);
    $$("button", el).forEach((b) => b.onclick = async () => {
      if (b.dataset.act === "code") { const sn = $(".snip", el); sn.hidden = !sn.hidden; return; }
      if (b.dataset.act === "copy") { try { await navigator.clipboard.writeText(d.snippet); b.textContent = "Copied"; } catch (_) { b.textContent = "Select & copy"; } setTimeout(() => (b.textContent = "Copy"), 1500); return; }
      if (b.dataset.act === "zip") {
        try { const r = await api(`/api/datasets/${d.id}/download`, { method: "POST" }); $(".dsout", el).innerHTML = `<div class="hint">Download ${esc(r.id)} started — see the Downloads panel.</div>`; loadDownloads(); }
        catch (e) { $(".dsout", el).innerHTML = `<div class="ask-warn">${esc(e.message)}</div>`; }
      }
    });
  });
}

// ----------------------------------------------------------------- event
async function openEvent(id) {
  $("#drawer").hidden = false;
  $("#drawerBody").innerHTML = '<div class="hint">Checking every source for this event…</div>';
  const inv = await api(`/api/events/${id}/inventory`);
  const e = inv.event;
  const mods = Object.entries(inv.modalities);
  const nAvail = mods.length;
  const groups = mods.map(([m, g]) => `<div class="mgroup"><h4>${esc(modName(m))}</h4>${g.resources.map(resHTML).join("")}</div>`).join("");
  const picks = mods.map(([m, g]) => {
    const mb = g.resources.filter((r) => r.status === "available").reduce((a, r) => a + (r.est_size_mb || 0), 0);
    return `<label><input type="checkbox" name="dlmod" value="${m}" ${mb > 200 ? "" : "checked"}>${esc(modName(m))} <small>${mb < 0.1 ? "&lt;0.1" : "~" + (mb < 10 ? mb.toFixed(1) : mb.toFixed(0))} MB</small></label>`;
  }).join("");
  $("#drawerBody").innerHTML = `<h2>${esc(e.name)} <span class="ef ef${e.ef}">EF${e.ef}</span></h2>
    <div class="meta">${e.tdn_id} · ${e.start_utc} → ${e.end_utc} · ${e.path_length_km} km · ${e.duration_min} min
      ${e.max_width_m ? `· max width ${e.max_width_m} m` : ""}${e.fatalities != null ? ` · ${e.fatalities} fatalities` : ""}
      <br>Radars: ${e.nexrad.join(", ")} · tags: ${e.tags.join(", ")} ${e.verified ? "" : "· <i>seed geometry (approximate)</i>"}</div>
    <div class="dlbox"><h3>Download data <small>${nAvail} data type(s)</small></h3>
      <div class="picks">${picks || '<span class="hint">Nothing available for this event.</span>'}</div>
      ${picks ? '<button id="dlBtn">Prepare download</button> <span class="hint">Large items (&gt;200 MB) are not pre-selected. The zip is saved by your browser (usually to Downloads).</span>' : ""}<div id="dlOut"></div></div>
    <div id="featBox"></div>
    <div id="arcoBox"></div>
    <div class="wf"><select id="wfSel">${WFS.filter((w) => !["event_package", "federated_dataset"].includes(w.id)).map((w) => `<option value="${w.id}">${esc(w.name)}${w.runnable_offline ? "" : " (plan)"}</option>`).join("")}</select>
      <button id="runWf" class="ghost">Run analysis on server</button></div>
    <p class="hint" id="wfDesc"></p>
    <div id="wfOut"></div>
    <h3 style="margin-top:14px">Available data</h3>${groups}`;
  if (inv.modalities.hrrr) $(".picks").insertAdjacentHTML("afterend", '<label class="opt"><input type="checkbox" id="hrrrSub"> HRRR: selected fields only (~40 MB/h instead of original files ~530 MB/h; extraction recorded in manifest)</label>');
  if ($("#dlBtn")) $("#dlBtn").onclick = () => startDownload({ event_ids: [id], modalities: $$('input[name="dlmod"]:checked').map((x) => x.value), hrrr_subset: !!$("#hrrrSub")?.checked }, $("#dlOut"));
  loadFeatures(id);
  loadArco(id);
  const desc = () => { const w = WFS.find((x) => x.id === $("#wfSel").value); $("#wfDesc").textContent = `${w.description} Steps: ${w.steps.map((s) => s.id).join(" → ")}.`; };
  $("#wfSel").onchange = desc; desc();
  $("#runWf").onclick = async () => {
    if (!ME) { showAuth("Requesting processed results requires a free AID4T Engine account."); return; }
    $("#wfOut").innerHTML = "Running…";
    const j = await api("/api/jobs", { method: "POST", body: JSON.stringify({ workflow: $("#wfSel").value, event_ids: [id] }) });
    const done = await api(`/api/jobs/${j.id}?wait=60`);
    $("#wfOut").innerHTML = jobHTML(done);
    loadJobs();
  };
}

// Event-level metadata & labels (feature store)
const STAGE_COLORS = { "pre-tornadic": "#b9c4cc", "intensifying": "#e0a03a", "mature": "#c23b22", "decaying": "#8f6bb3", "post-tornadic": "#b9c4cc", "gap": "#e8ecea", "non-tornadic": "#b9c4cc" };
async function loadFeatures(id) {
  let f;
  try { f = await api(`/api/events/${id}/features${ME ? "?scans=true" : ""}`); } catch (_) { return; }
  if (!f.available || !$("#featBox")) return;
  const L = f.lifecycle, S = f.summary, lab = f.labels;
  const t = (x) => (x ? x.slice(11, 16) + "Z" : "–");
  const bar = (f.scans || []).map((s) => `<span class="fseg" style="background:${STAGE_COLORS[s.stage] || "#ccc"}" title="${esc(s.scan_time)} · ${esc(s.stage)} · ΔV ${s.delta_v_kts ?? "–"} kt"></span>`).join("");
  $("#featBox").innerHTML = `<div class="arco"><h3>Event metadata &amp; labels <small>${esc(f.version)} · algorithm ${esc(f.algorithm.id)} ${esc(f.algorithm.version)}</small>${f.synthetic ? ' <span class="st warn">synthetic demo input</span>' : ""}</h3>
    <div class="meta">${L.detected ? `Radar-detected vortex ${t(L.onset_utc)} → ${t(L.end_utc)} (${L.radar_duration_min} min) · peak ΔV ${L.peak_delta_v_kts} kt at ${t(L.peak_utc)} · mature ${t(L.mature_start_utc)}–${t(L.mature_end_utc)}` : "No tornado-scale vortex detected by the current rule."}</div>
    <div class="meta">Scans: ${S.n_scans} (${lab.scan_labels.tornadic} tornadic, ${lab.scan_labels["non-tornadic"]} non-tornadic) · EF${lab.ef_rating ?? "?"} (survey) · vortex structure: ${esc(lab.vortex_structure)} · mean translation ${S.mean_translation_ms ?? "–"} m/s · radars ${esc(S.radars.join(", "))}</div>
    ${bar ? `<div class="fbar">${bar}</div><div class="hint">${Object.entries(STAGE_COLORS).filter(([k]) => ["pre-tornadic", "intensifying", "mature", "decaying"].includes(k)).map(([k, c]) => `<span class="fkey" style="background:${c}"></span>${k}`).join(" ")} · one block per radar scan</div>` : ""}
    <div class="hint">Tornadic rule: ${esc(lab.tornadic_rule)}. ${ME ? `<a href="/api/events/${id}/features.csv">Per-scan feature table (CSV)</a>` : "Sign in to get the per-scan feature table."}</div></div>`;
}

// Analysis-ready (Zarr) products: open remotely with xarray, read only the chunks needed
async function loadArco(id) {
  let r;
  try { r = await api(`/api/events/${id}/arco`); } catch (_) { return; }
  if (!r.products.length || !$("#arcoBox")) return;
  $("#arcoBox").innerHTML = `<div class="arco"><h3>Analysis-ready data (Zarr) <small>stream subsets with Python — no full download</small></h3>
    ${r.products.map((p, i) => `<div class="arco-item">
      <b>${esc(p.name)}</b> <span class="st available">${esc(p.version)}</span>${p.synthetic ? ' <span class="st warn">synthetic demo input</span>' : ""}
      <div class="meta">${Object.entries(p.dims).map(([k, v]) => `${k} ${v}`).join(" × ")} · chunks ${Object.values(p.chunks).join("×")} · ${p.size_mb} MB · ${esc(p.time_range.join(" → "))} · ${esc(p.radars || "")}${p.grid_mode === "storm-following" ? " · storm-following grid" : ""}</div>
      <div class="hint">${esc(p.description)}</div>
      <button class="ghost small" data-i="${i}" data-act="show">Python access</button>
      <div class="snip" id="snip${i}" hidden>
        <div class="snip-bar"><span class="hint">Set your API key first: <code>export TDN_API_KEY=…</code> (My account). Reading requires a free account.</span><button class="ghost small" data-i="${i}" data-act="copy">Copy</button></div>
        <pre>${esc(p.snippet)}</pre></div></div>`).join("")}</div>`;
  $$("#arcoBox button").forEach((b) => b.onclick = async () => {
    const i = b.dataset.i, p = r.products[i];
    if (b.dataset.act === "show") { const el = $(`#snip${i}`); el.hidden = !el.hidden; return; }
    try { await navigator.clipboard.writeText(p.snippet); b.textContent = "Copied"; } catch (_) { b.textContent = "Select & copy"; }
    setTimeout(() => (b.textContent = "Copy"), 1500);
  });
}

function jobHTML(j) {
  const files = (j.files || []).map((f) => `<a href="/api/jobs/${j.id}/files/${f}" target="_blank">${esc(f)}</a>`).join(" · ");
  const flags = (j.flags || []).includes("DEMO_SYNTHETIC_INPUT") ? ` <span class="st warn">synthetic demo input</span>` : "";
  return `<div class="job"><b>${j.id}</b> · ${esc(j.spec?.workflow || "")} · <span class="st ${j.status === "completed" ? "available" : j.status === "failed" ? "error" : "warn"}">${j.status}</span>${flags}
    ${files ? `<div>files: ${files}</div>` : ""}
    ${j.pending?.length ? `<div>pending steps: ${j.pending.map((p) => esc(p.step + " (" + [].concat(p.requires).join(", ") + ")")).join("; ")}</div>` : ""}
    ${j.error ? `<div style="color:#c0392b">${esc(j.error)}</div>` : ""}
    ${j.result ? `<details><summary>result</summary><pre>${esc(JSON.stringify(j.result, null, 2))}</pre></details>` : ""}
    ${j.provenance ? `<details><summary>provenance (code ${esc(j.provenance.code.tdn_version)} · ${esc(j.provenance.code.code_sha256.slice(0, 10))}… · result ${esc(j.provenance.result_sha256.slice(0, 10))}…)</summary><pre>${esc(JSON.stringify({ workflow: j.provenance.workflow, inputs: j.provenance.inputs, request: j.provenance.request, environment: j.provenance.environment }, null, 2))}</pre></details>
      <button class="ghost small" onclick="reproduceJob('${j.id}', this)">Reproduce</button>` : ""}
    ${j.reproduction ? `<div class="${j.reproduction.identical_results ? "ok" : "err"}">Reproduction of ${esc(j.reproduction.of)}: ${j.reproduction.identical_results ? "identical results ✓" : "results differ"} · code ${j.reproduction.same_code ? "same" : "changed"} · inputs ${j.reproduction.same_inputs ? "same" : "changed"}</div>` : ""}</div>`;
}

async function reproduceJob(id, btn) {
  btn.disabled = true; btn.textContent = "Reproducing…";
  const r = await api(`/api/jobs/${id}/reproduce`, { method: "POST" });
  await api(`/api/jobs/${r.id}?wait=60`);
  loadJobs();
}

async function loadJobs() {
  if (!ME) { $("#jobs").innerHTML = '<div class="hint">Sign in to request processed results.</div>'; return; }
  const list = await api("/api/jobs");
  if (!list.length) { $("#jobs").innerHTML = '<div class="hint">No jobs yet. Open an event and run a workflow, or ask T.</div>'; return; }
  const full = await Promise.all(list.slice(0, 8).map((j) => api(`/api/jobs/${j.id}`)));
  $("#jobs").innerHTML = full.map(jobHTML).join("");
}

// ------------------------------------------------------------------- ask
let CONV_ID = null, TURNS = 0;
const ASK_PH = $("#askInput") ? $("#askInput").placeholder : "";

function newConversation() {
  CONV_ID = null; TURNS = 0;
  $("#askThread").innerHTML = ""; $("#askConv").hidden = true;
  $("#askInput").placeholder = ASK_PH; $("#askInput").focus();
}

function answerHTML(r) {
  const p = r.parsed || {};
  const by = r.backend === "rules" ? "rules parser (no LLM)" : r.backend;
  const notes = (p.notes || []).length && r.backend !== "rules" ? `<div class="ask-warn">${p.notes.map(esc).join("<br>")}</div>` : "";
  const ctx = (r.trace || []).find((t) => t.step === "conversation_context");
  return `<div class="ask-meta">Parsed by <b>${esc(by)}</b>${p.explanation ? ` — ${esc(p.explanation)}` : ""}${ctx ? ' · <span class="ctx">uses earlier turns</span>' : ""}</div>${notes}` +
    `<div class="ans">${esc((r.answer || "").trim())}</div>${r.warning ? `<div class="ask-warn">${esc(r.warning)}</div>` : ""}` +
    ((r.options || []).length ? `<div class="ask-opts">${r.options.map((o, i) => `<button type="button" class="ghost small opt" data-i="${i}">${esc(o.label)}</button>`).join("")}</div>${r.needs_choice && r.parsed?.understood !== false ? `<div class="ask-meta">${/[\u4e00-\u9fff]/.test(r.answer || "") ? "还没有取任何数据——请点选一个选项（也可以直接输入，如“第二个”）。" : "Nothing has been fetched yet — pick an option (or type, e.g. “the second one”)."}</div>` : ""}` : "") +
    `${(r.sources || []).length ? `<div class="ask-meta">Data sources: ${r.sources.map((s) => esc(s.name + " — " + s.provider)).join(" · ")}</div>` : ""}` +
    `<div class="ask-meta">Record <a href="#" title="Ask record (full engine)">${esc(r.ask_id)}</a> (structured query, sources, code &amp; catalog versions)</div>` +
    `<details><summary>Structured query sent to AID4T Engine</summary><pre>${esc(JSON.stringify({ query: p.query, workflow: p.workflow }, null, 2))}</pre></details>` +
    `<details><summary>Trace (${(r.trace || []).length} steps)</summary><pre>${esc(JSON.stringify(r.trace, null, 2))}</pre></details>`;
}

async function ask(text, choice) {
  const q = (typeof text === "string" ? text : $("#askInput").value).trim();
  if (!q) return;
  $("#askConv").hidden = false;
  const thread = $("#askThread");
  const turn = document.createElement("div");
  turn.className = "turn";
  turn.innerHTML = `<div class="q">${esc(q)}</div><div class="a ask-out">T is working…</div>`;
  thread.appendChild(turn);
  thread.scrollTop = thread.scrollHeight;
  $("#askInput").value = "";
  const out = turn.querySelector(".a");
  try {
    const r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: q, conversation_id: CONV_ID, ...(choice ? { choice } : {}) }) });
    CONV_ID = r.conversation_id; TURNS = r.turn;
    $("#convInfo").textContent = `Conversation · ${TURNS} turn${TURNS > 1 ? "s" : ""} — follow-up questions use the earlier turns`;
    $("#askInput").placeholder = "Ask a follow-up… e.g. “only EF4+”, “what about Missouri?”, “download the second one”, “那雷达数据呢”";
    out.innerHTML = answerHTML(r);
    $$(".ask-opts .opt", out).forEach((b) => b.onclick = () => {
      const o = r.options[+b.dataset.i];
      $$(".ask-opts .opt", out).forEach((x) => { x.disabled = true; x.classList.toggle("picked", x === b); });
      ask(o.label, o.choice || null);
    });
    thread.scrollTop = thread.scrollHeight;
    // mirror parsed query into the map/table
    if (r.parsed?.query && r.parsed.understood !== false) search(r.parsed.query);
    if (r.job && (r.job.flags || []).includes("DOWNLOAD") && r.job.id) {
      out.insertAdjacentHTML("beforeend", '<div class="askDl"></div>');
      pollDownload(r.job.id, out.querySelector(".askDl"));
    } else if (r.job) loadJobs();
  } catch (e) { out.textContent = "Error: " + e.message; }
}

init();


// ============================================================ accounts
// A sign-in lasts for one visit: when the site is opened in a new tab/window (or after the tab was closed),
// any earlier sign-in is cleared so the user signs in again. Reloading within the same tab keeps it.
async function startVisit() {
  let fresh = true;
  try { fresh = !sessionStorage.getItem("tdn_visit"); sessionStorage.setItem("tdn_visit", "1"); } catch (_) {}
  if (fresh) { try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {} }
}

async function refreshMe() {
  try { ME = (await api("/api/auth/me")).user; } catch (_) { ME = null; }
  renderAuthArea();
}

function renderAuthArea() {
  const el = $("#authArea");
  if (!el) return;
  if (!ME) { el.innerHTML = '<button class="small" id="signInBtn">Sign in / Register</button>'; $("#signInBtn").onclick = () => showAuth(); return; }
  el.innerHTML = `<span class="who">${esc(ME.name || ME.email)}${ME.role !== "user" ? ` <span class="st warn">${ME.role}</span>` : ""}</span>
    <button class="ghost small" id="acctBtn">Account</button>
    ${ME.role !== "user" ? '<button class="ghost small" id="adminBtn">Curation</button>' : ""}
    <button class="ghost small" id="signOutBtn">Sign out</button>`;
  $("#acctBtn").onclick = openAccount;
  if ($("#adminBtn")) $("#adminBtn").onclick = openAdmin;
  $("#signOutBtn").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); ME = null; renderAuthArea(); loadJobs(); loadDownloads(); loadDatasets(); };
}

function initAuthUI() {
  $("#authClose").onclick = () => ($("#authModal").hidden = true);
  $$("#authModal [data-tab]").forEach((b) => (b.onclick = () => authTab(b.dataset.tab)));
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: f.get("email"), password: f.get("password") }) });
      $("#authModal").hidden = true; await refreshMe(); loadJobs(); loadDownloads(); loadDatasets();
    } catch (err) { $("#authMsg").textContent = err.message; }
  };
  $("#registerForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api("/api/auth/register", { method: "POST", body: JSON.stringify(f) });
      await refreshMe(); loadJobs(); loadDownloads();
      $("#authBody").innerHTML = `<h3>Welcome, ${esc(r.user.name || r.user.email)}</h3><p>Your free account is ready. Your personal API key for scripts and AI agents (shown once):</p><pre>${esc(r.api_key)}</pre><p class="hint">Use it as the <code>X-API-Key</code> header, or set <code>TDN_API_KEY</code> for the local MCP server.</p>`;
    } catch (err) { $("#authMsg").textContent = err.message; }
  };
}

function authTab(t) {
  $$("#authModal [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $("#loginForm").hidden = t !== "login"; $("#registerForm").hidden = t !== "register";
}

function showAuth(msg) {
  $("#authModal").hidden = false;
  $("#authMsg").textContent = msg || "";
  authTab("login");
}

async function openAccount() {
  $("#drawer").hidden = false;
  const mine = await api("/api/contributions/mine");
  const modOpts = MODS.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  const licOpts = Object.entries(LICENSES).map(([k, v]) => `<option value="${k}">${k} — ${esc(v.note)}</option>`).join("") + '<option value="Other">Other (describe in description)</option>';
  $("#drawerBody").innerHTML = `<h2>My account</h2>
    <div class="meta">${esc(ME.email)} · ${esc(ME.affiliation || "")} · role: ${ME.role} · API key ${esc(ME.api_key_prefix)}… <button class="ghost small" id="newKey">Regenerate API key</button></div>
    <div id="keyOut"></div>
    <h3>Contribute data</h3>
    <p class="hint">Contributions stay private and pending until an AID4T Engine administrator or the data-category lead reviews them (metadata, license, consistency with the event's time and track). Approved data are published under the event id with your name and license.</p>
    <form id="contribForm" class="contrib">
      <label>AID4T event id(s) <input name="tdn_ids" required placeholder="AID4T-20130520-OK-01, …"></label>
      <label>Data type <select name="modality">${modOpts}</select></label>
      <label>Title <input name="title" required></label>
      <label>Provider (organisation / team) <input name="provider" required></label>
      <label>License <select name="license">${licOpts}</select></label>
      <label>Description <textarea name="description" rows="2"></textarea></label>
      <div class="row"><label>Data start (UTC) <input name="time_start" placeholder="2013-05-20T20:05Z"></label><label>Data end (UTC) <input name="time_end"></label></div>
      <div class="row"><label>Latitude <input name="lat" type="number" step="any"></label><label>Longitude <input name="lon" type="number" step="any"></label></div>
      <div class="row"><label><input type="radio" name="kind" value="upload" checked> Upload a file</label><label><input type="radio" name="kind" value="link"> Link to hosted data</label></div>
      <label id="fileRow">File <input type="file" name="file"></label>
      <label id="urlRow" hidden>URL <input name="url" placeholder="https://…/data.nc"></label>
      <button type="submit">Submit for review</button> <span id="contribMsg" class="hint"></span>
    </form>
    <h3>My contributions</h3>${mine.length ? mine.map(contribHTML).join("") : '<div class="hint">None yet.</div>'}`;
  $("#newKey").onclick = async () => { const r = await api("/api/auth/api-key", { method: "POST" }); $("#keyOut").innerHTML = `<pre>${esc(r.api_key)}</pre><div class="hint">${esc(r.note)}</div>`; refreshMe(); };
  $$('#contribForm input[name="kind"]').forEach((r) => (r.onchange = () => { const up = $('#contribForm input[name="kind"]:checked').value === "upload"; $("#fileRow").hidden = !up; $("#urlRow").hidden = up; }));
  $("#contribForm").onsubmit = submitContribution;
}

async function submitContribution(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { tdn_ids: f.get("tdn_ids").split(/[\s,]+/).filter(Boolean), modality: f.get("modality"), title: f.get("title"),
    provider: f.get("provider"), license: f.get("license"), description: f.get("description"), kind: f.get("kind"),
    url: f.get("url") || null, time_start: f.get("time_start") || null, time_end: f.get("time_end") || null,
    lat: f.get("lat") ? +f.get("lat") : null, lon: f.get("lon") ? +f.get("lon") : null };
  const msg = $("#contribMsg");
  try {
    msg.textContent = "Submitting…";
    let rec = await api("/api/contributions", { method: "POST", body: JSON.stringify(body) });
    const file = f.get("file");
    if (body.kind === "upload") {
      if (!file || !file.size) throw new Error("choose a file to upload");
      msg.textContent = `Uploading ${fmtMB(file.size)}…`;
      const r = await fetch(`/api/contributions/${rec.id}/file?filename=${encodeURIComponent(file.name)}`, { method: "PUT", body: file, credentials: "same-origin" });
      if (!r.ok) throw new Error((await r.json()).detail);
      rec = await r.json();
    }
    msg.textContent = `Submitted #${rec.id} — pending review.`;
    openAccount();
  } catch (err) { msg.textContent = err.message; }
}

function checksHTML(checks) {
  return `<ul class="checks">${(checks || []).map((c) => `<li class="${c.status}"><b>${esc(c.check)}</b> ${esc(c.status)} — ${esc(c.detail)}</li>`).join("")}</ul>`;
}

function contribHTML(c, curate = false) {
  return `<div class="mgroup"><h4>#${c.id} ${esc(c.title)} <span class="st ${c.status === "approved" ? "available" : c.status === "rejected" ? "error" : "warn"}">${c.status}</span></h4>
    <div class="n">${esc(modName(c.modality))} · ${esc(c.provider)} · ${esc(c.license)} · events ${esc(c.tdn_ids.join(", "))} · by ${esc(c.contributor)}
    ${c.kind === "link" ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">link</a>` : c.filename ? ` · ${esc(c.filename)} (${fmtMB(c.file_bytes || 0)})${curate ? ` <a href="/api/admin/contributions/${c.id}/file">inspect file</a>` : ""}` : ""}
    ${c.review_note ? `<br>review note: ${esc(c.review_note)}` : ""}</div>
    ${checksHTML(c.checks)}
    ${curate && c.status === "pending" ? `<div class="wf"><input id="note${c.id}" placeholder="review note"><button onclick="reviewContribution(${c.id}, 'approved')">Approve &amp; publish</button><button class="ghost" onclick="reviewContribution(${c.id}, 'rejected')">Reject</button></div>` : ""}</div>`;
}

async function openAdmin() {
  $("#drawer").hidden = false;
  $("#drawerBody").innerHTML = '<div class="hint">Loading…</div>';
  const pending = await api("/api/admin/contributions?status=pending");
  const backlog = await api("/api/admin/backlog");
  let metrics = "";
  if (ME.role === "admin") {
    const m = await api("/api/admin/metrics");
    metrics = `<h3>Usage metrics</h3><div class="meta">${m.users_total} accounts · ${m.active_users_30d} active (30 d) · by sector: ${esc(Object.entries(m.users_by_sector).map(([k, v]) => k + " " + v).join(", "))}</div>
      <pre>${esc(JSON.stringify({ by_kind: m.by_kind, by_month: m.by_month, downloads_by_modality: m.downloads_by_modality }, null, 2))}</pre>`;
  }
  $("#drawerBody").innerHTML = `<h2>Curation</h2>
    <div class="meta">${ME.role === "admin" ? "Administrator: all data types" : "Data-category lead: " + esc(ME.lead_modalities.map(modName).join(", "))}</div>
    <h3>Pending contributions (${pending.length})</h3>${pending.length ? pending.map((c) => contribHTML(c, true)).join("") : '<div class="hint">Nothing to review.</div>'}
    <h3>Ingest backlog (${backlog.length})</h3><div class="hint">Registered data that are not downloadable yet — obtain and upload to AID4T storage.</div>
    <ul class="checks">${backlog.slice(0, 50).map((b) => `<li>${esc(b.tdn_id)} · ${esc(modName(b.modality))} · ${esc(b.title)} — ${esc(b.provider)}</li>`).join("")}</ul>
    ${metrics}`;
}

async function reviewContribution(id, decision) {
  try {
    await api(`/api/admin/contributions/${id}/review`, { method: "POST", body: JSON.stringify({ decision, note: $(`#note${id}`).value }) });
    openAdmin();
    if (decision === "approved") search();
  } catch (e) { alert(e.message); }
}
