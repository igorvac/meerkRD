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
  showPath: false,
  showTravel: true,
  showGrid: true,
  confirmCritical: false,
  saveTimer: null,
  pollTimer: null,
};

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
  return state.profiles.find((p) => p.id === ($("profile-select").value || state.job?.profile_id)) || state.profiles[0];
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
function renderSteps() {
  const job = state.job;
  const hasAnalysis = !!job?.analysis;
  const hasResult = job?.status === "ready";
  for (const n of [1, 2, 3]) {
    const el = $(`step-${n}`);
    el.classList.toggle("active", state.step === n);
    el.classList.toggle("done", (n === 1 && hasAnalysis) || (n === 2 && hasResult));
    el.disabled = (n === 2 && !hasAnalysis) || (n === 3 && !hasResult);
  }
  $("sec-ops").hidden = !hasAnalysis;
  $("sec-result").hidden = !hasResult;
  if (state.step === 3 && hasResult) $("sec-result").scrollIntoView({ block: "start", behavior: "smooth" });
  if (state.step === 2 && hasAnalysis) $("sec-ops").scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderProfiles() {
  const sel = $("profile-select");
  const current = state.job?.profile_id || sel.value || state.profiles[0]?.id;
  sel.innerHTML = state.profiles.map((p) => `<option value="${esc(p.id)}"${p.id === current ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  sel.disabled = !!state.job;
  const p = profile();
  $("profile-hint").textContent = p ? `Mesa ${p.bed_mm[0]} × ${p.bed_mm[1]} mm · origem ${p.home_corner} · máx. ${p.max_speed_mm_s ?? "—"} mm/s${state.job ? " · para trocar de máquina, crie um novo trabalho" : ""}` : "";
  const presetSel = $("preset-select");
  presetSel.innerHTML = `<option value="">Aplicar preset de material…</option>` + state.presets.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
}

function renderFile() {
  const job = state.job;
  const box = $("file-summary");
  $("btn-change-file").hidden = !job;
  if (!job) { box.innerHTML = `<span class="muted">Nenhum arquivo enviado.</span>`; return; }
  const a = job.analysis;
  const chips = [];
  if (a) {
    chips.push(`<span class="chip">${a.elements.length} elemento(s)</span>`);
    if (a.bbox_mm) chips.push(`<span class="chip">${Math.round(a.bbox_mm[2] - a.bbox_mm[0])} × ${Math.round(a.bbox_mm[3] - a.bbox_mm[1])} mm</span>`);
    chips.push(a.outside_bed ? `<span class="chip danger">${icon("critical")} fora da mesa</span>` : `<span class="chip ok">${icon("ok")} cabe na mesa</span>`);
  } else if (job.status === "analyzing") chips.push(`<span class="chip info">analisando…</span>`);
  else if (job.status === "failed") chips.push(`<span class="chip danger">falhou</span>`);
  box.innerHTML = `<div style="display:flex;align-items:center;gap:8px">${icon("file")}<strong style="overflow:hidden;text-overflow:ellipsis">${esc(job.name)}</strong></div><div class="op-summary" style="margin-top:6px">${chips.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Rendering: canvas
// ---------------------------------------------------------------------------
function renderCanvas() {
  const job = state.job;
  const wrap = $("bed-wrap");
  const p = profile();
  const bed = job?.analysis?.bed_mm || p?.bed_mm || [900, 600];
  $("empty-state").hidden = !!job?.analysis;
  wrap.hidden = !job?.analysis;
  $("canvas-nav").hidden = !job?.analysis;
  if (!job?.analysis) { $("canvas-badges").innerHTML = ""; return; }
  fitBed(bed);
  $("bed-label").textContent = `${bed[0]} × ${bed[1]} mm — ${p?.name || ""}`;
  const previewUrl = job.artifacts?.preview_svg;
  if (previewUrl && $("layer-preview").dataset.src !== previewUrl + job.updated_at) {
    $("layer-preview").dataset.src = previewUrl + job.updated_at;
    fetch(previewUrl).then((r) => r.text()).then((svg) => { $("layer-preview").innerHTML = svg; normalizeSvg($("layer-preview").querySelector("svg")); });
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
  if (job.analysis.outside_bed) badges.push(`<span class="chip danger">${icon("critical")} Geometria fora da mesa</span>`);
  if (job.status === "ready" && state.showPath) badges.push(`<span class="chip info">${icon("travel")} Percurso: cores por operação, tracejado = deslocamento</span>`);
  $("canvas-badges").innerHTML = badges.join("");
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
  const canvas = $("canvas");
  const pad = 48;
  const w = canvas.clientWidth - pad * 2, h = canvas.clientHeight - pad * 2 - 40;
  const scale = Math.min(w / bed[0], h / bed[1]);
  const wrap = $("bed-wrap");
  wrap.style.width = `${Math.max(100, bed[0] * scale)}px`;
  wrap.style.height = `${Math.max(60, bed[1] * scale)}px`;
  const minor = 10 * scale, major = 100 * scale;
  $("bed-grid").style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`;
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
  return "seleção";
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
  const analysisOps = Object.fromEntries((job.analysis?.operations || []).map((o) => [o.id, o]));
  list.innerHTML = ops.map((op, index) => {
    const errors = validateOp(op);
    const open = state.expanded.has(op.id);
    const info = analysisOps[op.id];
    const count = info?.elements ?? "?";
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
function renderJobBar() {
  const job = state.job;
  const busy = job && (job.status === "analyzing" || job.status === "generating");
  const warns = warningsList(job);
  const critical = warns.filter((w) => w.severity === "critical").length;
  const wbox = $("jobbar-warnings");
  if (!job) wbox.innerHTML = `<span class="muted">Envie um arquivo para começar.</span>`;
  else if (job.status === "failed") wbox.innerHTML = `<span class="chip danger">${icon("critical")} ${esc(job.error?.message || "Falha no processamento")}</span>`;
  else if (busy) wbox.innerHTML = `<span class="chip info">${job.status === "analyzing" ? "Analisando o arquivo…" : "Gerando o arquivo da máquina…"}</span>`;
  else if (warns.length) wbox.innerHTML = `<span class="chip ${critical ? "danger" : "warn"}">${icon(critical ? "critical" : "warning")} ${warns.length} aviso(s)${critical ? ` · ${critical} crítico(s)` : ""}</span><button class="btn sm ghost" id="btn-see-warnings">Ver</button>`;
  else if (job.status === "ready") wbox.innerHTML = `<span class="chip ok">${icon("ok")} Sem avisos</span>`;
  else wbox.innerHTML = `<span class="muted">Ajuste as operações e gere o arquivo.</span>`;
  const est = $("jobbar-estimate");
  est.hidden = !(job?.estimate && job.status === "ready");
  $("estimate-value").textContent = fmtTime(job?.estimate?.total_s);
  $("estimate-value").style.opacity = job?.stale ? "0.4" : "1";
  const gen = $("btn-generate");
  gen.disabled = !job?.analysis || busy || !paramsValid();
  gen.innerHTML = job?.status === "ready" ? `${icon("regenerate")} ${job.stale ? "Gerar novamente" : "Gerar novamente"}` : `${icon("play")} Gerar arquivo`;
  const dl = $("btn-download");
  dl.disabled = !(job?.status === "ready" && !job.stale && (critical === 0 || state.confirmCritical));
  dl.innerHTML = `${icon("download")} Baixar .rd`;
  if (!job) setStatus("", "Pronto");
  else if (busy) setStatus("busy", job.status === "analyzing" ? "Analisando" : "Gerando");
  else if (job.status === "failed") setStatus("error", "Falha");
  else setStatus("ok", job.status === "ready" ? (job.stale ? "Desatualizado" : "Arquivo pronto") : "Aguardando parâmetros");
}
function renderHistory() {
  const box = $("history");
  if (!state.jobs.length) { box.innerHTML = `<span class="muted small">Nenhum trabalho ainda.</span>`; return; }
  box.innerHTML = state.jobs.slice(0, 12).map((j) => `<div class="history-item${j.id === state.job?.id ? " current" : ""}" role="button" tabindex="0" data-open="${j.id}">
    ${icon("file")}<span class="name">${esc(j.name)}</span>
    <span class="chip ${j.status === "ready" ? "ok" : j.status === "failed" ? "danger" : ""}">${j.status === "ready" ? fmtTime(j.estimate?.total_s) : j.status === "failed" ? "falhou" : j.status === "ready_for_params" ? "editando" : "processando"}</span>
    <button class="btn sm ghost icon-only" data-delete="${j.id}" title="Excluir">${icon("trash")}</button>
  </div>`).join("");
}
function renderAll() {
  renderProfiles(); renderFile(); renderCanvas(); renderOps(); renderResult(); renderJobBar(); renderSteps(); renderHistory();
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
  state.confirmCritical = false;
  state.showPath = false;
  state.step = state.job.status === "ready" ? 3 : state.job.analysis ? 2 : 1;
  renderAll();
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const job = state.job;
  if (!job || !(job.status === "analyzing" || job.status === "generating")) return;
  state.pollTimer = setTimeout(async () => {
    try {
      const fresh = await api(`/api/jobs/${job.id}`);
      const wasBusy = job.status;
      state.job = fresh;
      if (fresh.status !== wasBusy) {
        await loadJobs();
        if (fresh.status === "ready_for_params") { state.step = 2; toast("Arquivo analisado. Revise as operações."); }
        if (fresh.status === "ready") { state.step = 3; state.showPath = true; toast("Arquivo .rd pronto para download."); }
        if (fresh.status === "failed") toast(`Falha: ${fresh.error?.message || "erro desconhecido"}`);
      }
      renderAll();
    } catch (e) { toast(e.message); }
    schedulePoll();
  }, 800);
}
async function upload(file) {
  const p = profile();
  if (!p) return toast("Escolha um perfil de máquina.");
  const form = new FormData();
  form.append("file", file);
  form.append("profile_id", p.id);
  try {
    setStatus("busy", "Enviando");
    state.job = await api("/api/jobs", { method: "POST", body: form });
    state.expanded.clear(); state.confirmCritical = false; state.showPath = false; state.step = 1;
    await loadJobs();
    renderAll();
    schedulePoll();
  } catch (e) { setStatus("error", "Falha"); toast(e.message); }
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
  $("nav-fit").innerHTML = icon("fit"); $("nav-grid").innerHTML = icon("grid"); $("nav-path").innerHTML = icon("travel"); $("nav-travel").innerHTML = icon("distance");
  $("origin-marker").innerHTML = icon("origin");
  $("opt-chev").innerHTML = icon("chevron", "icon chev");

  $("theme-toggle").onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("rd_theme", root.dataset.theme); } catch {}
  };
  try { const t = localStorage.getItem("rd_theme"); if (t) document.documentElement.dataset.theme = t; } catch {}

  for (const n of [1, 2, 3]) $(`step-${n}`).onclick = () => { state.step = n; renderSteps(); };
  $("btn-upload").onclick = () => $("file-input").click();
  $("btn-change-file").onclick = () => { state.job = null; renderAll(); };
  $("file-input").onchange = (e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; };
  $("btn-example").onclick = async () => {
    const blob = await (await fetch("exemplo.dxf")).blob();
    upload(new File([blob], "exemplo-3-layers.dxf", { type: "application/dxf" }));
  };
  const canvas = $("canvas");
  canvas.addEventListener("dragover", (e) => { e.preventDefault(); canvas.classList.add("dragover"); });
  canvas.addEventListener("dragleave", () => canvas.classList.remove("dragover"));
  canvas.addEventListener("drop", (e) => { e.preventDefault(); canvas.classList.remove("dragover"); const f = e.dataTransfer.files[0]; if (f) upload(f); });
  $("profile-select").onchange = () => renderProfiles();
  $("preset-select").onchange = (e) => { applyPreset(e.target.value); e.target.value = ""; };

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
  $("nav-fit").onclick = () => renderCanvas();
  $("nav-grid").onclick = () => { state.showGrid = !state.showGrid; renderCanvas(); };
  $("nav-path").onclick = () => { state.showPath = !state.showPath; renderCanvas(); renderResult(); };
  $("nav-travel").onclick = () => { state.showTravel = !state.showTravel; renderCanvas(); };
  window.addEventListener("resize", () => renderCanvas());
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
  renderAll();
  const last = state.jobs[0];
  if (last && new URLSearchParams(location.search).get("job")) openJob(new URLSearchParams(location.search).get("job"));
}
boot();
