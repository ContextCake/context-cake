// ContextCake · Cascade Playground — client.
// Talks only to the playground server's two endpoints:
//   GET /api/graph                  -> source topology + concept index
//   GET /api/resolve?concept=<id>   -> one concept resolved by the real engine
// Everything on screen is a rendering of that engine output.

// Index 0-2 are the brand provenance trio (personal/team/company, matching
// site + console); indices 3+ are extra hues for manifests with more than
// three layers, cycling after the trio.
const LAYER_PALETTE = ["#d9ab53", "#8dc3a8", "#8bbad1", "#f5b544", "#f472b6", "#facc15"];
const NODE_W = 240;
const RES_W = 264;

const ICON = {
  decision: `<svg viewBox="0 0 20 20" width="15" height="15"><path d="M10 2.5 17 6v8l-7 3.5L3 14V6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  runbook: `<svg viewBox="0 0 20 20" width="15" height="15"><path d="M5 3.5h9a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H5z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 3.5a2 2 0 0 0-2 2V17" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 8h5M7.5 11h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  interface: `<svg viewBox="0 0 20 20" width="15" height="15"><circle cx="6" cy="6" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="14" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 8.3V12a2 2 0 0 0 2 2h3.7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
  concept: `<svg viewBox="0 0 20 20" width="15" height="15"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
  warn: `<svg viewBox="0 0 20 20" width="13" height="13"><path d="M10 3 18 16H2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14" r="0.4" fill="currentColor" stroke="currentColor" stroke-width="0.8"/></svg>`,
};

const state = {
  graph: null,
  colors: {},        // layer name -> hex
  pos: {},           // node id -> {x, y}  (world coords)
  view: { x: 0, y: 0, scale: 1 },
  selectedConcept: null,
  selectedSource: null,
  filter: "",
  // Files mode
  mode: "canvas",
  files: null,
  openFilePath: null,
  editor: null,
  dirty: false,
  fview: "split",
  needsFit: false,
  resolvedCurrent: null,
};

const el = {
  world: document.getElementById("world"),
  nodes: document.getElementById("nodes"),
  edges: document.getElementById("edges"),
  viewport: document.getElementById("viewport"),
  conceptList: document.getElementById("conceptList"),
  conceptCount: document.getElementById("conceptCount"),
  railLegend: document.getElementById("railLegend"),
  manifestChip: document.getElementById("manifestChip"),
  inspector: document.getElementById("inspector"),
  inspectorEmpty: document.getElementById("inspectorEmpty"),
  inspectorBody: document.getElementById("inspectorBody"),
  omni: document.getElementById("omni"),
  zoomLevel: document.getElementById("zoomLevel"),
  stageHint: document.getElementById("stageHint"),
  stageStatus: document.getElementById("stageStatus"),
  stageStatusTitle: document.getElementById("stageStatusTitle"),
  stageStatusBody: document.getElementById("stageStatusBody"),
};

// init() is invoked at the very bottom of this module, after every top-level
// `const` (including the Files-mode `fx`) has been initialized.

async function init() {
  wireChrome();
  wireCanvas();
  wireFiles();
  wireSources();
  await boot();
}

// Load (or reload) the graph, surfacing a recoverable error state on failure
// instead of throwing into a blank canvas.
async function boot() {
  try {
    hideStatus();
    await loadGraph();
  } catch (err) {
    showStatus("Couldn't reach the engine", `The playground server didn't respond — <code>${escapeHtml(err.message)}</code>.<br>Make sure it's running: <code>npm run playground</code>`);
  }
}

function showStatus(title, bodyHtml) {
  el.stageStatusTitle.textContent = title;
  el.stageStatusBody.innerHTML = bodyHtml;
  el.stageStatus.classList.add("is-shown");
}
function hideStatus() { el.stageStatus.classList.remove("is-shown"); }

async function loadGraph() {
  applyGraph(await fetchJSON("/api/graph"), { relayout: true });
}

// Re-pull the concept index without disturbing canvas node positions/view.
// Used after a file save so the cascade reflects the edit while the user stays put.
async function refreshGraphData() {
  applyGraph(await fetchJSON("/api/graph"), { relayout: false });
}

function applyGraph(graph, { relayout }) {
  state.graph = graph;

  // Assign a color per layer by precedence rank (highest level first).
  const byPrecedence = [...graph.sources].sort((a, b) => b.level - a.level);
  byPrecedence.forEach((s, i) => { state.colors[s.name] = LAYER_PALETTE[i % LAYER_PALETTE.length]; });
  const [c0, c1, c2] = byPrecedence;
  if (c0) document.documentElement.style.setProperty("--c-personal", state.colors[c0.name]);
  if (c1) document.documentElement.style.setProperty("--c-team", state.colors[c1.name]);
  if (c2) document.documentElement.style.setProperty("--c-company", state.colors[c2.name]);

  renderLegend();
  renderConceptList();

  if (relayout) {
    layoutNodes();
    renderNodes();
    requestAnimationFrame(() => {
      renderEdges();
      // fitView measures element sizes — only valid when the canvas is visible.
      if (state.mode === "canvas") fitView(); else state.needsFit = true;
    });
  }

  el.manifestChip.textContent = graph.manifest.path.split("/").slice(-2).join("/");
}

// ---- Layout ---------------------------------------------------------------

function layoutNodes() {
  // Sources stacked by precedence (highest at top); Resolved node fans in on the right.
  const byPrec = [...state.graph.sources].sort((a, b) => b.level - a.level);
  const gapY = 168;
  byPrec.forEach((s, i) => { state.pos[srcId(s.name)] = { x: 60, y: 60 + i * gapY }; });
  const midY = 60 + ((byPrec.length - 1) * gapY) / 2;
  state.pos.__resolved = { x: 60 + NODE_W + 210, y: midY + 6 };
}

function fitView() {
  const boxes = Object.entries(state.pos).map(([id, p]) => {
    const node = document.getElementById(id);
    const w = node ? node.offsetWidth : NODE_W;
    const h = node ? node.offsetHeight : 150;
    return { x: p.x, y: p.y, w, h };
  });
  if (!boxes.length) return;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const vw = el.viewport.clientWidth;
  const vh = el.viewport.clientHeight;
  const pad = 64;
  const scale = Math.min(1.1, (vw - pad * 2) / (maxX - minX), (vh - pad * 2) / (maxY - minY));
  state.view.scale = clamp(scale, 0.4, 1.1);
  state.view.x = (vw - (maxX - minX) * state.view.scale) / 2 - minX * state.view.scale;
  state.view.y = (vh - (maxY - minY) * state.view.scale) / 2 - minY * state.view.scale;
  applyView();
}

function applyView() {
  const { x, y, scale } = state.view;
  el.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  el.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

// ---- Node rendering -------------------------------------------------------

function renderNodes() {
  el.nodes.innerHTML = "";
  for (const s of state.graph.sources) el.nodes.appendChild(sourceNode(s));
  el.nodes.appendChild(resolvedNode());
  for (const id of Object.keys(state.pos)) positionNode(id);
}

function sourceNode(s) {
  const id = srcId(s.name);
  const color = state.colors[s.name];
  const node = document.createElement("div");
  node.className = "node node--source";
  node.id = id;
  node.style.setProperty("--accent-node", color);
  node.dataset.source = s.name;
  node.setAttribute("aria-label", `Source ${s.name}, precedence level ${s.level}, ${s.conceptCount} concepts`);
  node.innerHTML = `
    <div class="node__head">
      <span class="node__badge">L${s.level}</span>
      <span class="node__name">${escapeHtml(s.name)}</span>
      <span class="node__kind">${escapeHtml(s.kind)}</span>
    </div>
    <div class="node__body">
      <div class="node__loc" title="${escapeHtml(s.location ?? "")}">${escapeHtml(s.location ?? "—")}</div>
      <div class="node__stats">
        <span class="node__stat"><b>${s.conceptCount}</b><span>concepts</span></span>
        <span class="node__stat"><b>${s.latestUpdated ?? "—"}</b><span>latest</span></span>
      </div>
    </div>
    <span class="node__port node__port--out"></span>`;
  makeDraggable(node, id, () => selectSource(s.name));
  return node;
}

function resolvedNode() {
  const node = document.createElement("div");
  node.className = "node node--resolved is-empty";
  node.id = "__resolved";
  node.setAttribute("aria-label", "Resolved concept output");
  node.innerHTML = `
    <div class="node__head">
      <span class="node__badge">OUT</span>
      <span class="node__name">Resolved concept</span>
    </div>
    <div class="resolved__body">
      <p class="resolved__concept">pick a concept →</p>
    </div>
    <span class="node__port node__port--in"></span>`;
  makeDraggable(node, "__resolved", () => { if (state.selectedConcept) selectConcept(state.selectedConcept); });
  return node;
}

function positionNode(id) {
  const node = document.getElementById(id);
  const p = state.pos[id];
  if (node && p) { node.style.left = `${p.x}px`; node.style.top = `${p.y}px`; }
}

// ---- Edges (fan-in, bezier) ----------------------------------------------

// Coalesce edge redraws to one per frame (drag fires pointermove far faster).
let edgeRaf = 0;
function scheduleEdges() {
  if (edgeRaf) return;
  edgeRaf = requestAnimationFrame(() => { edgeRaf = 0; renderEdges(); });
}

function renderEdges() {
  const res = document.getElementById("__resolved");
  if (!res) return;
  const rp = state.pos.__resolved;
  const inX = rp.x;
  const inY = rp.y + res.offsetHeight / 2;

  const contributors = state.selectedConcept
    ? new Set((conceptById(state.selectedConcept)?.contributors) ?? [])
    : null;

  const paths = state.graph.sources.map((s) => {
    const id = srcId(s.name);
    const node = document.getElementById(id);
    const p = state.pos[id];
    if (!node || !p) return "";
    const outX = p.x + node.offsetWidth;
    const outY = p.y + node.offsetHeight / 2;
    const d = bezier(outX, outY, inX, inY);
    const active = contributors && contributors.has(s.name);
    const dim = contributors && !contributors.has(s.name);
    const cls = ["edge", active ? "is-active is-flow" : "", dim ? "is-dim" : ""].join(" ").trim();
    return `<path class="${cls}" d="${d}" style="--edge-color:${state.colors[s.name]}"/>`;
  });
  el.edges.setAttribute("width", "6000");
  el.edges.setAttribute("height", "4000");
  el.edges.innerHTML = paths.join("");
}

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(60, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// ---- Left rail ------------------------------------------------------------

function renderLegend() {
  const byPrec = [...state.graph.sources].sort((a, b) => b.level - a.level);
  el.railLegend.innerHTML = byPrec.map((s) =>
    `<span class="legend-item"><i class="legend-dot" style="background:${state.colors[s.name]}"></i>${escapeHtml(s.name)} · L${s.level}</span>`
  ).join("");
}

function renderConceptList() {
  const q = state.filter.trim().toLowerCase();
  const items = state.graph.concepts.filter((c) => {
    if (!q) return true;
    return (`${c.title} ${c.id} ${c.type} ${c.contributors.join(" ")}`).toLowerCase().includes(q);
  });
  el.conceptCount.textContent = items.length;

  if (!items.length) {
    el.conceptList.innerHTML = state.filter
      ? `<div class="rail__empty">No concepts match “${escapeHtml(state.filter)}”.</div>`
      : `<div class="rail__empty">No concepts in this manifest yet.</div>`;
    return;
  }

  el.conceptList.innerHTML = items.map((c) => {
    const dots = c.contributors
      .map((name) => `<i style="background:${state.colors[name] ?? "#555"}" title="${escapeHtml(name)}"></i>`)
      .join("");
    const conflict = c.conflictCount
      ? `<span class="concept__conflict">${ICON.warn}${c.conflictCount}</span>` : "";
    return `
      <button class="concept ${c.id === state.selectedConcept ? "is-active" : ""}" role="option" data-id="${escapeAttr(c.id)}">
        <span class="concept__row1">
          <span class="concept__type">${ICON[c.type] ?? ICON.concept}</span>
          <span class="concept__title">${escapeHtml(c.title)}</span>
          ${conflict}
        </span>
        <span class="concept__id mono">${escapeHtml(c.id)}</span>
        <span class="concept__dots">${dots}</span>
      </button>`;
  }).join("");

  el.conceptList.querySelectorAll(".concept").forEach((btn) => {
    btn.addEventListener("click", () => selectConcept(btn.dataset.id));
  });
}

// ---- Selection ------------------------------------------------------------

async function selectConcept(id) {
  state.selectedConcept = id;
  state.selectedSource = null;
  renderConceptList();

  let resolved;
  try {
    resolved = await fetchJSON(`/api/resolve?concept=${encodeURIComponent(id)}`);
  } catch (err) {
    toast(`Couldn't resolve ${id}: ${err.message}`);
    return;
  }
  paintResolvedNode(resolved);
  markContributors(resolved.contributors.map((c) => c.layer));
  renderEdges();
  renderInspectorConcept(resolved);
}

function selectSource(name) {
  state.selectedSource = name;
  document.querySelectorAll(".node--source").forEach((n) =>
    n.classList.toggle("is-selected", n.dataset.source === name));
  renderInspectorSource(state.graph.sources.find((s) => s.name === name));
}

function markContributors(names) {
  const set = new Set(names);
  document.querySelectorAll(".node--source").forEach((n) => {
    n.classList.remove("is-selected");
    n.classList.toggle("is-contributor", set.has(n.dataset.source));
    n.classList.toggle("is-dim", !set.has(n.dataset.source));
  });
}

function paintResolvedNode(resolved) {
  const node = document.getElementById("__resolved");
  const shown = resolved.sections.filter((s) => s.content || s.suppressed);
  const conflicts = resolved.sections.reduce((n, s) => n + (s.conflicts?.length ? 1 : 0), 0);
  node.classList.remove("is-empty");
  node.querySelector(".resolved__body").innerHTML = `
    <p class="resolved__concept">${escapeHtml(resolved.id)}</p>
    <div class="resolved__meters">
      <span class="resolved__meter"><span>sections</span><b>${shown.length}</b></span>
      <span class="resolved__meter"><span>layers merged</span><b>${resolved.contributors.length}</b></span>
      <span class="resolved__meter ${conflicts ? "is-warn" : ""}"><span>conflicts</span><b>${conflicts}</b></span>
    </div>`;
  renderEdges();
}

// ---- Inspector: concept ---------------------------------------------------

function renderInspectorConcept(r) {
  state.resolvedCurrent = r; // the merge resolver reads competing versions from here
  openInspector();
  const chain = [...r.contributors]
    .map((c) => `<span class="chain__node" style="--layer-color:${state.colors[c.layer]}"><i></i>${escapeHtml(c.layer)}<span class="lvl">L${c.level}</span></span>`)
    .join(`<span class="chain__arrow">›</span>`);

  const fmRows = Object.entries(r.frontmatter)
    .filter(([k]) => k !== "title")
    .map(([k, v]) => {
      const prov = r.frontmatterProvenance[k];
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      return `<div class="fm-row"><span class="fm-key">${escapeHtml(k)}</span><span class="fm-val">${escapeHtml(val)}</span><span class="fm-prov" style="--layer-color:${state.colors[prov] ?? "#888"}">${escapeHtml(prov ?? "?")}</span></div>`;
    }).join("");

  const sections = r.sections.filter((s) => s.content || s.suppressed).map((s) => sectionCard(s)).join("");

  el.inspectorBody.innerHTML = `
    <div class="insp-head">
      <div class="insp-kicker"><span class="tag">${escapeHtml(r.frontmatter.type ?? "concept")}</span></div>
      <h2 class="insp-title">${escapeHtml(r.frontmatter.title ?? r.id)}</h2>
      <p class="insp-id mono">${escapeHtml(r.id)}</p>
      <div class="chain" title="Precedence order (highest first)">${chain}</div>
    </div>
    ${fmRows ? `<p class="eyebrow insp-section-title">Frontmatter · provenance</p><div class="fm-table">${fmRows}</div>` : ""}
    <p class="eyebrow insp-section-title">Merged sections</p>
    <div class="sections">${sections}</div>
    <div class="insp-actions">
      <button class="action action--primary" data-act="copy">Copy merged</button>
      <a class="action" href="/api/resolve?concept=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Raw JSON ↗</a>
    </div>`;

  el.inspectorBody.querySelector('[data-act="copy"]').addEventListener("click", () => copyMerged(r));
  el.inspectorBody.querySelectorAll(".wikilink").forEach((a) =>
    a.addEventListener("click", () => { const t = a.dataset.target; if (t) selectConcept(t); }));
  el.inspectorBody.querySelectorAll(".resolve-btn").forEach((b) =>
    b.addEventListener("click", () => openMergeModal(b.dataset.resolve)));
}

function sectionCard(s) {
  const color = state.colors[s.sourceLayer] ?? "#888";
  const name = s.heading ? s.heading.replace(/^#+\s*/, "").replace(/\s*\{[^}]*\}\s*$/, "") : s.key;
  const body = s.suppressed
    ? `<p class="section__suppressed">Suppressed by ${escapeHtml(s.sourceLayer)} — this section is intentionally hidden.</p>`
    : mdToHtml(s.content);

  let conflicts = "";
  if (s.conflicts?.length) {
    const rows = s.conflicts.map((d) => `
      <div class="dissent__row" style="--layer-color:${state.colors[d.layer] ?? "#888"}">
        <div class="dissent__meta"><i></i><span class="dissent__layer">${escapeHtml(d.layer)}</span><span class="dissent__date mono">${escapeHtml(d.updated ?? "no date")}</span></div>
        <div class="dissent__text">${d.content ? mdToHtml(d.content) : "<em>section suppressed here</em>"}</div>
      </div>`).join("");
    conflicts = `
      <div class="conflicts">
        <div class="conflicts__head">
          <span>${ICON.warn} ${s.conflicts.length} layer${s.conflicts.length > 1 ? "s" : ""} disagree — surfaced, not dropped</span>
          <button class="resolve-btn" data-resolve="${escapeAttr(s.key)}" type="button">Resolve…</button>
        </div>
        <div class="dissent">${rows}</div>
      </div>`;
  }

  return `
    <div class="section ${s.conflicts?.length ? "has-conflict" : ""}" style="--layer-color:${color}">
      <div class="section__bar"></div>
      <div class="section__head">
        <span class="section__name">${escapeHtml(name)}</span>
        <span class="won-by"><i></i>${escapeHtml(s.sourceLayer)}${s.sourceUpdated ? ` · ${escapeHtml(s.sourceUpdated)}` : ""}</span>
      </div>
      <div class="section__body">${body}</div>
      ${conflicts}
    </div>`;
}

// ---- Inspector: source ----------------------------------------------------

function renderInspectorSource(s) {
  if (!s) return;
  openInspector();
  const color = state.colors[s.name];
  const concepts = state.graph.concepts.filter((c) => c.contributors.includes(s.name));
  el.inspectorBody.innerHTML = `
    <div class="insp-head">
      <div class="insp-kicker"><span class="tag">source</span></div>
      <h2 class="insp-title" style="display:flex;align-items:center;gap:9px"><i style="width:11px;height:11px;border-radius:3px;background:${color};display:inline-block"></i>${escapeHtml(s.name)}</h2>
      <p class="insp-id mono">${escapeHtml(s.kind)} · precedence level ${s.level}</p>
    </div>
    <div class="src-meta">
      <div class="node__loc" title="${escapeHtml(s.location ?? "")}">${escapeHtml(s.location ?? "—")}</div>
      <div class="src-grid">
        <div class="src-cell"><span>Level</span><b>${s.level}</b></div>
        <div class="src-cell"><span>Concepts</span><b>${s.conceptCount}</b></div>
        <div class="src-cell"><span>Kind</span><b style="font-size:13px">${escapeHtml(s.kind)}</b></div>
        <div class="src-cell"><span>Latest</span><b style="font-size:13px">${escapeHtml(s.latestUpdated ?? "—")}</b></div>
      </div>
      <p class="eyebrow">Contributes to</p>
      <div class="src-concepts">
        ${concepts.map((c) => `<button data-id="${escapeAttr(c.id)}">${escapeHtml(c.id)}${c.conflictCount ? "  ⚠" : ""}</button>`).join("") || '<span class="rail__empty">No shared concepts</span>'}
      </div>
    </div>`;
  el.inspectorBody.querySelectorAll(".src-concepts button").forEach((b) =>
    b.addEventListener("click", () => selectConcept(b.dataset.id)));
}

function openInspector() {
  el.inspector.dataset.open = "true";
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

// ---- Merge conflict resolver ----------------------------------------------

let mergeCtx = null;

function openMergeModal(sectionKey) {
  const r = state.resolvedCurrent;
  const s = r?.sections.find((x) => x.key === sectionKey);
  if (!s || !s.conflicts?.length) return;

  const sectionName = s.heading ? s.heading.replace(/^#+\s*/, "").replace(/\s*\{[^}]*\}\s*$/, "") : s.key;
  // Winner first, then dissenters — these are the layers that define this section.
  const versions = [
    { layer: s.sourceLayer, updated: s.sourceUpdated, content: s.content, winner: true },
    ...s.conflicts.map((c) => ({ layer: c.layer, updated: c.updated, content: c.content, winner: false })),
  ];
  const layers = [...new Set(versions.map((v) => v.layer))];
  mergeCtx = { conceptId: r.id, sectionKey, sectionName, layers };

  document.getElementById("mergeTitle").textContent = sectionName;
  document.getElementById("mergeSub").textContent = `${r.id} · {#${sectionKey}}`;
  document.getElementById("mergeText").value = versions[0].content;
  document.getElementById("mergeTarget").innerHTML =
    `Writes to ${layers.length} layer${layers.length > 1 ? "s" : ""}: ` +
    layers.map((l) => `<span class="mchip" style="--layer-color:${state.colors[l] ?? "#888"}">${escapeHtml(l)}</span>`).join("");

  const wrap = document.getElementById("mergeVersions");
  wrap.innerHTML = versions.map((v, i) => `
    <div class="mver ${v.winner ? "is-winner" : ""}" style="--layer-color:${state.colors[v.layer] ?? "#888"}">
      <div class="mver__head">
        <i></i><b>${escapeHtml(v.layer)}</b>
        <span class="mver__date mono">${escapeHtml(v.updated ?? "no date")}</span>
        ${v.winner ? `<span class="mver__tag">current winner</span>` : ""}
      </div>
      <pre class="mver__content">${escapeHtml(v.content) || "<em>(empty)</em>"}</pre>
      <button class="mver__use" data-i="${i}" type="button">Use this value</button>
    </div>`).join("");
  wrap.querySelectorAll(".mver__use").forEach((b) => b.addEventListener("click", () => {
    const text = document.getElementById("mergeText");
    text.value = versions[Number(b.dataset.i)].content;
    text.focus();
  }));

  document.getElementById("mergeApply").disabled = false;
  const modal = document.getElementById("merge");
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
  document.getElementById("mergeText").focus();
}

function closeMergeModal() {
  const modal = document.getElementById("merge");
  modal.classList.remove("is-open");
  setTimeout(() => { modal.hidden = true; }, 160);
  mergeCtx = null;
}

async function applyMerge() {
  if (!mergeCtx) return;
  const { conceptId, sectionKey, sectionName, layers } = mergeCtx;
  const content = document.getElementById("mergeText").value;
  const btn = document.getElementById("mergeApply");
  btn.disabled = true;

  let res;
  try {
    res = await fetchJSON("/api/section", {
      method: "PUT",
      body: JSON.stringify({ conceptId, sectionKey, layers, content }),
    });
  } catch (err) {
    toast(`Resolve failed: ${err.message}`);
    btn.disabled = false;
    return;
  }

  closeMergeModal();
  try { await refreshGraphData(); } catch { /* index refresh is best-effort */ }
  if (state.selectedConcept === conceptId) await selectConcept(conceptId);
  const skipped = res.skipped?.length ? ` (${res.skipped.length} skipped)` : "";
  toast(`Resolved “${sectionName}” — ${res.written.length} layer${res.written.length === 1 ? "" : "s"} now agree${skipped}`);
}

// ---- Chrome wiring --------------------------------------------------------

function wireChrome() {
  el.omni.addEventListener("input", (e) => { state.filter = e.target.value; renderConceptList(); });
  document.getElementById("syncBtn").addEventListener("click", sync);
  document.getElementById("fitBtn").addEventListener("click", fitView);
  document.getElementById("zoomIn").addEventListener("click", () => zoomBy(1.15));
  document.getElementById("zoomOut").addEventListener("click", () => zoomBy(1 / 1.15));
  document.getElementById("stageRetry").addEventListener("click", boot);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("merge").hidden) { closeMergeModal(); return; }
    if (document.activeElement === el.omni && el.omni.value) {
      el.omni.value = ""; state.filter = ""; renderConceptList();
    } else if (state.selectedConcept || state.selectedSource) {
      clearSelection();
    }
  });

  // Merge conflict resolver
  document.getElementById("mergeClose").addEventListener("click", closeMergeModal);
  document.getElementById("mergeCancel").addEventListener("click", closeMergeModal);
  document.getElementById("mergeScrim").addEventListener("click", closeMergeModal);
  document.getElementById("mergeApply").addEventListener("click", applyMerge);
}

// Return to the neutral, nothing-selected state.
function clearSelection() {
  state.selectedConcept = null;
  state.selectedSource = null;
  renderConceptList();
  document.querySelectorAll(".node--source").forEach((n) => n.classList.remove("is-contributor", "is-dim", "is-selected"));
  const res = document.getElementById("__resolved");
  if (res) {
    res.classList.add("is-empty");
    res.querySelector(".resolved__body").innerHTML = `<p class="resolved__concept">pick a concept →</p>`;
  }
  renderEdges();
  el.inspector.dataset.open = "false";
  el.inspectorEmpty.hidden = false;
  el.inspectorBody.hidden = true;
}

async function sync() {
  const btn = document.getElementById("syncBtn");
  btn.classList.add("is-spinning");
  const keep = state.selectedConcept;
  try {
    await loadGraph();
    if (keep && conceptById(keep)) await selectConcept(keep);
    toast("Sources re-read from disk");
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  } finally {
    setTimeout(() => btn.classList.remove("is-spinning"), 400);
  }
}

// ---- Canvas pan / zoom ----------------------------------------------------

function wireCanvas() {
  let panning = false;
  let moved = false;
  let start = null;

  el.viewport.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".node")) return; // node drag handles itself
    panning = true;
    moved = false;
    el.viewport.classList.add("is-panning");
    start = { px: e.clientX, py: e.clientY, x: state.view.x, y: state.view.y };
    el.viewport.setPointerCapture(e.pointerId);
  });
  el.viewport.addEventListener("pointermove", (e) => {
    if (!panning) return;
    if (Math.abs(e.clientX - start.px) > 3 || Math.abs(e.clientY - start.py) > 3) moved = true;
    state.view.x = start.x + (e.clientX - start.px);
    state.view.y = start.y + (e.clientY - start.py);
    applyView();
  });
  const endPan = () => {
    if (panning && !moved) clearSelection(); // click on empty canvas = deselect
    panning = false;
    el.viewport.classList.remove("is-panning");
  };
  el.viewport.addEventListener("pointerup", endPan);
  el.viewport.addEventListener("pointercancel", endPan);

  el.viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = el.viewport.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    zoomAround(e.clientX - rect.left, e.clientY - rect.top, factor);
  }, { passive: false });

  window.addEventListener("resize", () => applyView());
}

function zoomBy(factor) {
  zoomAround(el.viewport.clientWidth / 2, el.viewport.clientHeight / 2, factor);
}

function zoomAround(cx, cy, factor) {
  const prev = state.view.scale;
  const next = clamp(prev * factor, 0.4, 2);
  const k = next / prev;
  state.view.x = cx - (cx - state.view.x) * k;
  state.view.y = cy - (cy - state.view.y) * k;
  state.view.scale = next;
  applyView();
}

// ---- Node dragging --------------------------------------------------------

function makeDraggable(node, id, onClick) {
  let moved = false;
  let start = null;

  // Keyboard-operable: the canvas is no longer mouse-only.
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); }
  });

  node.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    moved = false;
    start = { px: e.clientX, py: e.clientY, x: state.pos[id].x, y: state.pos[id].y };
    node.classList.add("is-dragging");
    node.setPointerCapture(e.pointerId);
  });
  node.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dx = (e.clientX - start.px) / state.view.scale;
    const dy = (e.clientY - start.py) / state.view.scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    state.pos[id] = { x: start.x + dx, y: start.y + dy };
    positionNode(id);
    scheduleEdges();
  });
  const end = (e) => {
    if (!start) return;
    start = null;
    node.classList.remove("is-dragging");
    if (!moved && onClick) onClick();
    if (e) e.stopPropagation();
  };
  node.addEventListener("pointerup", end);
  node.addEventListener("pointercancel", () => { start = null; node.classList.remove("is-dragging"); });
}

// ---- Minimal markdown (no deps) -------------------------------------------

function mdToHtml(text) {
  const paras = String(text).trim().split(/\n{2,}/);
  return paras.map((p) => `<p>${mdInline(p.replace(/\n/g, " "))}</p>`).join("");
}

function mdInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`);
  // [[wikilink]] -> clickable if it resolves to a known concept id (by suffix match)
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_, slug) => {
    const target = resolveWikilink(slug.trim());
    return target
      ? `<span class="wikilink" data-target="${escapeAttr(target)}">${escapeHtml(slug.trim())}</span>`
      : `<span class="wikilink">${escapeHtml(slug.trim())}</span>`;
  });
  // [text](url)
  out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `<a href="${escapeAttr(u)}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`);
  return out;
}

function resolveWikilink(slug) {
  if (!state.graph) return null;
  const exact = state.graph.concepts.find((c) => c.id === slug);
  if (exact) return exact.id;
  const bySuffix = state.graph.concepts.find((c) => c.id.split("/").pop() === slug);
  return bySuffix ? bySuffix.id : null;
}

// ---- Utilities ------------------------------------------------------------

async function copyMerged(r) {
  const lines = [`# ${r.frontmatter.title ?? r.id}`, ""];
  for (const s of r.sections.filter((x) => x.content || x.suppressed)) {
    lines.push(s.heading ?? `## ${s.key}`);
    lines.push("");
    if (s.suppressed) lines.push(`_(suppressed by ${s.sourceLayer})_`);
    else lines.push(s.content);
    if (s.conflicts?.length) {
      for (const d of s.conflicts) lines.push(`\n> conflict · ${d.layer} (${d.updated ?? "no date"}): ${d.content}`);
    }
    lines.push("");
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast("Merged concept copied to clipboard");
  } catch {
    toast("Clipboard blocked by the browser");
  }
}

let toastTimer = null;
function toast(msg) {
  let node = document.querySelector(".toast");
  if (!node) { node = document.createElement("div"); node.className = "toast"; document.body.appendChild(node); }
  node.textContent = msg;
  requestAnimationFrame(() => node.classList.add("is-shown"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-shown"), 2400);
}

function conceptById(id) { return state.graph?.concepts.find((c) => c.id === id) ?? null; }
function srcId(name) { return `src:${name}`; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function escapeAttr(v) { return escapeHtml(v); }

// ===========================================================================
// Files mode — explorer + editor (CodeMirror) + rich preview (md / svg / image / pdf)
// ===========================================================================

const fx = {
  tree: document.getElementById("ftree"),
  head: document.getElementById("fmainHead"),
  empty: document.getElementById("fmainEmpty"),
  body: document.getElementById("fmainBody"),
  editorEl: document.getElementById("feditor"),
  preview: document.getElementById("fpreview"),
  kind: document.getElementById("fkind"),
  path: document.getElementById("fpath"),
  concept: document.getElementById("fconcept"),
  seg: document.getElementById("fviewSeg"),
  dirty: document.getElementById("fdirty"),
  save: document.getElementById("fsave"),
};

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";
if (window.marked?.setOptions) marked.setOptions({ gfm: true, breaks: false });

const FILE_ICON = {
  pdf: `<svg viewBox="0 0 18 18" width="15" height="15"><path d="M4 2.5h6l4 4V15a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 4 15z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 2.5V6h3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
  image: `<svg viewBox="0 0 18 18" width="15" height="15"><rect x="2.5" y="3.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6.5" cy="7.5" r="1.2" fill="currentColor"/><path d="M4 13l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  svg: `<svg viewBox="0 0 18 18" width="15" height="15"><rect x="2.5" y="3.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6.5" cy="7.5" r="1.2" fill="currentColor"/><path d="M4 13l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  text: `<svg viewBox="0 0 18 18" width="15" height="15"><path d="M4 2.5h6l4 4V15a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 4 15z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 2.5V6h3.5M6.5 9h5M6.5 11.5h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
};
function fileIcon(kind) { return FILE_ICON[kind] ?? FILE_ICON.text; }

function wireFiles() {
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  fx.save.addEventListener("click", saveFile);
  fx.seg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { setFview(b.dataset.fview); state.editor?.refresh(); }));
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector(".app").dataset.mode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", String(on));
  });
  if (mode === "files" && !state.files) loadFiles();
  if (mode === "files" && state.editor) requestAnimationFrame(() => state.editor.refresh());
  if (mode === "sources") renderSourcesView();
  if (mode === "canvas" && state.needsFit) { state.needsFit = false; requestAnimationFrame(fitView); }
}

async function loadFiles() {
  try {
    state.files = await fetchJSON("/api/files");
    renderFileTree();
  } catch (err) {
    fx.tree.innerHTML = `<div class="rail__empty">Couldn't list files: ${escapeHtml(err.message)}</div>`;
  }
}

function renderFileTree() {
  if (!state.files) return;
  fx.tree.innerHTML = state.files.layers.map((group) => {
    const src = state.graph?.sources.find((s) => s.name === group.layer);
    const color = state.colors[group.layer] ?? "#888";
    const files = group.files.map((f) => `
      <button class="ftree__file ${f.path === state.openFilePath ? "is-active" : ""}" data-path="${escapeAttr(f.path)}">
        <span class="ficon">${fileIcon(f.kind)}</span>
        <span class="fname">${escapeHtml(f.rel)}</span>
      </button>`).join("");
    return `
      <div class="ftree__group">
        <div class="ftree__layer"><i style="background:${color}"></i>${escapeHtml(group.layer)}<span class="lvl">${src ? "L" + src.level : ""}</span></div>
        ${files}
      </div>`;
  }).join("");
  fx.tree.querySelectorAll(".ftree__file").forEach((btn) =>
    btn.addEventListener("click", () => openFile(btn.dataset.path)));
}

async function openFile(apiPath) {
  if (state.dirty && !window.confirm(`Discard unsaved changes to ${state.openFilePath}?`)) return;

  let data;
  try {
    data = await fetchJSON(`/api/file?path=${encodeURIComponent(apiPath)}`);
  } catch (err) {
    toast(`Couldn't open ${apiPath}: ${err.message}`);
    return;
  }

  state.openFilePath = apiPath;
  renderFileTree();
  fx.empty.hidden = true;
  fx.head.hidden = false;
  fx.editorEl.removeAttribute("hidden");
  fx.preview.removeAttribute("hidden");
  fx.kind.textContent = data.kind;
  fx.path.textContent = apiPath;
  setDirty(false);
  renderConceptStrip(data.ext, data.rel);

  if (data.kind === "pdf" || data.kind === "image") {
    state.editor = null;
    fx.editorEl.innerHTML = "";
    fx.seg.hidden = true;
    fx.save.hidden = true;
    setFview("preview");
    if (data.kind === "pdf") renderPdf(apiPath); else renderImage(apiPath);
    return;
  }

  // editable text (markdown, code, svg, …)
  mountEditor(data);
  fx.save.hidden = false;
  const rich = data.ext === ".md" || data.ext === ".markdown" || data.ext === ".svg";
  fx.seg.hidden = !rich;
  if (rich) { setFview("split"); renderTextPreview(data.ext, data.text ?? ""); }
  else { setFview("editor"); }
}

// Link an OKF markdown file to its concept in the cascade (id = path minus layer & .md).
function renderConceptStrip(ext, rel) {
  const conceptId = /\.markdown?$|\.md$/i.test(ext) ? rel.replace(/\.md$/i, "") : null;
  const entry = conceptId ? conceptById(conceptId) : null;
  if (!entry) { fx.concept.hidden = true; return; }
  fx.concept.hidden = false;
  const c = entry.conflictCount;
  fx.concept.textContent = `↳ ${conceptId}${c ? `  ·  ${c} conflict${c > 1 ? "s" : ""}` : ""}  ·  open in canvas`;
  fx.concept.onclick = () => { setMode("canvas"); selectConcept(conceptId); };
}

function mountEditor(data) {
  fx.editorEl.innerHTML = "";
  state.editor = window.CodeMirror(fx.editorEl, {
    value: data.text ?? "",
    mode: extToMode(data.ext),
    lineNumbers: true,
    lineWrapping: true,
  });
  state.editor.on("change", () => {
    setDirty(true);
    if (data.ext === ".md" || data.ext === ".markdown" || data.ext === ".svg") schedulePreview(data.ext);
  });
  requestAnimationFrame(() => state.editor.refresh());
}

let previewTimer = 0;
function schedulePreview(ext) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderTextPreview(ext, state.editor.getValue()), 180);
}

function renderTextPreview(ext, value) {
  if (ext === ".svg") {
    // Render via a data: URI in an <img>, NOT innerHTML — a source file can be
    // arbitrary (e.g. a cloned repo), and SVG inlined into the DOM executes its
    // scripts/handlers. In an <img> the SVG is inert (image context).
    fx.preview.classList.add("is-media");
    fx.preview.innerHTML =
      `<img class="preview-img" alt="SVG preview" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}">`;
    return;
  }
  fx.preview.classList.remove("is-media");
  // Read it as prose: drop the YAML frontmatter block and the OKF {#anchor}
  // heading suffixes. The editor still shows the raw source verbatim.
  const md = value
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^(#{1,6}[^\n]*?)\s*\{#[^}]*\}\s*$/gm, "$1");
  const raw = window.marked ? marked.parse(md) : `<pre>${escapeHtml(md)}</pre>`;
  // Sanitize: source content is untrusted (a GitHub source is any repo), and
  // this HTML is same-origin — an unsanitized <script>/onerror could drive the
  // mutating APIs. DOMPurify strips scripts, event handlers, and js: URLs.
  const html = window.DOMPurify ? DOMPurify.sanitize(raw) : escapeHtml(md);
  fx.preview.innerHTML = `<div class="md-body">${html}</div>`;
}

function renderImage(apiPath) {
  fx.preview.classList.add("is-media");
  fx.preview.innerHTML = `<img class="preview-img" alt="${escapeAttr(apiPath)}" src="/api/file/raw?path=${encodeURIComponent(apiPath)}">`;
}

async function renderPdf(apiPath) {
  fx.preview.classList.remove("is-media");
  fx.preview.innerHTML = `<div class="preview-note">Rendering PDF…</div>`;
  if (!window.pdfjsLib) { fx.preview.innerHTML = `<div class="preview-note">pdf.js not loaded.</div>`; return; }
  try {
    const pdf = await pdfjsLib.getDocument(`/api/file/raw?path=${encodeURIComponent(apiPath)}`).promise;
    fx.preview.innerHTML = "";
    const ratio = window.devicePixelRatio || 1;
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = vp.width * ratio;
      canvas.height = vp.height * ratio;
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      const ctx = canvas.getContext("2d");
      ctx.scale(ratio, ratio);
      fx.preview.appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }
  } catch (err) {
    fx.preview.innerHTML = `<div class="preview-note">Couldn't render PDF: ${escapeHtml(err.message)}</div>`;
  }
}

async function saveFile() {
  if (!state.openFilePath || !state.editor) return;
  const text = state.editor.getValue();
  fx.save.disabled = true;
  try {
    await fetchJSON("/api/file", { method: "PUT", body: JSON.stringify({ path: state.openFilePath, text }) });
  } catch (err) {
    toast(`Save failed: ${err.message}`);
    fx.save.disabled = false;
    return;
  }
  setDirty(false);

  // Live re-resolve: refresh the concept index (no canvas relayout) so the
  // cascade reflects the edit, then update the concept strip + canvas selection.
  const conceptId = /\.md$/i.test(state.openFilePath)
    ? state.openFilePath.split("/").slice(1).join("/").replace(/\.md$/i, "")
    : null;
  try { await refreshGraphData(); } catch { /* keep the save; index refresh is best-effort */ }

  const entry = conceptId ? conceptById(conceptId) : null;
  if (entry) renderConceptStrip(".md", state.openFilePath.split("/").slice(1).join("/"));
  if (state.selectedConcept && state.selectedConcept === conceptId) selectConcept(conceptId);

  toast(entry
    ? `Saved · re-resolved (${entry.conflictCount} conflict${entry.conflictCount === 1 ? "" : "s"})`
    : "Saved");
}

function setFview(v) {
  state.fview = v;
  fx.body.dataset.fview = v;
  fx.seg.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.fview === v));
}

function setDirty(b) {
  state.dirty = b;
  fx.dirty.hidden = !b;
  fx.save.disabled = !b;
}

function extToMode(ext) {
  switch (ext) {
    case ".md": case ".markdown": return "markdown";
    case ".js": case ".mjs": case ".jsx": case ".ts": case ".tsx": return "javascript";
    case ".json": return { name: "javascript", json: true };
    case ".css": return "css";
    case ".html": case ".htm": return "htmlmixed";
    case ".yml": case ".yaml": return "yaml";
    case ".svg": case ".xml": return "xml";
    default: return null;
  }
}

// ===========================================================================
// Sources console — configure sources (local / GitHub / MCP) + token budget
// ===========================================================================

const ICON_SYNC = `<svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true"><path d="M14 7A5.5 5.5 0 1 0 14.5 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M14.2 3.8V7H11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true"><path d="M4 5h10M7.5 5V3.6h3V5M6 5l.6 9h4.8L12 5M8 7.5v4M10 7.5v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let addKind = "local";

function wireSources() {
  document.getElementById("addSourceBtn").addEventListener("click", () =>
    setAddFormOpen(document.getElementById("addForm").hidden));
  document.getElementById("addCancel").addEventListener("click", () => setAddFormOpen(false));
  document.getElementById("addForm").addEventListener("submit", submitAddSource);
  document.getElementById("addKind").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => setAddKind(b.dataset.kind)));
}

function renderSourcesView() {
  if (!state.graph) return;
  renderBudget();
  renderSourcesTable();
}

function renderBudget() {
  const g = state.graph;
  const total = g.totals.sourceTokens || 1;
  const ordered = [...g.sources].sort((a, b) => b.tokens - a.tokens);
  const bar = ordered.map((s) =>
    `<div class="budget__seg" style="width:${(s.tokens / total * 100).toFixed(2)}%;background:${state.colors[s.name] ?? "#3a4658"}" title="${escapeAttr(s.name)}"></div>`).join("");
  const legend = ordered.map((s) =>
    `<span class="budget__key"><i style="background:${state.colors[s.name] ?? "#3a4658"}"></i><b>${escapeHtml(s.name)}</b> <span>${fmtNum(s.tokens)} · ${(s.tokens / total * 100).toFixed(0)}%</span></span>`).join("");
  document.getElementById("budget").innerHTML = `
    <div class="budget__top">
      <div class="budget__figure"><span class="budget__num">${fmtNum(g.totals.sourceTokens)}</span><span class="budget__unit">context tokens across ${g.totals.sources} source${g.totals.sources === 1 ? "" : "s"}</span></div>
      <div class="budget__meta"><b>${fmtNum(g.totals.resolvedTokens)}</b> effective after cascade · <b>${g.totals.concepts}</b> concepts · <span title="o200k is GPT-4o's tokenizer; Anthropic doesn't publish Claude's, so this is a close proxy">${escapeHtml(g.tokenizer)} proxy</span></div>
    </div>
    <div class="budget__bar">${bar}</div>
    <div class="budget__legend">${legend}</div>`;
}

function renderSourcesTable() {
  const g = state.graph;
  const total = g.totals.sourceTokens || 1;
  const rows = [...g.sources].sort((a, b) => b.level - a.level).map((s) => sourceRow(s, total)).join("");
  document.getElementById("stableBody").innerHTML = rows ||
    `<tr><td colspan="7" class="stable__empty">No sources configured. Add one above.</td></tr>`;
  document.querySelectorAll("[data-sync]").forEach((b) =>
    b.addEventListener("click", () => syncSource(b.dataset.sync, b)));
  document.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => removeSource(b.dataset.remove)));
}

function sourceRow(s, total) {
  const color = state.colors[s.name] ?? "#3a4658";
  const pct = total ? (s.tokens / total) * 100 : 0;
  const loc = s.kind === "github" && s.origin
    ? `<a href="${escapeAttr(s.origin.replace(/\.git$/, ""))}" target="_blank" rel="noopener">${escapeHtml(s.origin.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""))}</a>`
    : escapeHtml(s.location ?? "—");
  const status = s.status === "ok"
    ? `<span class="status status--ok"><i></i>ok</span>`
    : `<span class="status status--error"><i></i><span class="status__err" title="${escapeAttr(s.error ?? "")}">error</span></span>`;
  const syncBtn = s.kind === "github"
    ? `<button class="iconbtn" data-sync="${escapeAttr(s.name)}" title="Sync (git pull)" type="button">${ICON_SYNC}</button>` : "";
  return `<tr>
    <td><span class="src-name"><i style="background:${color}"></i><b>${escapeHtml(s.name)}</b> <span class="kindtag">${escapeHtml(s.kind)}</span></span></td>
    <td><div class="src-loc" title="${escapeAttr(s.location ?? s.origin ?? "")}">${loc}</div></td>
    <td class="num"><span class="src-level">L${s.level}</span></td>
    <td class="num">${s.conceptCount}</td>
    <td class="num tokcell"><span class="tokcell__n">${fmtNum(s.tokens)}</span><span class="tokcell__pct">${pct.toFixed(0)}%</span><div class="tokcell__bar"><div class="tokcell__fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div></td>
    <td>${status}</td>
    <td class="actcol"><div class="rowacts">${syncBtn}<button class="iconbtn iconbtn--danger" data-remove="${escapeAttr(s.name)}" title="Remove source" type="button">${ICON_TRASH}</button></div></td>
  </tr>`;
}

async function syncSource(name, btn) {
  btn.classList.add("is-spinning");
  try {
    await fetchJSON(`/api/sources/sync?name=${encodeURIComponent(name)}`, { method: "POST" });
    await reloadAllSurfaces();
    toast(`Synced ${name}`);
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  } finally {
    btn.classList.remove("is-spinning");
  }
}

async function removeSource(name) {
  if (!window.confirm(`Remove source "${name}"? Its files aren't deleted.`)) return;
  try {
    await fetchJSON(`/api/sources?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    await reloadAllSurfaces();
    toast(`Removed ${name}`);
  } catch (err) {
    toast(`Remove failed: ${err.message}`);
  }
}

function setAddFormOpen(open) {
  document.getElementById("addForm").hidden = !open;
  if (open) {
    setAddKind(addKind);
    setAddHint("");
    requestAnimationFrame(() => document.getElementById("af-name")?.focus());
  }
}

function setAddKind(kind) {
  addKind = kind;
  document.getElementById("addKind").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.kind === kind));
  document.getElementById("addFields").innerHTML = addFieldsHtml(kind);
}

function addFieldsHtml(kind) {
  const common = `
    <div class="field"><label for="af-name">Name <span class="req">· required</span></label><input id="af-name" placeholder="e.g. design-docs" autocomplete="off"></div>
    <div class="field"><label for="af-level">Precedence level</label><input id="af-level" type="number" value="1" inputmode="numeric"><span class="field__hint">Higher wins per section. Personal 3 · team 2 · company 0.</span></div>`;
  if (kind === "local") {
    return `${common}
      <div class="field field--wide"><label for="af-path">Path <span class="req">· required</span></label><input id="af-path" class="mono" placeholder="/abs/path  or  demo-layers/mybundle"><span class="field__hint">A directory of OKF markdown. Relative paths resolve against the manifest.</span></div>`;
  }
  if (kind === "github") {
    return `${common}
      <div class="field field--wide"><label for="af-repo">Repository <span class="req">· required</span></label><input id="af-repo" class="mono" placeholder="owner/name   ·   https://github.com/owner/name   ·   or an SSH URL"><span class="field__hint">Cloned with git (your credentials, so private repos work). May or may not contain OKF — non-OKF markdown just yields fewer concepts.</span></div>
      <div class="field"><label for="af-ref">Branch / ref</label><input id="af-ref" class="mono" placeholder="main (optional)"></div>
      <div class="field"><label for="af-subdir">Sub-directory</label><input id="af-subdir" class="mono" placeholder="docs/ (optional)"></div>`;
  }
  return `${common}
    <div class="field field--wide"><label for="af-command">Command <span class="req">· required</span></label><input id="af-command" class="mono" placeholder="node"></div>
    <div class="field field--wide"><label for="af-args">Arguments</label><input id="af-args" class="mono" placeholder="examples/mock-context-source.mjs"><span class="field__hint">This source spawns the command and translates its graph to OKF. Only add servers you trust.</span></div>`;
}

async function submitAddSource(e) {
  e.preventDefault();
  const body = { kind: addKind, name: fval("af-name"), level: Number(fval("af-level")) || 1 };
  if (addKind === "local") body.path = fval("af-path");
  if (addKind === "github") { body.repo = fval("af-repo"); body.ref = fval("af-ref"); body.subdir = fval("af-subdir"); }
  if (addKind === "mcp") { body.command = fval("af-command"); body.args = fval("af-args"); }

  const submit = document.getElementById("addSubmit");
  submit.classList.add("is-busy");
  submit.textContent = addKind === "github" ? "Cloning…" : "Adding…";
  setAddHint("");
  try {
    await fetchJSON("/api/sources", { method: "POST", body: JSON.stringify(body) });
    setAddFormOpen(false);
    await reloadAllSurfaces();
    toast(`Added source “${body.name}”`);
  } catch (err) {
    setAddHint(err.message, true);
  } finally {
    submit.classList.remove("is-busy");
    submit.textContent = "Add source";
  }
}

// After a source change: refresh the graph (canvas relayout deferred if hidden),
// the file tree, and the sources console.
async function reloadAllSurfaces() {
  await loadGraph();
  if (state.files) { try { state.files = await fetchJSON("/api/files"); renderFileTree(); } catch { /* keep old tree */ } }
  renderSourcesView();
}

function setAddHint(text, isError = false) {
  const h = document.getElementById("addHint");
  h.textContent = text;
  h.classList.toggle("is-error", isError);
}

function fval(id) { return document.getElementById(id)?.value.trim() ?? ""; }
function fmtNum(n) { return Number(n || 0).toLocaleString("en-US"); }

// All top-level declarations (including `fx`) are now initialized.
init();
