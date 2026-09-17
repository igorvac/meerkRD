import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  profiles: [],
  presets: [],
  job: null,
  jobs: [],
  step: 1,
  expanded: new Set(),
  selected: new Set(),
  showPath: false,
  showTravel: true,
  showGrid: true,
  confirmCritical: false,
  saveTimer: null,
  pollTimer: null,
  view: { base: null, zoom: 1, x: 0, y: 0 }, // canvas zoom/pan; base = bed fitted to the viewport
  viewJobId: null, // job the current view was fitted for
  pan: null,
  suppressClick: false,
  colorMemory: {}, // settings of operations that were emptied out, keyed by color
  historyOpen: null, // null = automatic (open without a job), true/false = user's choice
  lastRenderedStep: null,
  panelFolded: false, // the current step's panel was folded by hand
  canvasMode: "select", // "select": shapes -> operations; "move": drag copies around the bed
  pieces: new Set(), // selected copies ("<part>#<copy>") in move mode
  drag: null, // active move/rotate/scale/marquee gesture
  layoutTimer: null,
  layoutDirty: false, // placements edited locally and not yet stored
};

// Palette shown in the color bar under the canvas, LightBurn/RDWorks style:
// a color is an operation. Picked to stay legible on the white bed.
const PALETTE = [
  ["#000000", "Preto"], ["#ff0000", "Vermelho"], ["#0000ff", "Azul"], ["#00a000", "Verde"],
  ["#ff8000", "Laranja"], ["#a000ff", "Roxo"], ["#00b0b0", "Ciano"], ["#e000a0", "Magenta"],
  ["#c0a000", "Amarelo"], ["#8b4513", "Marrom"], ["#ff69b4", "Rosa"], ["#008080", "Turquesa"],
  ["#80c000", "Lima"], ["#000080", "Marinho"], ["#808000", "Oliva"], ["#808080", "Cinza"],
];
const OP_SETTING_KEYS = ["type", "label", "speed_mm_s", "power_pct", "passes", "kerf_mm", "dpi", "direction"];
const HIT_TAGS = new Set(["path", "polyline", "polygon", "line", "rect", "circle", "ellipse"]);
const ZOOM_MIN = 0.5, ZOOM_MAX = 80;

const BUSY_STATUSES = new Set(["analyzing_parts", "nesting", "relayout", "generating"]);
const PART_STATUS_LABEL = { analyzing: "Analisando…", ready: "Pronta", failed: "Falhou" };

const $ = (id) => document.getElementById(id);
const OP_LABELS = { cut: "Corte", engrave: "Gravação vetorial", raster: "Gravação raster", image: "Imagem" };
const OP_ICONS = { cut: "cut", engrave: "engrave", raster: "raster", image: "image" };
const DIRECTIONS = {
  top_to_bottom: "De cima para baixo",
  bottom_to_top: "De baixo para cima",
  left_to_right: "Da esquerda para a direita",
  right_to_left: "Da direita para a esquerda",
  hatch: "Hachura",
  crossover: "Cruzado",
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const headers = options.headers || {};
  const key = localStorage.getItem("rd_api_key");
  if (key) headers["X-API-Key"] = key;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data);
    throw new Error(detail || `Erro ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtTime(seconds) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${r} s`;
  return `${r} s`;
}
function fmtMm(mm) {
  if (mm == null) return "—";
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(message, action) {
  const root = $("toast-root");
  root.innerHTML = `<div class="toast" role="status">${esc(message)}${action ? `<button class="btn sm" id="toast-action">${esc(action.label)}</button>` : ""}</div>`;
  if (action) $("toast-action").onclick = () => { action.fn(); root.innerHTML = ""; };
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (root.innerHTML = ""), action ? 6000 : 3500);
}
function profile() {
  // With a job open, the job's machine is the truth (the canvas, validation
  // and the .rd all use it); the selector only leads until a job exists.
  const id = state.job?.profile_id || $("profile-select").value;
  return state.profiles.find((p) => p.id === id) || state.profiles[0];
}
function setStatus(kind, text) {
  const pill = $("status-pill");
  pill.className = `status-pill ${kind}`;
  $("status-text").textContent = text;
  $("progress").className = `progress ${kind === "busy" ? "busy" : ""}`;
}

// ---------------------------------------------------------------------------
// Validation (mirrors the server rules so feedback is immediate)
// ---------------------------------------------------------------------------
function validateOp(op) {
  const errors = {};
  const p = profile();
  if (!(op.speed_mm_s > 0)) errors.speed_mm_s = "Informe uma velocidade maior que zero.";
  else if (p?.max_speed_mm_s && op.speed_mm_s > p.max_speed_mm_s) errors.speed_mm_s = `Acima do máximo do perfil (${p.max_speed_mm_s} mm/s).`;
  if (!(op.power_pct >= 0 && op.power_pct <= 100)) errors.power_pct = "Potência entre 0 e 100 %.";
  else if (op.enabled && p?.min_power_pct && op.power_pct < p.min_power_pct) errors.power_pct = `Abaixo de ${p.min_power_pct} % o tubo CO2 pode não acender.`;
  if (!(op.passes >= 1 && op.passes <= 50)) errors.passes = "Entre 1 e 50 passes.";
  if (op.kerf_mm != null && (op.kerf_mm < 0 || op.kerf_mm > 5)) errors.kerf_mm = "Kerf entre 0 e 5 mm.";
  if ((op.type === "raster" || op.type === "image") && op.dpi != null && (op.dpi < 50 || op.dpi > 1200)) errors.dpi = "DPI entre 50 e 1200.";
  return errors;
}
function paramsValid() {
  const ops = state.job?.params?.operations || [];
  return ops.length > 0 && ops.every((op) => Object.keys(validateOp(op)).length === 0);
}

// ---------------------------------------------------------------------------
// Rendering: steps, machine, file
// ---------------------------------------------------------------------------
function stepAvailable(n) {
  const job = state.job;
  return n === 1 || (n === 2 && !!job?.analysis) || (n === 3 && job?.status === "ready");
}
function stepSummary(n) {
  const job = state.job;
  const p = profile();
  if (n === 1) {
    if (!job) return p ? `${p.name} · envie o desenho` : "Escolha a máquina e envie o desenho";
    const copies = job.parts.reduce((k, part) => k + (part.enabled ? part.quantity : 0), 0);
    const parts = `${job.parts.length} peça(s), ${copies} cópia(s)`;
    return `${p?.name || ""} · ${parts} · ${job.analysis ? "nesteado" : BUSY_STATUSES.has(job.status) ? "processando…" : "falta nestear"}`;
  }
  if (n === 2) {
    if (!job?.analysis) return "Disponível depois de nestear as peças";
    const ops = job.params?.operations || [];
    const on = ops.filter((o) => o.enabled).length;
    return `${ops.length} operação(ões)${on !== ops.length ? ` (${on} ativa(s))` : ""} · ${paramsValid() ? "pronto para gerar" : "há campos inválidos"}`;
  }
  if (!job || job.status !== "ready") return "Disponível depois de gerar o arquivo";
  return `${fmtTime(job.estimate?.total_s)} · ${job.stale ? "desatualizado — gere de novo" : "arquivo pronto"}`;
}
function renderSteps() {
  const job = state.job;
  const hasAnalysis = !!job?.analysis;
  const hasResult = job?.status === "ready";
  if (!stepAvailable(state.step)) state.step = hasAnalysis ? 2 : 1;
  const stepChanged = state.step !== state.lastRenderedStep;
  if (stepChanged) state.panelFolded = false;
  for (const n of [1, 2, 3]) {
    const active = state.step === n;
    const open = active && !state.panelFolded;
    const done = (n === 1 && hasAnalysis) || (n === 2 && hasResult) || (n === 3 && hasResult && !job.stale);
    const panel = $(`panel-${n}`);
    panel.classList.toggle("open", open);
    panel.classList.toggle("done", done && !open);
    panel.classList.toggle("locked", !stepAvailable(n));
    panel.querySelector(".step-head").setAttribute("aria-expanded", String(open));
    $(`panel-${n}-summary`).textContent = stepSummary(n);
    const num = panel.querySelector(".num");
    num.innerHTML = done && !open ? icon("ok") : String(n);
  }
  if (stepChanged) {
    state.lastRenderedStep = state.step;
    $(`panel-${state.step}`).scrollIntoView({ block: "start", behavior: "smooth" });
  }
  renderHistoryPanel();
}
function renderHistoryPanel() {
  // Open by default while there is no job (that's where you pick one up);
  // folded once you're working. The user's own toggle wins afterwards.
  const open = state.historyOpen ?? !state.job;
  const panel = $("panel-history");
  panel.classList.toggle("open", open);
  panel.querySelector(".step-head").setAttribute("aria-expanded", String(open));
  $("panel-history-summary").textContent = state.jobs.length ? `${state.jobs.length} trabalho(s)` : "Nenhum trabalho ainda";
}

function renderProfiles() {
  const sel = $("profile-select");
  const current = state.job?.profile_id || sel.value || state.profiles[0]?.id;
  sel.innerHTML = state.profiles.map((p) => `<option value="${esc(p.id)}"${p.id === current ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  sel.disabled = !!state.job && BUSY_STATUSES.has(state.job.status);
  const p = profile();
  $("profile-hint").textContent = p ? `Mesa ${p.bed_mm[0]} × ${p.bed_mm[1]} mm · ${p.job_reference === "anchor" ? "âncora" : "não-âncora"}${state.job?.analysis ? " · trocar de máquina refaz o nesting" : ""}` : "";
  const presetSel = $("preset-select");
  presetSel.innerHTML = `<option value="">Aplicar preset de material…</option>` + state.presets.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
}

const REFERENCE_HINTS = {
  anchor: "Âncora (recomendado): o corte parte de onde você marcar Origem/zero de peça no console — igual ao RDWorks. Jogue até o material e aperte Origem antes de rodar.",
  absolute: "Não-âncora (absoluto): o corte é sempre posicionado a partir do zero geral da máquina, ignorando qualquer origem marcada no console. Exige que a largura/altura da mesa e o canto de origem abaixo estejam exatamente certos.",
};

function setReferenceMode(mode) {
  document.querySelectorAll("#m-reference .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.value === mode));
  $("m-reference-hint").textContent = REFERENCE_HINTS[mode] || "";
}

function loadMachineForm(p) {
  state.editingProfileId = p?.id || null;
  $("m-name").value = p?.name || "";
  $("m-bed-w").value = p?.bed_mm?.[0] ?? 900;
  $("m-bed-h").value = p?.bed_mm?.[1] ?? 600;
  $("m-home").value = p?.home_corner || "top-left";
  setReferenceMode(p?.job_reference === "anchor" ? "anchor" : "absolute");
  $("m-flip-x").checked = !!p?.flip_x;
  $("m-flip-y").checked = !!p?.flip_y;
  $("m-swap-xy").checked = !!p?.swap_xy;
  $("m-magic").value = p?.magic ?? 136;
  $("m-max-speed").value = p?.max_speed_mm_s ?? "";
  $("m-min-power").value = p?.min_power_pct ?? "";
  $("machine-save-status").textContent = "";
}

function slugify(name) {
  let base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "maquina";
  if (base.length < 2) base += "-m"; // the API requires at least 2 characters
  return base.slice(0, 30);
}
function uniqueProfileId(base) {
  const existing = new Set(state.profiles.map((p) => p.id));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function readMachineForm() {
  const active = document.querySelector("#m-reference .seg-btn.active");
  const name = $("m-name").value.trim() || "Minha máquina";
  const id = state.editingProfileId || uniqueProfileId(slugify(name));
  const num = (elId) => {
    const v = $(elId).value;
    return v === "" ? null : Number(v);
  };
  return {
    id,
    name,
    driver: "ruida-beta",
    bed_mm: [num("m-bed-w") || 900, num("m-bed-h") || 600],
    home_corner: $("m-home").value,
    job_reference: active ? active.dataset.value : "anchor",
    flip_x: $("m-flip-x").checked,
    flip_y: $("m-flip-y").checked,
    swap_xy: $("m-swap-xy").checked,
    magic: num("m-magic") ?? 136,
    max_speed_mm_s: num("m-max-speed"),
    min_power_pct: num("m-min-power"),
    notes: "",
  };
}

function renderParts() {
  const job = state.job;
  const list = $("parts-list");
  const empty = $("parts-empty");
  const addBtn = $("btn-add-part");
  const nestBox = $("nest-box");
  if (!job) {
    list.innerHTML = "";
    empty.hidden = false;
    addBtn.hidden = true;
    nestBox.hidden = true;
    return;
  }
  empty.hidden = true;
  addBtn.hidden = BUSY_STATUSES.has(job.status);
  const unplaced = new Set(job.unplaced_part_ids || []);
  list.innerHTML = job.parts
    .map((p) => {
      const chips = [];
      if (p.status === "analyzing") chips.push(`<span class="chip info">${PART_STATUS_LABEL.analyzing}</span>`);
      else if (p.status === "failed") chips.push(`<span class="chip danger">${icon("critical")} ${esc(p.error?.message || "falhou")}</span>`);
      else {
        chips.push(`<span class="chip">${Math.round(p.width_mm)} × ${Math.round(p.height_mm)} mm</span>`);
        if (p.layers?.length) chips.push(`<span class="chip">${p.layers.map(esc).join(", ")}</span>`);
        chips.push(`<span class="chip">${p.elements ?? "?"} elem.</span>`);
      }
      if (unplaced.has(p.id)) chips.push(`<span class="chip danger">${icon("critical")} não coube na mesa</span>`);
      return `<div class="part-card${p.enabled ? "" : " disabled"}${unplaced.has(p.id) ? " unplaced" : ""}" data-part="${p.id}">
        <div class="part-head">
          ${icon("file")}
          <span class="part-name" title="${esc(p.name)}">${esc(p.name)}</span>
          <button class="btn sm ghost icon-only" data-toggle-part="${p.id}" title="${p.enabled ? "Desativar peça" : "Ativar peça"}">${icon(p.enabled ? "eye" : "eyeOff")}</button>
          <button class="btn sm ghost icon-only" data-remove-part="${p.id}" title="Remover peça">${icon("trash")}</button>
        </div>
        <div class="part-summary">${chips.join("")}</div>
        ${p.status === "ready" ? `<div class="part-row">
          <div class="part-qty">
            <button class="btn sm ghost icon-only" data-qty-step="-1" data-part="${p.id}" ${p.quantity <= 1 ? "disabled" : ""} title="Menos uma cópia">−</button>
            <input type="number" min="1" max="500" value="${p.quantity}" data-qty-input="${p.id}" />
            <button class="btn sm ghost icon-only" data-qty-step="1" data-part="${p.id}" title="Mais uma cópia">+</button>
          </div>
          <span class="small muted">cópia(s)</span>
          <label class="toggle small" style="margin-left:auto"><input type="checkbox" data-rotatable="${p.id}" ${p.rotatable ? "checked" : ""}/> girar 90° se ajudar</label>
        </div>` : ""}
      </div>`;
    })
    .join("");
  const allReady = job.parts.length > 0 && job.parts.every((p) => p.status === "ready");
  nestBox.hidden = !allReady;
  const nestBtn = $("btn-nest");
  nestBtn.disabled = !allReady || BUSY_STATUSES.has(job.status);
  // job.analysis is only ever set right after a successful nest, and the
  // backend clears it the moment any part/quantity/rotation/machine changes
  // - so its presence *is* the "still matches what's on screen" signal.
  nestBtn.innerHTML = job.analysis ? `${icon("regenerate")} Nestear novamente` : `${icon("play")} Nestear peças`;
  const totalCopies = job.parts.reduce((n, p) => n + (p.enabled ? p.quantity : 0), 0);
  $("nest-hint").textContent = job.analysis
    ? hasManualLayout(job)
      ? `Layout ajustado à mão no canvas. Nestear de novo descarta esses ajustes.`
      : `Nesting atual: ${totalCopies} cópia(s) posicionada(s). Para ajustar à mão, use "Mover peças" no canvas.`
    : `Posiciona ${totalCopies} cópia(s) automaticamente na mesa.`;
}

// ---------------------------------------------------------------------------
// Rendering: canvas
// ---------------------------------------------------------------------------
function renderCanvas() {
  const job = state.job;
  const wrap = $("bed-wrap");
  const p = profile();
  const bed = job?.analysis?.bed_mm || p?.bed_mm || [900, 600];
  const emptyState = $("empty-state");
  emptyState.hidden = !!job;
  if (job && !job.analysis) {
    // Parts uploaded but not nested yet: keep the canvas mostly blank with a
    // small hint instead of the full "envie o desenho" card.
    wrap.hidden = true;
    $("canvas-nav").hidden = true;
    $("color-bar").hidden = true;
    $("canvas-badges").innerHTML = `<span class="chip info">Peças na lista ao lado — aperte "Nestear peças" para posicioná-las na mesa</span>`;
    $("layout-badges").innerHTML = "";
    $("piece-box").hidden = true;
    return;
  }
  wrap.hidden = !job?.analysis;
  $("canvas-nav").hidden = !job?.analysis;
  if (!job?.analysis) { $("canvas-badges").innerHTML = ""; $("layout-badges").innerHTML = ""; $("piece-box").hidden = true; $("color-bar").hidden = true; return; }
  fitBed(bed);
  if (state.viewJobId !== job.id) resetView(); else applyView();
  renderCanvasMode();
  $("bed-label").textContent = `${bed[0]} × ${bed[1]} mm — ${p?.name || ""}`;
  const previewUrl = job.artifacts?.preview_svg;
  // The preview only changes when the engine redraws it, i.e. when the
  // placements it was rendered from change - not on every job update.
  const previewKey = previewUrl + job.id + JSON.stringify(job.rendered_placements || null);
  if (previewUrl && $("layer-preview").dataset.src !== previewKey) {
    $("layer-preview").dataset.src = previewKey;
    fetch(previewUrl).then((r) => r.text()).then((svg) => {
      if ($("layer-preview").dataset.src !== previewKey) return; // a newer preview won
      $("layer-preview").innerHTML = svg;
      const root = $("layer-preview").querySelector("svg");
      normalizeSvg(root);
      groupInstances(root);
      buildHitTargets();
      styleShapeElements();
      applyInstanceTransforms();
      // First time we show this job: zoom in on the parts so small pieces on a
      // big bed are actually clickable. Later reloads keep the user's view.
      if (state.viewJobId !== job.id) { state.viewJobId = job.id; fitToParts(); }
    });
  } else {
    const root = $("layer-preview").querySelector("svg");
    if (root && !root.dataset.grouped) { groupInstances(root); buildHitTargets(); }
    styleShapeElements();
    applyInstanceTransforms();
  }
  const pathUrl = job.status === "ready" ? job.artifacts?.path_svg : null;
  const layerPath = $("layer-path");
  if (pathUrl && layerPath.dataset.src !== pathUrl + job.updated_at) {
    layerPath.dataset.src = pathUrl + job.updated_at;
    fetch(pathUrl).then((r) => r.text()).then((svg) => { layerPath.innerHTML = svg; normalizeSvg(layerPath.querySelector("svg")); });
  }
  if (!pathUrl) { layerPath.innerHTML = ""; layerPath.dataset.src = ""; state.showPath = false; }
  layerPath.hidden = !state.showPath;
  layerPath.dataset.travel = state.showTravel ? "on" : "off";
  $("layer-preview").style.opacity = state.showPath ? "0.25" : "1";
  $("nav-path").disabled = !pathUrl;
  $("nav-travel").disabled = !pathUrl || !state.showPath;
  $("nav-path").classList.toggle("active", state.showPath);
  $("nav-travel").classList.toggle("active", state.showTravel);
  $("nav-grid").classList.toggle("active", state.showGrid);
  $("bed-grid").hidden = !state.showGrid;
  const badges = [];
  // Once the copies are grouped the client measures the drawn geometry itself
  // (see renderLayoutBadges); the engine's flag is the fallback before that.
  if (job.analysis.outside_bed && !$("layer-preview").querySelector("svg")?.dataset.grouped) badges.push(`<span class="chip danger">${icon("critical")} Geometria fora da mesa</span>`);
  if (job.status === "ready" && state.showPath) badges.push(`<span class="chip info">${icon("travel")} Percurso: cores por operação, tracejado = deslocamento</span>`);
  $("canvas-badges").innerHTML = badges.join("");
  renderColorBar();
}
function normalizeSvg(svg) {
  if (!svg) return;
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "none");
  // MeerK40t exports hidden="False" on every node; in HTML any `hidden` attribute hides.
  for (const el of svg.querySelectorAll("[hidden]")) {
    const flag = el.getAttribute("hidden");
    el.removeAttribute("hidden");
    if (flag === "True" || flag === "true") el.setAttribute("display", "none");
  }
  for (const el of svg.querySelectorAll("[stroke]")) {
    el.setAttribute("vector-effect", "non-scaling-stroke");
    if (!el.classList.contains("travel") && !el.classList.contains("cut")) el.setAttribute("stroke-width", "1.5");
  }
}
function fitBed(bed) {
  // Base size of the bed (zoom 1): fitted to the viewport with some margin.
  const vp = $("canvas-viewport");
  const pad = 48;
  const w = vp.clientWidth - pad * 2, h = vp.clientHeight - pad * 2 - 40;
  const scale = Math.max(0.01, Math.min(w / bed[0], h / bed[1]));
  state.view.base = { scale, w: bed[0] * scale, h: bed[1] * scale };
}

// ---------------------------------------------------------------------------
// Canvas zoom & pan. Zooming resizes the bed element (so strokes, labels and
// the grid keep their screen size) and panning translates it; the SVG inside
// stretches to the bed.
// ---------------------------------------------------------------------------
function applyView() {
  const v = state.view;
  const base = v.base;
  if (!base) return;
  const wrap = $("bed-wrap");
  wrap.style.width = `${base.w * v.zoom}px`;
  wrap.style.height = `${base.h * v.zoom}px`;
  wrap.style.transform = `translate(${v.x}px, ${v.y}px)`;
  const s = base.scale * v.zoom;
  const minor = 10 * s, major = 100 * s;
  $("bed-grid").style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`;
  $("bed-grid").style.opacity = minor < 4 ? "0.5" : "1";
  if (state.pieces.size) renderSelectionOverlay();
}
function resetView() {
  const vp = $("canvas-viewport");
  const base = state.view.base;
  if (!base) return;
  state.view = { base, zoom: 1, x: (vp.clientWidth - base.w) / 2, y: (vp.clientHeight - base.h) / 2 };
  applyView();
}
function zoomAt(factor, cx, cy) {
  // cx, cy: cursor position relative to the viewport; that point stays put.
  const v = state.view;
  if (!v.base) return;
  const vp = $("canvas-viewport");
  if (cx == null) { cx = vp.clientWidth / 2; cy = vp.clientHeight / 2; }
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor));
  const lx = (cx - v.x) / v.zoom, ly = (cy - v.y) / v.zoom; // point in base px
  v.zoom = z;
  v.x = cx - lx * z;
  v.y = cy - ly * z;
  applyView();
}
function fitToParts() {
  const job = state.job;
  const bbox = job?.analysis?.bbox_mm;
  const base = state.view.base;
  if (!bbox || !base) return resetView();
  const vp = $("canvas-viewport");
  const s = base.scale; // px per mm at zoom 1
  const bw = Math.max(1, (bbox[2] - bbox[0]) * s), bh = Math.max(1, (bbox[3] - bbox[1]) * s);
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((vp.clientWidth * 0.7) / bw, (vp.clientHeight * 0.65) / bh)));
  const bcx = ((bbox[0] + bbox[2]) / 2) * s, bcy = ((bbox[1] + bbox[3]) / 2) * s;
  state.view = { base, zoom: z, x: vp.clientWidth / 2 - bcx * z, y: vp.clientHeight / 2 - bcy * z };
  applyView();
}

// ---------------------------------------------------------------------------
// Element selection + color bar. A color is an operation: click shapes on
// the canvas, then a color in the bar to move them there. Clicking a color
// that has no operation yet creates one.
// ---------------------------------------------------------------------------
function elementOperation(elementId) {
  const ops = state.job?.params?.operations;
  const opId = state.job?.params?.assignments?.[elementId];
  return opId ? ops?.find((o) => o.id === opId) : null;
}
function colorName(color) {
  const hit = PALETTE.find(([c]) => c === String(color || "").toLowerCase());
  return hit ? hit[1] : String(color || "").toUpperCase();
}
function buildHitTargets() {
  // Next to every shape, add an invisible copy with a wide stroke so a thin
  // line is clickable without pixel-perfect aim. Same parent, so the same
  // transforms apply.
  const job = state.job;
  const root = $("layer-preview").querySelector("svg");
  if (!job?.analysis || !root) return;
  for (const old of root.querySelectorAll(".svc-hit")) old.remove();
  for (const info of job.analysis.elements) {
    const el = root.getElementById(info.id);
    if (!el || !isCuttable(info) || !HIT_TAGS.has(el.tagName.toLowerCase())) continue;
    const hit = el.cloneNode(false);
    for (const attr of ["id", "style", "class", "stroke-dasharray", "fill-opacity"]) hit.removeAttribute(attr);
    hit.setAttribute("class", "svc-hit");
    hit.setAttribute("data-hit", info.id);
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    hit.setAttribute("stroke-linecap", "round");
    hit.setAttribute("stroke-linejoin", "round");
    hit.setAttribute("vector-effect", "non-scaling-stroke");
    el.after(hit);
  }
}
function styleShapeElements() {
  const job = state.job;
  const root = $("layer-preview").querySelector("svg");
  if (!job?.analysis || !root) return;
  for (const info of job.analysis.elements) {
    const el = root.getElementById(info.id);
    if (!el) continue;
    el.classList.add("svc-shape");
    const op = isCuttable(info) ? elementOperation(info.id) : null;
    if (op) {
      el.style.stroke = op.color;
      el.style.strokeDasharray = "";
      if (el.hasAttribute("fill") && el.getAttribute("fill") !== "none") {
        el.style.fill = op.color;
        el.style.fillOpacity = "0.35";
      }
    } else {
      // Unassigned (or a reference point MeerK40t won't cut, e.g. elem point).
      el.style.stroke = "#9aa0a6";
      el.style.strokeDasharray = "2 2";
    }
    el.classList.toggle("selected", state.selected.has(info.id));
  }
  // The wide invisible hit stroke doubles as the selection highlight.
  for (const hit of root.querySelectorAll(".svc-hit")) hit.classList.toggle("selected", state.selected.has(hit.getAttribute("data-hit")));
}
function shapeIdFromEvent(e) {
  const hit = e.target.closest?.(".svc-hit");
  if (hit) return hit.getAttribute("data-hit");
  const shape = e.target.closest?.(".svc-shape");
  return shape?.id || null;
}
function setHover(id, on) {
  const root = $("layer-preview").querySelector("svg");
  if (!id || !root) return;
  root.getElementById(id)?.classList.toggle("hover", on);
  for (const hit of root.querySelectorAll(".svc-hit")) if (hit.getAttribute("data-hit") === id) hit.classList.toggle("hover", on);
}
function isCuttable(info) {
  // Reference points survive the DXF import but MeerK40t never cuts them, so
  // they don't count as belonging to an operation and can't be selected.
  return info.type !== "elem point";
}
function selectableIds() {
  return (state.job?.analysis?.elements || []).filter(isCuttable).map((info) => info.id);
}
function opElementIds(opId) {
  const assignments = state.job?.params?.assignments || {};
  const cuttable = new Set(selectableIds());
  return Object.keys(assignments).filter((eid) => assignments[eid] === opId && cuttable.has(eid));
}
function renderColorBar() {
  const job = state.job;
  const bar = $("color-bar");
  const ops = job?.params?.operations;
  if (!job?.analysis || !ops?.length || state.canvasMode === "move") { bar.hidden = true; return; }
  bar.hidden = false;
  const n = state.selected.size;
  bar.classList.toggle("armed", n > 0);
  const info = $("color-bar-info");
  info.classList.toggle("armed", n > 0);
  info.innerHTML = n > 0
    ? `<strong>${n} forma(s) selecionada(s)</strong><br>Clique numa cor para atribuir. Esc cancela.`
    : `<strong>Clique numa forma</strong> e depois numa cor para mudar a operação. Shift+clique: várias.`;
  $("btn-clear-selection").hidden = n === 0;
  const sorted = [...ops].sort((a, b) => a.order - b.order);
  const selectedOps = new Set([...state.selected].map((eid) => job.params.assignments?.[eid]));
  const usedColors = new Set();
  const entries = [];
  for (const op of sorted) {
    const color = (op.color || "#000000").toLowerCase();
    usedColors.add(color);
    const count = opElementIds(op.id).length;
    entries.push(`<button type="button" class="swatch-btn used${selectedOps.has(op.id) && n > 0 ? " active" : ""}" data-op="${esc(op.id)}" title="${esc(op.label || op.id)} · ${OP_LABELS[op.type]} · ${count} elem.${n > 0 ? " — clique para atribuir" : " — clique para selecionar tudo desta operação"}">
      <span class="swatch-color" style="background:${esc(op.color || "#000")}"><span class="swatch-count">${count}</span></span>
      <span class="swatch-label">${esc(op.label || op.id)}</span></button>`);
  }
  for (const [color, name] of PALETTE) {
    if (usedColors.has(color)) continue;
    entries.push(`<button type="button" class="swatch-btn" data-color="${color}" title="${esc(name)} — ${n > 0 ? "cria uma nova operação com a seleção" : "selecione formas primeiro"}">
      <span class="swatch-color" style="background:${color}"></span>
      <span class="swatch-label">${esc(name)}</span></button>`);
  }
  $("color-bar-swatches").innerHTML = entries.join("");
}
function nextOpId() {
  let n = 0;
  for (const op of state.job?.params?.operations || []) {
    const m = /^op_(\d+)$/.exec(op.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `op_${n + 1}`;
}
function createOperationForColor(color) {
  const job = state.job;
  const ops = job.params.operations;
  const first = [...state.selected][0];
  const proto = elementOperation(first) || ops[0] || {};
  const op = {
    id: nextOpId(),
    source: null,
    type: proto.type || "cut",
    label: colorName(color),
    enabled: true,
    order: Math.max(-1, ...ops.map((o) => o.order ?? 0)) + 1,
    speed_mm_s: proto.speed_mm_s ?? 12,
    power_pct: proto.power_pct ?? 30,
    passes: proto.passes ?? 1,
    kerf_mm: proto.type === "cut" ? proto.kerf_mm ?? 0 : 0,
    dpi: proto.dpi ?? null,
    direction: proto.direction ?? null,
    color,
  };
  // If this color was used before and emptied out, bring its settings back.
  Object.assign(op, state.colorMemory[color] || {});
  if ((op.type === "raster" || op.type === "image") && op.dpi == null) { op.dpi = 254; op.direction = op.direction || "top_to_bottom"; }
  ops.push(op);
  state.expanded.add(op.id);
  return op;
}
function pruneEmptyOperations() {
  // LightBurn-style: an operation with no shapes disappears from the list.
  // Its settings are remembered by color so re-using the color restores them.
  const ops = state.job.params.operations;
  const removed = [];
  for (const op of [...ops]) {
    if (ops.length <= 1 || opElementIds(op.id).length > 0) continue;
    const mem = {};
    for (const k of OP_SETTING_KEYS) if (op[k] != null) mem[k] = op[k];
    state.colorMemory[(op.color || "#000000").toLowerCase()] = mem;
    ops.splice(ops.indexOf(op), 1);
    state.expanded.delete(op.id);
    // Anything still pointing here is a non-cuttable leftover (reference
    // point); drop it so the server doesn't see a dangling assignment.
    const assignments = state.job.params.assignments;
    for (const eid of Object.keys(assignments)) if (assignments[eid] === op.id) delete assignments[eid];
    removed.push(op);
  }
  return removed;
}
function assignSelectionTo({ opId, color }) {
  const job = state.job;
  if (!job?.params || state.selected.size === 0) return;
  let op = opId ? job.params.operations.find((o) => o.id === opId) : null;
  let created = false;
  if (!op && color) { op = createOperationForColor(color); created = true; }
  if (!op) return;
  const moved = [...state.selected].filter((eid) => job.params.assignments[eid] !== op.id);
  for (const elementId of state.selected) job.params.assignments[elementId] = op.id;
  state.selected.clear();
  const removed = pruneEmptyOperations();
  styleShapeElements();
  renderColorBar();
  renderOps();
  renderJobBar();
  saveParams();
  if (created) {
    state.step = 2;
    renderSteps();
    toast(`Nova operação "${op.label}" com ${moved.length} forma(s). Ajuste velocidade e potência ao lado.`);
  } else if (moved.length === 0) {
    toast(`Já estavam em "${op.label || op.id}".`);
  } else {
    const extra = removed.length ? ` "${removed.map((r) => r.label || r.id).join('", "')}" ficou vazia e foi removida.` : "";
    toast(`${moved.length} forma(s) → "${op.label || op.id}".${extra}`);
  }
}
function selectOperationElements(opId) {
  const ids = opElementIds(opId);
  state.selected = new Set(ids);
  styleShapeElements();
  renderColorBar();
  const op = state.job.params.operations.find((o) => o.id === opId);
  toast(ids.length ? `${ids.length} forma(s) de "${op?.label || opId}" selecionada(s). Clique noutra cor para movê-las.` : "Essa operação não tem formas.");
}
function selectAll() {
  state.selected = new Set(selectableIds());
  styleShapeElements();
  renderColorBar();
}
function clearSelection() {
  if (state.selected.size === 0 && state.pieces.size === 0) return;
  state.selected.clear();
  state.pieces.clear();
  styleShapeElements();
  renderColorBar();
  applyInstanceTransforms();
}

// ---------------------------------------------------------------------------
// Manual layout: moving, rotating and scaling copies on the canvas.
//
// The preview.svg the engine exports is the truth for what is drawn; on load
// every copy's shapes are regrouped under <g class="svc-inst"><g class="body">
// with their absolute matrix baked in, so one transform on the body moves the
// whole copy. That transform is the delta between job.rendered_placements
// (what the SVG was drawn from) and job.placements (what the user wants), in
// exactly the sequence service/core/mk_job.py:position_part_instance applies:
// scale and rotate about the copy's center, then move the center. When the
// server re-analyzes, both match again and the delta is the identity.
// ---------------------------------------------------------------------------
const SVG_NS = "http://www.w3.org/2000/svg";
const MOVE_SNAP_MM = 0.5, ROTATE_SNAP_DEG = 15, SCALE_MIN = 0.1, SCALE_MAX = 10;
const HANDLE_PX = 9;

const instKey = (elementId) => String(elementId).split(":")[0];
const placementKey = (p) => `${p.part_id}#${p.instance_index}`;
function placementOf(key, list = state.job?.placements) {
  return (list || []).find((p) => placementKey(p) === key) || null;
}
function samePlacement(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.cx_mm - b.cx_mm) < 1e-4 && Math.abs(a.cy_mm - b.cy_mm) < 1e-4
    && Math.abs(((a.rotation_deg - b.rotation_deg) % 360 + 360) % 360) < 1e-4 && Math.abs(a.scale - b.scale) < 1e-6;
}
function hasManualLayout(job) {
  if (!job?.placements || !job?.nest_placements) return false;
  return job.placements.some((p) => !samePlacement(p, placementOf(placementKey(p), job.nest_placements)));
}
function layoutPending(job) {
  if (!job?.placements || !job?.rendered_placements) return false;
  return job.placements.some((p) => !samePlacement(p, placementOf(placementKey(p), job.rendered_placements)));
}
function instanceName(key) {
  const [partId, idx] = key.split("#");
  const part = state.job?.parts.find((p) => p.id === partId);
  const copies = part ? part.quantity : 1;
  return `${part?.name || partId}${copies > 1 ? ` · cópia ${idx}` : ""}`;
}
function previewRoot() {
  return $("layer-preview").querySelector("svg");
}
function unitsPerMm(root) {
  const bed = state.job?.analysis?.bed_mm || [900, 600];
  return root.viewBox.baseVal.width / bed[0];
}
function pxPerMm() {
  return state.view.base ? state.view.base.scale * state.view.zoom : 1;
}
function groupInstances(root) {
  // One <g> per copy, straight under the root, shapes carrying their full
  // matrix: the export's own grouping varies by importer, this doesn't.
  const job = state.job;
  if (!job?.analysis || !root || root.dataset.grouped) return;
  const rootScreen = root.getScreenCTM();
  if (!rootScreen) return; // not laid out yet; the next render tries again
  const inv = rootScreen.inverse();
  const bodies = new Map();
  for (const info of job.analysis.elements) {
    const el = root.getElementById(info.id);
    if (!el) continue;
    const key = instKey(info.id);
    let body = bodies.get(key);
    if (!body) {
      const outer = document.createElementNS(SVG_NS, "g");
      outer.setAttribute("class", "svc-inst");
      outer.dataset.inst = key;
      body = document.createElementNS(SVG_NS, "g");
      body.setAttribute("class", "svc-inst-body");
      outer.appendChild(body);
      root.appendChild(outer);
      bodies.set(key, body);
    }
    const screen = el.getScreenCTM();
    if (screen) {
      const m = inv.multiply(screen);
      el.setAttribute("transform", `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
    }
    body.appendChild(el);
  }
  for (const g of [...root.querySelectorAll("g:not(.svc-inst):not(.svc-inst-body)")]) if (!g.querySelector("*")) g.remove();
  // Shapes are outlines with no fill, so a click inside a piece would hit
  // nothing: give every copy an invisible area over its whole box (move mode
  // only, see CSS) so it can be grabbed anywhere.
  for (const body of bodies.values()) {
    const b = body.getBBox();
    const area = document.createElementNS(SVG_NS, "rect");
    area.setAttribute("class", "svc-inst-area");
    area.setAttribute("x", b.x); area.setAttribute("y", b.y);
    area.setAttribute("width", b.width); area.setAttribute("height", b.height);
    area.setAttribute("fill", "transparent"); area.setAttribute("stroke", "none");
    body.insertBefore(area, body.firstChild);
  }
  root.dataset.grouped = "1";
}
function deltaTransform(rendered, current, upm) {
  // Applied right-to-left: scale about the rendered center, rotate about it,
  // then translate the center - the same order the engine uses.
  const px = rendered.cx_mm * upm, py = rendered.cy_mm * upm;
  const ds = current.scale / rendered.scale;
  const dth = current.rotation_deg - rendered.rotation_deg;
  const tx = (current.cx_mm - rendered.cx_mm) * upm, ty = (current.cy_mm - rendered.cy_mm) * upm;
  return `translate(${tx} ${ty}) rotate(${dth} ${px} ${py}) translate(${px} ${py}) scale(${ds}) translate(${-px} ${-py})`;
}
function applyInstanceTransforms(override = null) {
  // override: Map key -> placement, used mid-gesture before anything is committed.
  const job = state.job;
  const root = previewRoot();
  if (!job?.placements || !root?.dataset.grouped) return;
  const upm = unitsPerMm(root);
  for (const outer of root.querySelectorAll(".svc-inst")) {
    const key = outer.dataset.inst;
    const rendered = placementOf(key, job.rendered_placements) || placementOf(key);
    const current = override?.get(key) || placementOf(key);
    const body = outer.firstElementChild;
    if (!rendered || !current || samePlacement(rendered, current)) body.removeAttribute("transform");
    else body.setAttribute("transform", deltaTransform(rendered, current, upm));
    outer.classList.toggle("selected", state.pieces.has(key));
    outer.classList.toggle("moved", !samePlacement(current, placementOf(key, job.nest_placements)));
  }
  renderSelectionOverlay();
  renderLayoutBadges();
}
function instanceBox(key) {
  // Exact axis-aligned box of the copy as drawn (after its delta), in mm.
  const root = previewRoot();
  const outer = root?.querySelector(`.svc-inst[data-inst="${CSS.escape(key)}"]`);
  if (!outer) return null;
  const b = outer.getBBox();
  const upm = unitsPerMm(root);
  return { x0: b.x / upm, y0: b.y / upm, x1: (b.x + b.width) / upm, y1: (b.y + b.height) / upm };
}
function allInstanceKeys() {
  return (state.job?.placements || []).map(placementKey);
}
function unionBox(boxes) {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  return {
    x0: Math.min(...list.map((b) => b.x0)), y0: Math.min(...list.map((b) => b.y0)),
    x1: Math.max(...list.map((b) => b.x1)), y1: Math.max(...list.map((b) => b.y1)),
  };
}
function layoutIssues() {
  // Client-side, from the drawn geometry; the engine's own check replaces it
  // once the re-analysis lands.
  const bed = state.job?.analysis?.bed_mm || [900, 600];
  const boxes = allInstanceKeys().map((key) => [key, instanceBox(key)]).filter(([, b]) => b);
  const outside = boxes.filter(([, b]) => b.x0 < -0.01 || b.y0 < -0.01 || b.x1 > bed[0] + 0.01 || b.y1 > bed[1] + 0.01).map(([k]) => k);
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i][1], b = boxes[j][1];
      if (a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01) overlaps.push([boxes[i][0], boxes[j][0]]);
    }
  }
  const scaled = (state.job?.placements || []).filter((p) => Math.abs(p.scale - 1) > 1e-6).map(placementKey);
  return { outside, overlaps, scaled };
}
function renderLayoutBadges() {
  const job = state.job;
  const box = $("layout-badges");
  if (!job?.analysis || !previewRoot()?.dataset.grouped) { box.innerHTML = ""; return; }
  const issues = layoutIssues();
  const chips = [];
  if (issues.outside.length) chips.push(`<span class="chip danger">${icon("critical")} ${issues.outside.length} peça(s) fora da mesa</span>`);
  if (issues.overlaps.length) chips.push(`<span class="chip danger">${icon("critical")} ${issues.overlaps.length} sobreposição(ões) entre peças</span>`);
  if (issues.scaled.length) chips.push(`<span class="chip warn" title="A escala muda o tamanho real do corte. Confira as medidas antes de gerar.">${icon("warning")} ${issues.scaled.length} peça(s) com escala alterada</span>`);
  if (job.status === "relayout" || layoutPending(job)) chips.push(`<span class="chip info">Atualizando pré-visualização…</span>`);
  if (state.canvasMode === "move" && state.pieces.size === 0) chips.push(`<span class="chip">${icon("move")} Clique ou arraste uma peça para movê-la · arraste na mesa vazia para selecionar várias · Espaço+arrastar ou botão do meio: pan</span>`);
  box.innerHTML = chips.join("");
}

// --- selection overlay: dashed boxes, one frame with handles around the selection
function renderSelectionOverlay() {
  const svg = $("layer-select");
  const job = state.job;
  const bed = job?.analysis?.bed_mm || [900, 600];
  svg.setAttribute("viewBox", `0 0 ${bed[0]} ${bed[1]}`);
  if (state.canvasMode !== "move" || state.pieces.size === 0 || !previewRoot()?.dataset.grouped) { svg.innerHTML = ""; renderPieceBox(); return; }
  const s = pxPerMm();
  const boxes = [...state.pieces].map((key) => instanceBox(key));
  const group = unionBox(boxes);
  const parts = [];
  for (const b of boxes) {
    if (!b) continue;
    parts.push(`<rect class="sel-piece" x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" vector-effect="non-scaling-stroke"/>`);
  }
  if (group) {
    const h = HANDLE_PX / s; // handle size in mm so it stays HANDLE_PX on screen
    const pad = 3 / s;
    const x0 = group.x0 - pad, y0 = group.y0 - pad, x1 = group.x1 + pad, y1 = group.y1 + pad;
    parts.push(`<rect class="sel-frame" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" vector-effect="non-scaling-stroke"/>`);
    const cx = (x0 + x1) / 2;
    const rotY = y0 - 22 / s;
    parts.push(`<line class="sel-stem" x1="${cx}" y1="${y0}" x2="${cx}" y2="${rotY}" vector-effect="non-scaling-stroke"/>`);
    parts.push(`<circle class="sel-handle rot" data-handle="rot" cx="${cx}" cy="${rotY}" r="${h / 2}" vector-effect="non-scaling-stroke"><title>Girar (Shift: de 15 em 15°)</title></circle>`);
    for (const [name, hx, hy] of [["nw", x0, y0], ["ne", x1, y0], ["sw", x0, y1], ["se", x1, y1]]) {
      parts.push(`<rect class="sel-handle scale ${name}" data-handle="${name}" x="${hx - h / 2}" y="${hy - h / 2}" width="${h}" height="${h}" vector-effect="non-scaling-stroke"><title>Escalar (proporção mantida)</title></rect>`);
    }
  }
  svg.innerHTML = parts.join("");
  renderPieceBox(group);
}

// --- numeric box next to the selection (precise moves, angle, scale)
function renderPieceBox(group) {
  const box = $("piece-box");
  const job = state.job;
  const keys = [...state.pieces];
  if (state.canvasMode !== "move" || !keys.length || !job?.placements) { box.hidden = true; return; }
  if (group === undefined) group = unionBox(keys.map((key) => instanceBox(key)));
  const single = keys.length === 1 ? placementOf(keys[0]) : null;
  const focused = document.activeElement?.closest?.("#piece-box") ? document.activeElement.id : null;
  const keep = (id) => (focused === id ? $(id).value : null);
  const dx = keep("pb-dx") ?? "", dy = keep("pb-dy") ?? "";
  const rot = keep("pb-rot") ?? (single ? String(Math.round(single.rotation_deg * 100) / 100) : "");
  const scale = keep("pb-scale") ?? (single ? String(Math.round(single.scale * 10000) / 100) : "");
  const w = group ? group.x1 - group.x0 : 0, h = group ? group.y1 - group.y0 : 0;
  const title = single ? instanceName(keys[0]) : `${keys.length} peças selecionadas`;
  const nestSame = keys.every((key) => samePlacement(placementOf(key), placementOf(key, job.nest_placements)));
  box.hidden = false;
  box.innerHTML = `
    <div class="pb-title" title="${esc(title)}">${esc(title)}</div>
    <div class="pb-row">
      <span class="pb-label">Mover</span>
      <label class="pb-field">X <input class="control" type="number" id="pb-dx" step="0.1" value="${esc(dx)}" placeholder="0" /> mm</label>
      <label class="pb-field">Y <input class="control" type="number" id="pb-dy" step="0.1" value="${esc(dy)}" placeholder="0" /> mm</label>
      <button class="btn sm" id="pb-apply-move" title="Desloca a seleção pela distância informada (Enter)">Aplicar</button>
    </div>
    <div class="pb-row">
      <label class="pb-field">${single ? "Rotação" : "Girar mais"} <input class="control" type="number" id="pb-rot" step="1" value="${esc(rot)}" placeholder="0" /> °</label>
      <label class="pb-field">${single ? "Escala" : "Escalar por"} <input class="control" type="number" id="pb-scale" step="1" min="10" max="1000" value="${esc(scale)}" placeholder="100" /> %</label>
    </div>
    <div class="pb-info">${group ? `${w.toFixed(1)} × ${h.toFixed(1)} mm · canto em X ${group.x0.toFixed(1)}, Y ${group.y0.toFixed(1)} mm` : ""}</div>
    <div class="pb-row pb-actions">
      <button class="btn sm ghost" id="pb-reset" ${nestSame ? "disabled" : ""} title="Volta a seleção para onde o nesting a deixou">${icon("regenerate")} Restaurar seleção</button>
      <span class="small muted">Setas: 1 mm · Shift+setas: 10 mm</span>
    </div>`;
  if (focused && $(focused)) { const el = $(focused); el.focus(); el.select?.(); }
  // Sit beside the selection's top-right corner, kept inside the viewport.
  const vp = $("canvas-viewport");
  const v = state.view, s = pxPerMm();
  const px = group ? v.x + group.x1 * s + 14 : vp.clientWidth / 2;
  const py = group ? v.y + group.y0 * s : vp.clientHeight / 2;
  const bw = box.offsetWidth || 300, bh = box.offsetHeight || 150;
  let left = px, top = py;
  if (group && px + bw > vp.clientWidth - 8) {
    const atLeft = v.x + group.x0 * s - bw - 14;
    if (atLeft >= 8) left = atLeft;
    else { left = v.x + group.x0 * s; top = v.y + group.y1 * s + 14; } // no room beside it: go below
  }
  box.style.left = `${Math.max(8, Math.min(left, vp.clientWidth - bw - 8))}px`;
  box.style.top = `${Math.min(Math.max(8, top), Math.max(8, vp.clientHeight - bh - 8))}px`;
}

// --- editing primitives (all in mm; they only touch state.job.placements)
function updatePlacements(mutate) {
  const job = state.job;
  if (!job?.placements) return;
  job.placements = job.placements.map((p) => (state.pieces.has(placementKey(p)) ? mutate({ ...p }) : p));
  applyInstanceTransforms();
  commitLayout();
}
function nudgeSelection(dx, dy) {
  updatePlacements((p) => ({ ...p, cx_mm: p.cx_mm + dx, cy_mm: p.cy_mm + dy }));
}
function rotateSelection(deltaDeg, { absolute = false } = {}) {
  const boxes = [...state.pieces].map((key) => instanceBox(key));
  const group = unionBox(boxes);
  if (!group) return;
  const gx = (group.x0 + group.x1) / 2, gy = (group.y0 + group.y1) / 2;
  const single = state.pieces.size === 1;
  updatePlacements((p) => {
    const d = absolute ? deltaDeg - p.rotation_deg : deltaDeg;
    const rad = (d * Math.PI) / 180;
    // A single piece turns about its own center; a group turns about the
    // group's center so the pieces keep their relative arrangement.
    const px = single ? p.cx_mm : gx, py = single ? p.cy_mm : gy;
    const rx = p.cx_mm - px, ry = p.cy_mm - py;
    return {
      ...p,
      rotation_deg: (((p.rotation_deg + d) % 360) + 360) % 360,
      cx_mm: px + rx * Math.cos(rad) - ry * Math.sin(rad),
      cy_mm: py + rx * Math.sin(rad) + ry * Math.cos(rad),
    };
  });
}
function scaleSelection(factor, { absolute = false, pivot = null } = {}) {
  const boxes = [...state.pieces].map((key) => instanceBox(key));
  const group = unionBox(boxes);
  if (!group) return;
  const gx = pivot ? pivot.x : (group.x0 + group.x1) / 2, gy = pivot ? pivot.y : (group.y0 + group.y1) / 2;
  const single = state.pieces.size === 1;
  updatePlacements((p) => {
    let f = absolute ? factor / p.scale : factor;
    const target = Math.min(SCALE_MAX, Math.max(SCALE_MIN, p.scale * f));
    f = target / p.scale;
    const px = single && !pivot ? p.cx_mm : gx, py = single && !pivot ? p.cy_mm : gy;
    return { ...p, scale: target, cx_mm: px + (p.cx_mm - px) * f, cy_mm: py + (p.cy_mm - py) * f };
  });
}
function resetSelectionLayout() {
  const job = state.job;
  updatePlacements((p) => ({ ...placementOf(placementKey(p), job.nest_placements) }));
}
function commitLayout() {
  // Store right away (a reload must not lose the work); the server keeps
  // operations/assignments and re-renders the preview in the background.
  clearTimeout(state.layoutTimer);
  const job = state.job;
  if (!job?.placements) return;
  state.layoutDirty = true;
  renderLayoutBadges();
  renderParts();
  state.layoutTimer = setTimeout(async () => {
    const payload = job.placements.map((p) => ({ part_id: p.part_id, instance_index: p.instance_index, cx_mm: p.cx_mm, cy_mm: p.cy_mm, rotation_deg: p.rotation_deg, scale: p.scale }));
    try {
      const saved = await api(`/api/jobs/${job.id}/layout`, { method: "PUT", json: { placements: payload } });
      if (state.job?.id !== job.id) return;
      state.layoutDirty = false;
      // Keep our placements (identical to what was sent); take everything else.
      state.job = { ...saved, placements: job.placements };
      renderJobBar(); renderResult(); renderLayoutBadges();
      schedulePoll();
    } catch (e) { toast(`Não foi possível salvar o layout: ${e.message}`); }
  }, 300);
}
async function resetLayout() {
  const job = state.job;
  if (!job || !hasManualLayout(job)) return;
  if (!confirm("Restaurar todas as peças para as posições do nesting? Os ajustes manuais de posição, rotação e escala serão perdidos.")) return;
  try {
    clearTimeout(state.layoutTimer);
    state.layoutDirty = false;
    state.job = await api(`/api/jobs/${job.id}/layout/reset`, { method: "POST" });
    applyInstanceTransforms();
    renderAll();
    schedulePoll();
    toast("Layout do nesting restaurado.");
  } catch (e) { toast(`Não foi possível restaurar: ${e.message}`); }
}

// --- mode + selection
function setCanvasMode(mode) {
  if (state.canvasMode === mode) return;
  state.canvasMode = mode;
  state.selected.clear();
  state.pieces.clear();
  renderCanvasMode();
  styleShapeElements();
  renderColorBar();
  applyInstanceTransforms();
}
function renderCanvasMode() {
  const move = state.canvasMode === "move";
  $("nav-mode-select").classList.toggle("active", !move);
  $("nav-mode-move").classList.toggle("active", move);
  $("canvas-viewport").classList.toggle("mode-move", move);
  $("nav-reset-layout").disabled = !hasManualLayout(state.job);
  $("nav-reset-layout").hidden = !move;
}
function selectPieces(keys, { add = false } = {}) {
  if (!add) state.pieces.clear();
  for (const key of keys) state.pieces.add(key);
  applyInstanceTransforms();
}
function togglePiece(key) {
  if (state.pieces.has(key)) state.pieces.delete(key); else state.pieces.add(key);
  applyInstanceTransforms();
}
function pieceKeyFromEvent(e) {
  // Where pieces overlap, an outline under the pointer beats the box area of
  // whichever piece happens to be drawn on top.
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  const outline = stack.find((el) => el.classList?.contains("svc-hit") || el.classList?.contains("svc-shape"));
  const hit = outline || stack.find((el) => el.classList?.contains("svc-inst-area")) || e.target;
  return hit.closest?.(".svc-inst")?.dataset.inst || null;
}
function viewportPoint(e) {
  const rect = $("canvas-viewport").getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function toMm(pt) {
  const s = pxPerMm();
  return { x: (pt.x - state.view.x) / s, y: (pt.y - state.view.y) / s };
}

// --- gestures: move (drag body), rotate (top handle), scale (corners), marquee
function beginGesture(kind, e, extra = {}) {
  const start = toMm(viewportPoint(e));
  const startPlacements = new Map([...state.pieces].map((key) => [key, { ...placementOf(key) }]));
  const group = unionBox([...state.pieces].map((key) => instanceBox(key)));
  state.drag = { kind, start, startPlacements, group, moved: false, clientX: e.clientX, clientY: e.clientY, ...extra };
  $("canvas-viewport").classList.add("dragging");
}
function updateGesture(e) {
  const d = state.drag;
  const cur = toMm(viewportPoint(e));
  const override = new Map();
  if (d.kind === "move") {
    let dx = cur.x - d.start.x, dy = cur.y - d.start.y;
    if (!e.altKey) { dx = Math.round(dx / MOVE_SNAP_MM) * MOVE_SNAP_MM; dy = Math.round(dy / MOVE_SNAP_MM) * MOVE_SNAP_MM; }
    for (const [key, p] of d.startPlacements) override.set(key, { ...p, cx_mm: p.cx_mm + dx, cy_mm: p.cy_mm + dy });
    d.last = { dx, dy };
  } else if (d.kind === "rotate") {
    const g = d.group, gx = (g.x0 + g.x1) / 2, gy = (g.y0 + g.y1) / 2;
    let deg = ((Math.atan2(cur.y - gy, cur.x - gx) - Math.atan2(d.start.y - gy, d.start.x - gx)) * 180) / Math.PI;
    deg = e.shiftKey ? Math.round(deg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG : Math.round(deg);
    const rad = (deg * Math.PI) / 180;
    const single = d.startPlacements.size === 1;
    for (const [key, p] of d.startPlacements) {
      const px = single ? p.cx_mm : gx, py = single ? p.cy_mm : gy;
      const rx = p.cx_mm - px, ry = p.cy_mm - py;
      override.set(key, { ...p, rotation_deg: (((p.rotation_deg + deg) % 360) + 360) % 360, cx_mm: px + rx * Math.cos(rad) - ry * Math.sin(rad), cy_mm: py + rx * Math.sin(rad) + ry * Math.cos(rad) });
    }
    d.last = { deg };
  } else if (d.kind === "scale") {
    // Uniform: the factor is how far the pointer went along the frame's
    // diagonal, measured from the corner opposite the handle.
    const g = d.group;
    const pivot = { x: d.handle.includes("w") ? g.x1 : g.x0, y: d.handle.includes("n") ? g.y1 : g.y0 };
    const d0 = Math.hypot(d.start.x - pivot.x, d.start.y - pivot.y) || 1;
    const d1 = Math.hypot(cur.x - pivot.x, cur.y - pivot.y);
    let f = Math.round((d1 / d0) * 100) / 100;
    for (const [key, p] of d.startPlacements) {
      const target = Math.min(SCALE_MAX, Math.max(SCALE_MIN, p.scale * f));
      const ff = target / p.scale;
      override.set(key, { ...p, scale: target, cx_mm: pivot.x + (p.cx_mm - pivot.x) * ff, cy_mm: pivot.y + (p.cy_mm - pivot.y) * ff });
    }
    d.last = { f, pivot };
  } else if (d.kind === "marquee") {
    const a = viewportPoint(e), b = d.startPx;
    const m = $("marquee");
    m.hidden = false;
    m.style.left = `${Math.min(a.x, b.x)}px`; m.style.top = `${Math.min(a.y, b.y)}px`;
    m.style.width = `${Math.abs(a.x - b.x)}px`; m.style.height = `${Math.abs(a.y - b.y)}px`;
    return;
  }
  d.override = override;
  applyInstanceTransforms(override);
}
function endGesture(e) {
  const d = state.drag;
  state.drag = null;
  $("canvas-viewport").classList.remove("dragging");
  $("marquee").hidden = true;
  if (d.kind === "marquee") {
    if (!d.moved) return;
    const a = toMm(viewportPoint(e)), b = d.start;
    const r = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const hit = allInstanceKeys().filter((key) => { const bx = instanceBox(key); return bx && bx.x0 < r.x1 && r.x0 < bx.x1 && bx.y0 < r.y1 && r.y0 < bx.y1; });
    selectPieces(hit, { add: e.shiftKey });
    return;
  }
  if (!d.moved || !d.override) { applyInstanceTransforms(); return; }
  state.job.placements = state.job.placements.map((p) => d.override.get(placementKey(p)) || p);
  applyInstanceTransforms();
  commitLayout();
}

// ---------------------------------------------------------------------------
// Rendering: operations
// ---------------------------------------------------------------------------
function opSummary(op) {
  const chips = [`<span class="chip">${icon("speed")} ${op.speed_mm_s} mm/s</span>`, `<span class="chip">${icon("power")} ${op.power_pct} %</span>`];
  if (op.passes > 1) chips.push(`<span class="chip">${icon("passes")} ${op.passes} passes</span>`);
  if (op.type === "cut" && op.kerf_mm) chips.push(`<span class="chip">${icon("kerf")} kerf ${op.kerf_mm} mm</span>`);
  if ((op.type === "raster" || op.type === "image") && op.dpi) chips.push(`<span class="chip">${icon("dpi")} ${op.dpi} dpi</span>`);
  const est = state.job?.estimate?.by_operation?.[op.id];
  if (est && state.job.status === "ready" && !state.job.stale) chips.push(`<span class="chip ok">${icon("time")} ${fmtTime(est.cut_s)}</span>`);
  return chips.join("");
}
function sourceLabel(op) {
  const s = op.source || {};
  if (s.layer) return `layer ${s.layer}`;
  if (s.color) return `cor ${s.color}`;
  return "seleção manual";
}
function opElementCount(op) {
  return opElementIds(op.id).length;
}
function numField(op, key, label, unit, opts = {}) {
  const errors = validateOp(op);
  const v = op[key] ?? "";
  return `<div class="field${errors[key] ? " invalid" : ""}">
    <label for="f-${op.id}-${key}">${label}</label>
    <div class="unit-input"><input class="control" type="number" id="f-${op.id}-${key}" data-op="${op.id}" data-key="${key}" value="${esc(v)}" step="${opts.step ?? 1}" min="${opts.min ?? 0}"${opts.max != null ? ` max="${opts.max}"` : ""} /><span class="unit">${unit}</span></div>
    ${errors[key] ? `<span class="error">${errors[key]}</span>` : opts.hint ? `<span class="hint">${opts.hint}</span>` : ""}
  </div>`;
}
function renderOps() {
  const job = state.job;
  const list = $("op-list");
  if (!job?.params) { list.innerHTML = ""; return; }
  const ops = [...job.params.operations].sort((a, b) => a.order - b.order);
  list.innerHTML = ops.map((op, index) => {
    const errors = validateOp(op);
    const open = state.expanded.has(op.id);
    const count = opElementCount(op);
    return `<div class="op-card${op.enabled ? "" : " disabled"}${Object.keys(errors).length ? " has-error" : ""}" data-op="${op.id}">
      <div class="op-head">
        <span class="drag" title="Ordem de execução">${index + 1}</span>
        <span class="swatch" style="background:${esc(op.color || "#000")}"></span>
        <div class="op-title" data-toggle="${op.id}">
          <div class="op-name">${icon(OP_ICONS[op.type])} ${esc(op.label || op.id)} <span class="muted small" style="font-weight:400">· ${OP_LABELS[op.type]} · ${count} elem. · ${esc(sourceLabel(op))}</span></div>
          <div class="op-summary">${opSummary(op)}</div>
        </div>
        <div class="op-actions">
          <button class="btn sm ghost icon-only" data-move="up" data-op="${op.id}" title="Executar antes" ${index === 0 ? "disabled" : ""}>${icon("up")}</button>
          <button class="btn sm ghost icon-only" data-move="down" data-op="${op.id}" title="Executar depois" ${index === ops.length - 1 ? "disabled" : ""}>${icon("down")}</button>
          <button class="btn sm ghost icon-only" data-enable="${op.id}" title="${op.enabled ? "Desativar operação" : "Ativar operação"}" aria-pressed="${op.enabled}">${icon(op.enabled ? "eye" : "eyeOff")}</button>
        </div>
      </div>
      ${open ? `<div class="op-body">
        <div class="control-row">
          <div class="field"><label for="f-${op.id}-type">Tipo</label><select class="control" id="f-${op.id}-type" data-op="${op.id}" data-key="type">${Object.entries(OP_LABELS).map(([k, v]) => `<option value="${k}"${k === op.type ? " selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field" style="grid-column: span 2"><label for="f-${op.id}-label">Nome</label><input class="control" id="f-${op.id}-label" data-op="${op.id}" data-key="label" value="${esc(op.label || "")}" /></div>
        </div>
        <div class="subhead">Parâmetros</div>
        <div class="control-row">
          ${numField(op, "speed_mm_s", "Velocidade", "mm/s", { step: 0.5, min: 0.1 })}
          ${numField(op, "power_pct", "Potência", "%", { min: 0, max: 100 })}
          ${numField(op, "passes", "Passes", "×", { min: 1, max: 50 })}
        </div>
        ${op.type === "cut" ? `<div class="subhead">Geometria</div><div class="control-row">${numField(op, "kerf_mm", "Compensação de kerf", "mm", { step: 0.05, min: 0, max: 5, hint: "Metade da largura do feixe. 0 desliga." })}</div>` : ""}
        ${op.type === "raster" || op.type === "image" ? `<div class="subhead">Raster</div><div class="control-row">
          ${numField(op, "dpi", "Resolução", "dpi", { min: 50, max: 1200 })}
          <div class="field" style="grid-column: span 2"><label for="f-${op.id}-direction">Direção da varredura</label><select class="control" id="f-${op.id}-direction" data-op="${op.id}" data-key="direction">${Object.entries(DIRECTIONS).map(([k, v]) => `<option value="${k}"${k === (op.direction || "top_to_bottom") ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        </div>` : ""}
      </div>` : ""}
    </div>`;
  }).join("");
  $("opt-enabled").checked = job.params.optimize?.enabled ?? true;
  $("opt-inner").checked = job.params.optimize?.inner_first ?? true;
  $("opt-travel").checked = job.params.optimize?.reduce_travel ?? true;
  $("opt-inner").disabled = $("opt-travel").disabled = !$("opt-enabled").checked;
}

// ---------------------------------------------------------------------------
// Rendering: result, job bar, history
// ---------------------------------------------------------------------------
function warningsList(job) {
  const list = [...(job?.warnings || [])];
  if (job?.analysis?.outside_bed && !list.some((w) => w.code === "outside_bed")) list.push({ code: "outside_bed", severity: "critical", message: "Há geometria fora da área útil da máquina." });
  return list;
}
function renderResult() {
  const job = state.job;
  const body = $("result-body");
  if (job?.status !== "ready") { body.innerHTML = ""; return; }
  const e = job.estimate;
  const ops = [...job.params.operations].sort((a, b) => a.order - b.order);
  const warns = warningsList(job);
  const critical = warns.filter((w) => w.severity === "critical");
  body.innerHTML = `
    ${job.stale ? `<div class="banner warn">${icon("warning")}<div>Os parâmetros mudaram depois da geração. <strong>Gere o arquivo novamente</strong> antes de baixar.</div></div>` : ""}
    <div class="stats">
      <div class="stat"><div class="value">${fmtTime(e.total_s)}</div><div class="label">tempo total</div></div>
      <div class="stat"><div class="value">${fmtMm(e.cut_mm)}</div><div class="label">de corte/gravação</div></div>
      <div class="stat"><div class="value">${fmtMm(e.travel_mm)}</div><div class="label">em vazio · ${fmtTime(e.travel_s)}</div></div>
    </div>
    <table class="ops" style="margin-top:12px"><thead><tr><th>Operação</th><th class="num">Tempo</th><th class="num">Distância</th></tr></thead><tbody>
      ${ops.map((op) => { const s = e.by_operation?.[op.id] || {}; return `<tr><td><span class="swatch" style="background:${esc(job.colors?.[op.id] || op.color)};display:inline-block;vertical-align:middle;margin-right:6px"></span>${esc(op.label || op.id)}${op.enabled ? "" : ' <span class="chip">desativada</span>'}</td><td class="num">${fmtTime(s.cut_s)}</td><td class="num">${fmtMm(s.cut_mm)}</td></tr>`; }).join("")}
    </tbody></table>
    ${warns.length ? `<div class="banner ${critical.length ? "danger" : "warn"}" style="margin-top:12px">${icon(critical.length ? "critical" : "warning")}<div><strong>${warns.length} aviso(s)</strong><ul>${warns.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul></div></div>` : `<div class="banner ok" style="margin-top:12px">${icon("ok")}<div>Nenhum aviso. Arquivo pronto para a máquina.</div></div>`}
    ${critical.length ? `<label class="toggle" style="margin-top:8px"><input type="checkbox" id="confirm-critical" ${state.confirmCritical ? "checked" : ""}/> Entendo os riscos e quero baixar mesmo assim</label>` : ""}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" id="btn-toggle-path">${icon("travel")} ${state.showPath ? "Ocultar percurso" : "Ver percurso na mesa"}</button>
      <button class="btn" id="btn-duplicate">${icon("duplicate")} Duplicar trabalho</button>
    </div>
    <p class="small muted" style="margin-top:8px">Arquivo: ${esc(job.name)} → <strong>.rd</strong> (${Math.round((job.artifacts?.rd_bytes || 0) / 1024)} KB) · magic 0x${(profile()?.magic || 136).toString(16).toUpperCase()}</p>`;
}
const BUSY_LABEL = { analyzing_parts: "Analisando peça(s)…", nesting: "Posicionando peças…", relayout: "Atualizando a pré-visualização…", generating: "Gerando o arquivo da máquina…" };

function renderJobBar() {
  const job = state.job;
  const busy = job && BUSY_STATUSES.has(job.status);
  const warns = warningsList(job);
  const critical = warns.filter((w) => w.severity === "critical").length;
  const wbox = $("jobbar-warnings");
  if (!job) wbox.innerHTML = `<span class="muted">Envie um arquivo para começar.</span>`;
  else if (job.status === "failed") wbox.innerHTML = `<span class="chip danger">${icon("critical")} ${esc(job.error?.message || "Falha no processamento")}</span>`;
  else if (busy) wbox.innerHTML = `<span class="chip info">${BUSY_LABEL[job.status] || "Processando…"}</span>`;
  else if (job.status === "parts_ready") wbox.innerHTML = `<span class="muted">Aperte "Nestear peças" para posicioná-las na mesa.</span>`;
  else if (warns.length) wbox.innerHTML = `<span class="chip ${critical ? "danger" : "warn"}">${icon(critical ? "critical" : "warning")} ${warns.length} aviso(s)${critical ? ` · ${critical} crítico(s)` : ""}</span><button class="btn sm ghost" id="btn-see-warnings">Ver</button>`;
  else if (job.status === "ready") wbox.innerHTML = `<span class="chip ok">${icon("ok")} Sem avisos</span>`;
  else wbox.innerHTML = `<span class="muted">Ajuste as operações e gere o arquivo.</span>`;
  const est = $("jobbar-estimate");
  est.hidden = !(job?.estimate && job.status === "ready");
  $("estimate-value").textContent = fmtTime(job?.estimate?.total_s);
  $("estimate-value").style.opacity = job?.stale ? "0.4" : "1";
  const gen = $("btn-generate");
  gen.disabled = !job?.analysis || busy || !paramsValid();
  gen.innerHTML = job?.status === "ready" ? `${icon("regenerate")} Gerar novamente` : `${icon("play")} Gerar arquivo`;
  const dl = $("btn-download");
  dl.disabled = !(job?.status === "ready" && !job.stale && (critical === 0 || state.confirmCritical));
  dl.innerHTML = `${icon("download")} Baixar .rd`;
  if (!job) setStatus("", "Pronto");
  else if (busy) setStatus("busy", BUSY_LABEL[job.status]?.replace(/…$/, "") || "Processando");
  else if (job.status === "failed") setStatus("error", "Falha");
  else if (job.status === "parts_ready") setStatus("", "Pronto para nestear");
  else setStatus("ok", job.status === "ready" ? (job.stale ? "Desatualizado" : "Arquivo pronto") : "Aguardando parâmetros");
}
function renderHistory() {
  renderHistoryPanel();
  const box = $("history");
  if (!state.jobs.length) { box.innerHTML = `<span class="muted small">Nenhum trabalho ainda.</span>`; return; }
  box.innerHTML = state.jobs.slice(0, 12).map((j) => `<div class="history-item${j.id === state.job?.id ? " current" : ""}" role="button" tabindex="0" data-open="${j.id}">
    ${icon("file")}<span class="name">${esc(j.name)}</span>
    <span class="chip ${j.status === "ready" ? "ok" : j.status === "failed" ? "danger" : ""}">${j.status === "ready" ? fmtTime(j.estimate?.total_s) : j.status === "failed" ? "falhou" : j.status === "ready_for_params" ? "editando" : "processando"}</span>
    <button class="btn sm ghost icon-only" data-delete="${j.id}" title="Excluir">${icon("trash")}</button>
  </div>`).join("");
}
function renderAll() {
  renderProfiles(); renderParts(); renderCanvas(); renderOps(); renderResult(); renderJobBar(); renderSteps(); renderHistory();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function loadJobs() {
  state.jobs = await api("/api/jobs");
}
async function openJob(id) {
  state.job = await api(`/api/jobs/${id}`);
  state.expanded.clear();
  state.selected.clear();
  state.pieces.clear();
  state.layoutDirty = false;
  state.canvasMode = "select";
  state.confirmCritical = false;
  state.showPath = false;
  state.step = state.job.status === "ready" ? 3 : state.job.analysis ? 2 : 1;
  loadMachineForm(state.profiles.find((p) => p.id === state.job.profile_id));
  renderAll();
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const job = state.job;
  if (!job || !BUSY_STATUSES.has(job.status)) return;
  state.pollTimer = setTimeout(async () => {
    if (state.drag) return schedulePoll(); // never swap the SVG under a drag
    try {
      const fresh = await api(`/api/jobs/${job.id}`);
      const wasBusy = job.status;
      // Layout edits not stored yet win over whatever the server has.
      if (state.layoutDirty && state.job?.placements) fresh.placements = state.job.placements;
      state.job = fresh;
      if (fresh.status !== wasBusy) {
        await loadJobs();
        if (fresh.status === "parts_ready" && wasBusy === "analyzing_parts") toast("Peça(s) analisada(s). Ajuste a quantidade e aperte Nestear.");
        if (wasBusy === "relayout") {
          // Preview refreshed after a manual layout edit: stay where the user is.
          if (fresh.status === "failed") toast(`Falha ao atualizar a pré-visualização: ${fresh.error?.message || "erro desconhecido"}`);
        } else {
          if (fresh.status === "ready_for_params") { state.step = 2; state.selected.clear(); state.canvasMode = "select"; toast("Peças posicionadas. Revise as operações — ou use \"Mover peças\" para ajustar o layout."); }
          if (fresh.status === "ready") { state.step = 3; state.showPath = true; toast("Arquivo .rd pronto para download."); }
          if (fresh.status === "failed") toast(`Falha: ${fresh.error?.message || "erro desconhecido"}`);
        }
      }
      renderAll();
    } catch (e) { toast(e.message); }
    schedulePoll();
  }, 800);
}
async function upload(files) {
  const p = profile();
  if (!p) return toast("Escolha um perfil de máquina.");
  const list = Array.from(files);
  if (!list.length) return;
  const form = new FormData();
  for (const f of list) form.append("files", f);
  form.append("profile_id", p.id);
  try {
    setStatus("busy", "Enviando");
    state.job = await api("/api/jobs", { method: "POST", body: form });
    state.expanded.clear(); state.selected.clear(); state.confirmCritical = false; state.showPath = false; state.step = 1;
    await loadJobs();
    renderAll();
    schedulePoll();
  } catch (e) { setStatus("error", "Falha"); toast(e.message); }
}
async function addParts(files) {
  const job = state.job;
  const list = Array.from(files);
  if (!job || !list.length) return;
  const form = new FormData();
  for (const f of list) form.append("files", f);
  try {
    state.job = await api(`/api/jobs/${job.id}/parts`, { method: "POST", body: form });
    state.selected.clear();
    state.step = 1;
    renderAll();
    schedulePoll();
  } catch (e) { toast(`Não foi possível adicionar: ${e.message}`); }
}
async function removePart(partId) {
  const job = state.job;
  if (!job) return;
  const part = job.parts.find((p) => p.id === partId);
  if (job.parts.length <= 1) return toast("O projeto precisa de ao menos uma peça.");
  if (!confirm(`Remover "${part?.name}"?`)) return;
  try {
    state.job = await api(`/api/jobs/${job.id}/parts/${partId}`, { method: "DELETE" });
    state.selected.clear();
    state.step = 1;
    renderAll();
  } catch (e) { toast(`Não foi possível remover: ${e.message}`); }
}
async function patchPart(partId, patch) {
  const job = state.job;
  if (!job) return;
  if (!confirmDiscardLayout(job, "Alterar a peça")) { renderParts(); return; }
  try {
    state.job = await api(`/api/jobs/${job.id}/parts/${partId}`, { method: "PUT", json: patch });
    state.selected.clear();
    state.step = 1;
    renderAll();
  } catch (e) { toast(`Não foi possível atualizar a peça: ${e.message}`); }
}
function hasManualAssignments(job) {
  if (!job?.params || !job?.analysis) return false;
  const auto = job.analysis.assignments || {};
  const cur = job.params.assignments || {};
  const autoOps = new Set((job.analysis.operations || []).map((o) => o.id));
  return job.params.operations.some((o) => !autoOps.has(o.id)) || Object.keys(cur).some((k) => cur[k] !== auto[k]);
}
async function changeJobProfile(profileId, { force = false } = {}) {
  const job = state.job;
  if (!job) return;
  const target = state.profiles.find((p) => p.id === profileId);
  if (!target) return;
  if (!force && profileId === job.profile_id) return;
  if (hasManualAssignments(job) && !confirm(`Trocar para "${target.name}" refaz o nesting e descarta as atribuições de cor feitas à mão. Continuar?`)) {
    renderProfiles();
    return;
  }
  if (!confirmDiscardLayout(job, `Trocar para "${target.name}"`)) { renderProfiles(); return; }
  try {
    state.job = await api(`/api/jobs/${job.id}/profile`, { method: "PUT", json: { profile_id: profileId, force } });
    state.selected.clear();
    state.viewJobId = null;
    state.step = 1;
    loadMachineForm(target);
    renderAll();
    if (state.job.status === "parts_ready") toast(`Máquina: ${target.name}. Aperte "Nestear peças" para posicionar na nova mesa.`);
  } catch (e) { toast(`Não foi possível trocar a máquina: ${e.message}`); renderProfiles(); }
}
function confirmDiscardLayout(job, what) {
  // Re-nesting (or anything that resets the layout) throws away positions,
  // rotations and scales set by hand - say so before doing it.
  if (!hasManualLayout(job)) return true;
  return confirm(`${what} refaz o nesting e descarta as posições, rotações e escalas ajustadas à mão no canvas. Continuar?`);
}
async function runNest() {
  const job = state.job;
  if (!job) return;
  if (!confirmDiscardLayout(job, "Nestear novamente")) return;
  try {
    state.job = await api(`/api/jobs/${job.id}/nest`, { method: "POST" });
    state.selected.clear();
    state.viewJobId = null; // re-fit the view to the new layout when it arrives
    renderAll();
    schedulePoll();
  } catch (e) { toast(`Não foi possível nestear: ${e.message}`); }
}
function saveParams(immediate = false) {
  clearTimeout(state.saveTimer);
  const job = state.job;
  if (!job?.params) return;
  const doSave = async () => {
    if (!paramsValid()) return;
    try {
      const saved = await api(`/api/jobs/${job.id}/params`, { method: "PUT", json: job.params });
      job.stale = saved.stale; job.updated_at = saved.updated_at;
      renderJobBar(); renderResult();
    } catch (e) { toast(`Não foi possível salvar: ${e.message}`); }
  };
  if (immediate) return doSave();
  state.saveTimer = setTimeout(doSave, 500);
}
async function generate() {
  const job = state.job;
  if (!job || !paramsValid()) return;
  try {
    await saveParams(true);
    state.job = await api(`/api/jobs/${job.id}/generate`, { method: "POST" });
    state.confirmCritical = false;
    renderAll(); schedulePoll();
  } catch (e) { toast(e.message); }
}
function updateOp(id, key, raw) {
  const op = state.job.params.operations.find((o) => o.id === id);
  if (!op) return;
  if (["speed_mm_s", "power_pct", "passes", "kerf_mm", "dpi"].includes(key)) {
    const n = raw === "" ? null : Number(raw);
    op[key] = key === "passes" || key === "dpi" ? (n == null ? null : Math.round(n)) : n;
    if (key === "kerf_mm" && op[key] == null) op[key] = 0;
    if (key === "passes" && op[key] == null) op[key] = 1;
  } else if (key === "type") {
    op.type = raw;
    if (raw === "cut" && op.kerf_mm == null) op.kerf_mm = 0;
    if ((raw === "raster" || raw === "image") && op.dpi == null) { op.dpi = 254; op.direction = op.direction || "top_to_bottom"; }
  } else op[key] = raw;
  renderOps(); renderJobBar(); saveParams();
}
function applyPreset(presetId) {
  const preset = state.presets.find((m) => m.id === presetId);
  if (!preset || !state.job?.params) return;
  for (const op of state.job.params.operations) {
    const s = preset.settings[op.type] || preset.settings[op.type === "image" ? "raster" : op.type];
    if (s) Object.assign(op, s);
  }
  state.job.params.material_preset = presetId;
  renderOps(); renderJobBar(); saveParams();
  toast(`Preset "${preset.name}" aplicado a todas as operações.`);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function bind() {
  $("brand-icon").innerHTML = icon("logo", "icon icon-lg");
  $("empty-icon").innerHTML = icon("upload", "icon icon-lg");
  $("theme-toggle").innerHTML = icon("theme");
  $("nav-fit").innerHTML = icon("fit"); $("nav-fit-parts").innerHTML = icon("fitParts"); $("nav-zoom-in").innerHTML = icon("zoomIn"); $("nav-zoom-out").innerHTML = icon("zoomOut");
  $("nav-grid").innerHTML = icon("grid"); $("nav-path").innerHTML = icon("travel"); $("nav-travel").innerHTML = icon("distance");
  $("nav-mode-select").innerHTML = `${icon("pointer")}<span>Selecionar</span>`; $("nav-mode-move").innerHTML = `${icon("move")}<span>Mover peças</span>`;
  $("nav-reset-layout").innerHTML = icon("regenerate");
  $("origin-marker").innerHTML = icon("origin");
  $("opt-chev").innerHTML = icon("chevron", "icon chev");
  $("m-advanced-chev").innerHTML = icon("chevron", "icon chev");
  $("machine-chev").innerHTML = icon("chevron", "icon chev");
  for (const id of ["panel-1-chev", "panel-2-chev", "panel-3-chev", "panel-history-chev"]) $(id).innerHTML = icon("chevron");
  $("history-icon").innerHTML = icon("history");

  $("inspector").addEventListener("click", (e) => {
    const head = e.target.closest("[data-open-step]");
    if (head) {
      const n = Number(head.dataset.openStep);
      if (!stepAvailable(n)) return toast(n === 2 ? "Nesteie as peças primeiro." : "Gere o arquivo primeiro.");
      // Clicking the open panel folds it; clicking another one switches.
      state.panelFolded = state.step === n ? !state.panelFolded : false;
      state.step = n;
      renderSteps();
      // Step 1 is where the layout lives, step 2 is where colors are assigned.
      if (state.job?.analysis && !state.panelFolded) setCanvasMode(n === 1 ? "move" : "select");
      return;
    }
    if (e.target.closest("[data-toggle-history]")) { state.historyOpen = !$("panel-history").classList.contains("open"); renderHistoryPanel(); }
  });

  $("theme-toggle").onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("rd_theme", root.dataset.theme); } catch {}
  };
  try { const t = localStorage.getItem("rd_theme"); if (t) document.documentElement.dataset.theme = t; } catch {}

  $("btn-upload").onclick = () => $("file-input").click();
  $("file-input").onchange = (e) => { if (e.target.files.length) upload(e.target.files); e.target.value = ""; };
  $("btn-add-part").onclick = () => $("file-input-add").click();
  $("file-input-add").onchange = (e) => { if (e.target.files.length) addParts(e.target.files); e.target.value = ""; };
  $("btn-example").onclick = async () => {
    const blob = await (await fetch("exemplo.dxf")).blob();
    upload([new File([blob], "exemplo-3-layers.dxf", { type: "application/dxf" })]);
  };
  const canvas = $("canvas");
  canvas.addEventListener("dragover", (e) => { e.preventDefault(); canvas.classList.add("dragover"); });
  canvas.addEventListener("dragleave", () => canvas.classList.remove("dragover"));
  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    canvas.classList.remove("dragover");
    if (!e.dataTransfer.files.length) return;
    if (state.job) addParts(e.dataTransfer.files);
    else upload(e.dataTransfer.files);
  });
  $("profile-select").onchange = () => {
    const id = $("profile-select").value;
    if (state.job) return changeJobProfile(id);
    loadMachineForm(state.profiles.find((p) => p.id === id));
    renderProfiles();
  };
  $("preset-select").onchange = (e) => { applyPreset(e.target.value); e.target.value = ""; };

  $("m-reference").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) setReferenceMode(btn.dataset.value);
  });
  $("btn-new-machine").onclick = () => {
    $("machine-details").open = true;
    loadMachineForm({ name: "", bed_mm: [900, 600], home_corner: "top-left", job_reference: "anchor", flip_x: false, flip_y: false, swap_xy: false, magic: 136, max_speed_mm_s: 500, min_power_pct: 10 });
    state.editingProfileId = null;
    $("m-name").focus();
  };
  $("btn-save-machine").onclick = async () => {
    const payload = readMachineForm();
    if (!(payload.bed_mm[0] > 0 && payload.bed_mm[1] > 0)) return toast("Informe a largura e a altura da mesa.");
    try {
      await api("/api/machine-profiles", { method: "POST", json: payload });
      state.profiles = await api("/api/machine-profiles");
      state.editingProfileId = payload.id;
      $("profile-select").value = payload.id;
      $("machine-save-status").textContent = `Salvo às ${new Date().toLocaleTimeString("pt-BR")}.`;
      if (state.job && !BUSY_STATUSES.has(state.job.status)) {
        // The open job follows the machine you just saved: a different one
        // switches it, the same one (edited bed, origin...) re-nests it.
        await changeJobProfile(payload.id, { force: payload.id === state.job.profile_id && !!state.job.analysis });
      }
      renderProfiles();
      toast(`Máquina "${payload.name}" salva.`);
    } catch (e) { toast(`Não foi possível salvar: ${e.message}`); }
  };

  $("op-list").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) { const id = toggle.dataset.toggle; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); renderOps(); return; }
    const move = e.target.closest("[data-move]");
    if (move) {
      const ops = [...state.job.params.operations].sort((a, b) => a.order - b.order);
      const i = ops.findIndex((o) => o.id === move.dataset.op);
      const j = move.dataset.move === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= ops.length) return;
      [ops[i], ops[j]] = [ops[j], ops[i]];
      ops.forEach((o, k) => (o.order = k));
      renderOps(); saveParams(); return;
    }
    const en = e.target.closest("[data-enable]");
    if (en) { const op = state.job.params.operations.find((o) => o.id === en.dataset.enable); op.enabled = !op.enabled; renderOps(); renderJobBar(); saveParams(); }
  });
  $("op-list").addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.op && el.dataset.key && el.tagName === "INPUT") {
      const op = state.job.params.operations.find((o) => o.id === el.dataset.op);
      const key = el.dataset.key;
      const raw = el.value;
      if (["speed_mm_s", "power_pct", "passes", "kerf_mm", "dpi"].includes(key)) op[key] = raw === "" ? null : Number(raw);
      else op[key] = raw;
      // Re-render only the summary + validation to keep focus in the field.
      const card = el.closest(".op-card");
      card.querySelector(".op-summary").innerHTML = opSummary(op);
      const errors = validateOp(op);
      const field = el.closest(".field");
      field.classList.toggle("invalid", !!errors[key]);
      const msg = field.querySelector(".error");
      if (errors[key]) { if (msg) msg.textContent = errors[key]; else field.insertAdjacentHTML("beforeend", `<span class="error">${errors[key]}</span>`); }
      else if (msg) msg.remove();
      card.classList.toggle("has-error", Object.keys(errors).length > 0);
      renderJobBar(); saveParams();
    }
  });
  $("op-list").addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.op && el.dataset.key && el.tagName === "SELECT") updateOp(el.dataset.op, el.dataset.key, el.value);
    if (el.dataset.op && el.dataset.key && el.tagName === "INPUT" && el.type === "number") updateOp(el.dataset.op, el.dataset.key, el.value);
  });
  for (const id of ["opt-enabled", "opt-inner", "opt-travel"]) $(id).onchange = () => {
    state.job.params.optimize = { ...(state.job.params.optimize || {}), enabled: $("opt-enabled").checked, inner_first: $("opt-inner").checked, reduce_travel: $("opt-travel").checked };
    renderOps(); saveParams();
  };
  $("btn-generate").onclick = generate;
  $("btn-download").onclick = () => { if (state.job?.artifacts?.rd) window.location.href = state.job.artifacts.rd; };
  $("jobbar-warnings").addEventListener("click", (e) => { if (e.target.closest("#btn-see-warnings")) { state.step = 3; renderSteps(); } });
  $("result-body").addEventListener("click", async (e) => {
    if (e.target.closest("#btn-toggle-path")) { state.showPath = !state.showPath; renderCanvas(); renderResult(); }
    if (e.target.closest("#btn-duplicate")) {
      try { const j = await api(`/api/jobs/${state.job.id}/duplicate`, { method: "POST" }); await loadJobs(); await openJob(j.id); toast("Trabalho duplicado. Ajuste os parâmetros e gere novamente."); } catch (err) { toast(err.message); }
    }
  });
  $("result-body").addEventListener("change", (e) => { if (e.target.id === "confirm-critical") { state.confirmCritical = e.target.checked; renderJobBar(); } });
  $("history").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete]");
    if (del) {
      e.stopPropagation();
      const id = del.dataset.delete;
      const removed = state.jobs.find((j) => j.id === id);
      if (!confirm(`Excluir "${removed?.name}"? Esta ação não pode ser desfeita.`)) return;
      try { await api(`/api/jobs/${id}`, { method: "DELETE" }); if (state.job?.id === id) state.job = null; await loadJobs(); renderAll(); toast("Trabalho excluído."); } catch (err) { toast(err.message); }
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openJob(open.dataset.open);
  });
  $("history").addEventListener("keydown", (e) => {
    const open = e.target.closest("[data-open]");
    if (open && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openJob(open.dataset.open); }
  });
  $("nav-fit").onclick = () => { resetView(); renderCanvas(); };
  $("nav-fit-parts").onclick = () => { renderCanvas(); fitToParts(); };
  $("nav-zoom-in").onclick = () => zoomAt(1.5);
  $("nav-zoom-out").onclick = () => zoomAt(1 / 1.5);
  const viewport = $("canvas-viewport");
  viewport.addEventListener("wheel", (e) => {
    if (!state.job?.analysis) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener("pointerdown", (e) => {
    if (!state.job?.analysis || e.target.closest("button, .canvas-nav, .canvas-badges, .layout-badges, #piece-box")) return;
    const startPan = () => { state.pan = { sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y, moved: false }; };
    // Middle button (or Space held) always pans, whatever the mode.
    if (e.button === 1 || (e.button === 0 && state.spaceHeld)) { e.preventDefault(); return startPan(); }
    if (e.button !== 0) return;
    if (state.canvasMode !== "move" || BUSY_STATUSES.has(state.job.status) && state.job.status !== "relayout") {
      startPan();
      state.pan.onShape = !!shapeIdFromEvent(e);
      return;
    }
    const handle = e.target.closest?.("[data-handle]");
    if (handle && state.pieces.size) {
      e.preventDefault();
      const name = handle.dataset.handle;
      return beginGesture(name === "rot" ? "rotate" : "scale", e, { handle: name });
    }
    const key = pieceKeyFromEvent(e);
    if (key) {
      e.preventDefault();
      if (e.shiftKey) { togglePiece(key); if (!state.pieces.has(key)) return; }
      else if (!state.pieces.has(key)) selectPieces([key]);
      return beginGesture("move", e);
    }
    // Empty bed: rubber-band selection.
    e.preventDefault();
    beginGesture("marquee", e, { startPx: viewportPoint(e) });
  });
  window.addEventListener("pointermove", (e) => {
    const d = state.drag;
    if (d) {
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.clientX, e.clientY - d.clientY) < 3) return;
        d.moved = true;
      }
      updateGesture(e);
      return;
    }
    const pan = state.pan;
    if (!pan) return;
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    viewport.classList.add("panning");
    state.view.x = pan.vx + dx; state.view.y = pan.vy + dy;
    applyView();
  });
  window.addEventListener("pointerup", (e) => {
    if (state.drag) {
      const d = state.drag;
      endGesture(e);
      // A plain click on the empty bed (no drag) clears the piece selection.
      if (d.kind === "marquee" && !d.moved && !e.shiftKey) clearSelection();
      return;
    }
    const pan = state.pan;
    if (!pan) return;
    state.pan = null;
    viewport.classList.remove("panning");
    state.suppressClick = pan.moved;
    if (pan.moved && pan.onShape && state.canvasMode === "select" && !state.job?.status?.match(/^(generating|nesting|analyzing_parts)$/)) {
      toast("Para mover peças na mesa, use o modo \"Mover peças\" (tecla M).", { label: "Ativar", fn: () => setCanvasMode("move") });
    }
    // A plain click on the bed background (not on a shape) clears the selection.
    if (!pan.moved && viewport.contains(e.target) && !shapeIdFromEvent(e) && !e.target.closest("button")) clearSelection();
  });
  $("nav-mode-select").onclick = () => setCanvasMode("select");
  $("nav-mode-move").onclick = () => setCanvasMode("move");
  $("nav-reset-layout").onclick = resetLayout;
  $("piece-box").addEventListener("click", (e) => {
    if (e.target.closest("#pb-apply-move")) return applyMoveBox();
    if (e.target.closest("#pb-reset")) return resetSelectionLayout();
  });
  $("piece-box").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.target.id === "pb-dx" || e.target.id === "pb-dy") applyMoveBox();
    else e.target.blur();
  });
  $("piece-box").addEventListener("change", (e) => {
    if (e.target.id === "pb-rot") {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      rotateSelection(v, { absolute: state.pieces.size === 1 });
    }
    if (e.target.id === "pb-scale") {
      const v = Number(e.target.value) / 100;
      if (!Number.isFinite(v) || v <= 0) return;
      scaleSelection(v, { absolute: state.pieces.size === 1 });
    }
  });
  function applyMoveBox() {
    const dx = Number($("pb-dx").value) || 0, dy = Number($("pb-dy").value) || 0;
    if (!dx && !dy) return;
    nudgeSelection(dx, dy);
    $("pb-dx").value = ""; $("pb-dy").value = "";
    $("pb-dx").focus();
  }
  $("nav-grid").onclick = () => { state.showGrid = !state.showGrid; renderCanvas(); };
  $("nav-path").onclick = () => { state.showPath = !state.showPath; renderCanvas(); renderResult(); };
  $("nav-travel").onclick = () => { state.showTravel = !state.showTravel; renderCanvas(); };
  window.addEventListener("resize", () => renderCanvas());

  $("parts-list").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove-part]");
    if (remove) return removePart(remove.dataset.removePart);
    const toggle = e.target.closest("[data-toggle-part]");
    if (toggle) {
      const part = state.job.parts.find((p) => p.id === toggle.dataset.togglePart);
      return patchPart(toggle.dataset.togglePart, { enabled: !part.enabled });
    }
    const step = e.target.closest("[data-qty-step]");
    if (step) {
      const part = state.job.parts.find((p) => p.id === step.dataset.part);
      const qty = Math.max(1, Math.min(500, part.quantity + Number(step.dataset.qtyStep)));
      return patchPart(step.dataset.part, { quantity: qty });
    }
  });
  $("parts-list").addEventListener("change", (e) => {
    const qtyInput = e.target.closest("[data-qty-input]");
    if (qtyInput) {
      const qty = Math.max(1, Math.min(500, Number(qtyInput.value) || 1));
      return patchPart(qtyInput.dataset.qtyInput, { quantity: qty });
    }
    const rotatable = e.target.closest("[data-rotatable]");
    if (rotatable) return patchPart(rotatable.dataset.rotatable, { rotatable: rotatable.checked });
  });
  $("btn-nest").onclick = runNest;

  $("color-bar-swatches").addEventListener("click", (e) => {
    const swatch = e.target.closest(".swatch-btn");
    if (!swatch) return;
    if (state.selected.size > 0) return assignSelectionTo({ opId: swatch.dataset.op, color: swatch.dataset.color });
    if (swatch.dataset.op) return selectOperationElements(swatch.dataset.op);
    toast("Clique primeiro nas formas do desenho que quer mover para essa cor.");
  });
  $("btn-select-all").onclick = selectAll;
  $("btn-clear-selection").onclick = clearSelection;
  $("layer-preview").addEventListener("click", (e) => {
    if (state.suppressClick) { state.suppressClick = false; return; }
    if (state.canvasMode === "move") return; // pieces are picked on pointerdown
    const id = shapeIdFromEvent(e);
    if (!id || !selectableIds().includes(id)) return;
    if (!e.shiftKey) state.selected.clear();
    if (state.selected.has(id) && e.shiftKey) state.selected.delete(id);
    else state.selected.add(id);
    styleShapeElements();
    renderColorBar();
  });
  $("layer-preview").addEventListener("pointerover", (e) => setHover(shapeIdFromEvent(e), true));
  $("layer-preview").addEventListener("pointerout", (e) => setHover(shapeIdFromEvent(e), false));
  document.addEventListener("keydown", (e) => {
    const typing = !!e.target.closest("input, textarea, select");
    if (e.key === "Escape") { if (typing) e.target.blur(); else clearSelection(); }
    if (typing || !state.job?.analysis) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (state.canvasMode === "move") selectPieces(allInstanceKeys()); else selectAll();
      return;
    }
    if (e.key === " " && !e.repeat) { state.spaceHeld = true; e.preventDefault(); return; }
    if (e.key.toLowerCase() === "v" && !e.ctrlKey && !e.metaKey) return setCanvasMode("select");
    if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey) return setCanvasMode("move");
    if (state.canvasMode === "move" && state.pieces.size && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      nudgeSelection(dx, dy);
    }
  });
  document.addEventListener("keyup", (e) => { if (e.key === " ") state.spaceHeld = false; });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  bind();
  try {
    [state.profiles, state.presets] = await Promise.all([api("/api/machine-profiles"), api("/api/material-presets")]);
    await loadJobs();
  } catch (e) { toast(`Não foi possível conectar ao serviço: ${e.message}`); }
  loadMachineForm(state.profiles[0]);
  renderAll();
  const last = state.jobs[0];
  if (last && new URLSearchParams(location.search).get("job")) openJob(new URLSearchParams(location.search).get("job"));
}
boot();
