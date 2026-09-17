# Plano: MeerK40t como serviço web de geração de arquivos `.rd`

**Branch:** `main` (antiga `ux-review`)
**Base validada:** 0.9.9040 (src) headless (`-z -Z -X -p -b`), DXF → `.rd` em ~1 s, com a
correção do `save_job` Ruida em `meerk40t/ruida/device.py` (ver [UX_UI_REVIEW_PLAN.md](UX_UI_REVIEW_PLAN.md) §8 e
histórico da branch).
**Documento irmão:** [UX_UI_REVIEW_PLAN.md](UX_UI_REVIEW_PLAN.md) — a interface web abaixo herda os
workspaces, tokens e glossário definidos lá.

---

## 1. Objetivo e escopo

**Objetivo.** Um usuário abre uma aplicação web, envia um DXF (ou SVG), ajusta potência,
velocidade, passes e estratégia por operação, e recebe um arquivo `.rd` pronto para o
pendrive/painel da máquina Ruida. Nenhuma conexão física com a laser é necessária.

**Dentro do escopo**
- Upload de DXF/SVG (formatos que o MeerK40t já carrega: dxf, svg, lbrn/lbrn2, xcs, ezd, png/jpg…).
- Detecção de operações por layer/cor, edição de parâmetros por operação, presets de material.
- Perfis de máquina (tamanho da mesa, canto de origem, magic, flips) — obrigatórios mesmo sem conexão, pois entram no `.rd`.
- Preview do desenho, preview do percurso e estimativa de tempo antes do download.
- Geração isolada por job (um processo MeerK40t por job), download, histórico.

**Fora do escopo (v1)**
- Edição geométrica no browser (mover/escalar/desenhar) — o usuário desenha no CAD dele.
- Streaming para a máquina, câmera, jog.
- Multiusuário com contas/permissões (v1 usa token simples).
- Outros controladores como saída — mas a arquitetura já permite (`save_job` existe para GRBL/gcode, Lihuiyu/egv, Newly, Balor); fica como *bônus* no Sprint 7.

**Premissas**
- MeerK40t roda como **dependência headless** (`requirements-nogui.txt` + `ezdxf`), invocado por subprocess. O servidor web **não** importa o kernel no seu próprio processo (contenção de crash).
- O código do serviço vive em `service/` nesta branch durante o spike; após o Sprint 2 avaliar separar em repositório próprio dependendo de `meerk40t` via pip com a correção do `save_job` upstreamed.

---

## 2. Arquitetura

```
┌───────────────┐   HTTPS/JSON    ┌───────────────┐   fila    ┌──────────────────────────┐
│  Web (SPA)    │ ──────────────▶ │  API (FastAPI)│ ────────▶ │  Worker                  │
│  upload,      │ ◀────────────── │  jobs, files, │ ◀──────── │  1 subprocess por job:   │
│  parâmetros,  │  status/preview │  profiles     │  status   │  meerk40t -z -Z -X -p -b │
│  download     │                 └──────┬────────┘           │  + timeout + tmpdir      │
└───────────────┘                        │                    └────────────┬─────────────┘
                                         ▼                                 ▼
                                  ┌──────────────┐               ┌──────────────────┐
                                  │ SQLite/Postg.│               │ Storage (FS/S3)  │
                                  │ jobs, perfis │               │ input, .rd, svg, │
                                  └──────────────┘               │ stats.json, logs │
                                                                 └──────────────────┘
```

**Ciclo de um job**

1. `POST /jobs` (multipart: arquivo + `machine_profile_id`) → API salva o input, enfileira `analyze`.
2. Worker **analisa**: carrega o arquivo no MeerK40t, exporta `preview.svg` (`save`), lista operações detectadas (`operations`) e limites (bbox vs. mesa). Devolve `analysis.json`.
3. Front mostra preview + formulário por operação; usuário edita e envia `PUT /jobs/{id}/params` (JSON do §3).
4. `POST /jobs/{id}/generate` → worker traduz JSON em **batch de console**, roda o MeerK40t, produz `job.rd`, `path.svg` (percurso) e `stats.json` (tempo/distância por operação via `CutCode.provide_statistics()`).
5. Front mostra estimativa e avisos; `GET /jobs/{id}/file` baixa o `.rd`.

**Por que subprocess e não import:** o kernel encerra o processo em exceções não tratadas (visto na análise de UX), tem estado global (settings, device ativo) e não é reentrante. Um processo por job dá isolamento, timeout e paralelismo trivial. Custo: ~1 s de boot por job — aceitável.

---

## 3. Contratos

### 3.1 Entrada — `PUT /jobs/{id}/params`

```json
{
  "machine_profile": "ruida-900x600",
  "units": "mm",
  "placement": { "mode": "keep" },
  "optimize": { "enabled": true, "inner_first": true, "reduce_travel": true },
  "operations": [
    {
      "id": "op_1",
      "source": { "layer": "CUT" },
      "type": "cut",
      "enabled": true,
      "order": 2,
      "speed_mm_s": 12,
      "power_pct": 65,
      "passes": 2,
      "kerf_mm": 0.1
    },
    {
      "id": "op_2",
      "source": { "layer": "ENGRAVE" },
      "type": "engrave",
      "order": 1,
      "speed_mm_s": 200,
      "power_pct": 20,
      "passes": 1
    },
    {
      "id": "op_3",
      "source": { "layer": "LOGO" },
      "type": "raster",
      "order": 0,
      "speed_mm_s": 300,
      "power_pct": 25,
      "dpi": 254,
      "direction": "top_to_bottom"
    }
  ],
  "material_preset": "mdf-3mm"
}
```

Regras: `source` é `{ "layer": ... }` (DXF/SVG com layers) ou `{ "color": "#ff0000" }`;
`power_pct` 0–100 (mapeado para 0–1000 internamente); `type` ∈ `cut | engrave | raster | image`.

### 3.2 Saída — `GET /jobs/{id}`

```json
{
  "id": "j_01H…",
  "status": "ready",
  "input": { "name": "peca.dxf", "bbox_mm": [0, 0, 80, 50] },
  "machine_profile": "ruida-900x600",
  "warnings": [
    { "code": "outside_bed", "severity": "critical", "elements": 0 },
    { "code": "unassigned_elements", "severity": "normal", "count": 1 }
  ],
  "estimate": { "total_s": 671, "cut_s": 556, "travel_s": 2, "by_operation": { "op_1": 400, "op_2": 156, "op_3": 115 } },
  "artifacts": {
    "rd": "/jobs/j_01H…/file",
    "preview_svg": "/jobs/j_01H…/preview.svg",
    "path_svg": "/jobs/j_01H…/path.svg",
    "stats": "/jobs/j_01H…/stats.json"
  }
}
```

### 3.3 Perfil de máquina — `machine_profiles`

```json
{ "id": "ruida-900x600", "name": "CO2 90x60 (Ruida RDC6442)", "driver": "ruida-beta",
  "bed_mm": [900, 600], "home_corner": "top-left", "flip_x": false, "flip_y": false,
  "swap_xy": false, "magic": 136, "max_speed_mm_s": 500, "min_power_pct": 10 }
```

Mapeia 1:1 para os atributos do device (`bedwidth`, `bedheight`, `home_corner`,
`flip_x`, `flip_y`, `swap_xy`, `magic`) aplicados via `set` antes do `load`.

### 3.4 Tradução JSON → batch de console (núcleo do worker)

```
device add ruida-beta
set bedwidth 900mm
set bedheight 600mm
set home_corner top-left
set magic 136
load "input.dxf"
# operações: apagar as criadas pelo loader e recriar na ordem do JSON
operation* delete
op raster --label op_3 ... / engrave --label op_2 ... / cut --label op_1 ...
element* filter "label == 'CUT'" ... assign → op_1      (por layer)
operation op_1 speed 12 power 650 passes 2
plan0 clear copy preprocess validate blob preopt optimize
plan0 save_job "job.rd"
save "path.svg"           # opcional: percurso via cutcode → svg (Sprint 5)
quit
```

Os comandos exatos de criação/atribuição serão fixados no Sprint 0 (há mais de um
caminho: `element* classify` com cores, `elements filter`, ou `op cut`/`engrave` com
referência explícita). A regra é **não depender de `classify` automático** para DXF —
mapear por nome de layer é determinístico.

---

## 4. Sprints (uma feature entregável por sprint)

Duração alvo: 1 semana por sprint (1 dev), exceto onde indicado. Cada sprint termina com
demo e critérios de aceite verificáveis.

### Sprint 0 — Núcleo de conversão headless (CLI) · 1 semana

**Feature:** `rdconvert` — dado `input.dxf` + `params.json` + `profile.json`, produz `job.rd` + `stats.json` de forma determinística e testável, sem rede.

Tarefas
- Commitar e testar a correção do `save_job` Ruida (`meerk40t/ruida/device.py`); abrir PR upstream.
- `service/core/batch.py`: tradutor JSON → batch (§3.4); fixar comandos de criação de operações e atribuição por layer/cor; ordenar operações.
- `service/core/runner.py`: executa `python -m meerk40t -z -Z -X -p -b batch.txt` em `tmpdir` isolado, com `timeout`, captura de log, código de saída e validação do `.rd` (tamanho > cabeçalho, magic detectado, `D7` no fim).
- `service/core/stats.py`: gerar `stats.json` a partir de `CutCode.provide_statistics()` (comando de console novo `plan0 statistics <file>` no MeerK40t, ~40 linhas) — tempo total/corte/deslocamento e por operação.
- Validação de parâmetros contra o perfil (velocidade máxima, potência mínima) e avisos (`gui_mixins.Warnings` tem a lógica; extrair a parte não-GUI para `core/warnings.py` ou reimplementar as 4 regras críticas no serviço).
- Testes: fixture DXF (3 layers) → `.rd` round-trip com `RDLoader`; decode com `parse_commands` e asserts de `C9`/`C6` (velocidade/potência) por layer; regressão do tamanho.

Aceite
- `rdconvert peca.dxf params.json profile.json` gera `job.rd` válido em < 3 s; alterar `speed_mm_s` muda o `C9 02` da camada correspondente; teste automatizado verde.

Riscos: semântica do `magic` e do `home_corner` em máquinas reais — marcar para validação em hardware no Sprint 7.

### Sprint 1 — API REST de jobs · 1 semana

**Feature:** criar job, enviar arquivo, consultar status, baixar `.rd`.

Tarefas
- FastAPI em `service/api/`: `POST /jobs`, `GET /jobs/{id}`, `PUT /jobs/{id}/params`, `POST /jobs/{id}/generate`, `GET /jobs/{id}/file`, `GET /machine-profiles`.
- Modelo `Job` (SQLite via SQLModel): `id, status (uploaded|analyzing|ready_for_params|generating|ready|failed), created_at, profile_id, params_json, error`.
- Storage local `data/jobs/{id}/` (input, batch, log, artefatos); limite de tamanho (ex.: 25 MB) e whitelist de extensões.
- Execução síncrona no Sprint 1 (BackgroundTasks do FastAPI) — a fila real vem no Sprint 2.
- Token de API simples (`X-API-Key`) desde o início; CORS para o front.
- Dockerfile: `python:3.12-slim` + `requirements-nogui.txt` + `ezdxf` + `service/`.

Aceite
- `curl` completo: upload → params → generate → download; OpenAPI publicada em `/docs`; container sobe com `docker compose up`.

### Sprint 2 — Worker, fila e isolamento · 1 semana

**Feature:** jobs concorrentes, resilientes a crash e com limpeza.

Tarefas
- Fila (RQ + Redis, ou `arq`); `N` workers configuráveis; um subprocess por job com `timeout` (padrão 120 s) e `nice`.
- Retentativa 1× em falha transitória; classificação de erro (arquivo inválido × timeout × crash do MeerK40t) e mensagem para o usuário.
- Limpeza: TTL de artefatos (ex.: 7 dias), limite de disco, remoção de `tmpdir`.
- Logs estruturados por job (`job.log` + JSON no stdout do worker); métricas básicas (jobs/min, p95 de duração, falhas).
- Etapa `analyze` separada da `generate` (o front precisa das operações detectadas antes de o usuário editar).

Aceite
- 20 jobs simultâneos com 4 workers concluem; um job com DXF corrompido falha isolado sem afetar os outros; crash simulado do MeerK40t (ex.: comando inválido) vira `failed` com mensagem legível.

### Sprint 3 — Frontend: upload e preview · 1 semana

**Feature:** o usuário envia o arquivo e vê o desenho sobre a mesa da máquina escolhida.

Tarefas
- SPA (Vite + Svelte ou React; TypeScript) em `service/web/`, com os **tokens de design** do plano de UX (`themes` → CSS variables) e a iconografia que será produzida manualmente (lista no §6).
- Tela 1 (*Preparar*): seletor de perfil de máquina, drop-zone de arquivo, barra de progresso de análise.
- Preview: renderizar `preview.svg` (gerado pelo worker — evita parser de DXF no browser) sobre um retângulo da mesa com régua em mm; zoom/pan; badge de aviso "fora da mesa".
- Estados vazios/erro conforme o glossário do plano de UX (nada de "classify", "blob", "spooler").

Aceite
- DXF de teste aparece na posição correta em mesa 900×600; arquivo maior que a mesa mostra aviso crítico; funciona em tablet (≥ 768 px).

### Sprint 4 — Frontend: editor de operações e presets · 1,5 semana

**Feature:** editar parâmetros por operação e salvar presets de material.

Tarefas
- Lista de operações detectadas (layer/cor → tipo sugerido) com **chips legíveis** (`Cut · 12 mm/s · 65 % · 2 passes`), reordenação por arrastar, ligar/desligar.
- Formulário por operação (padrão "estágios" do plano de UX): *Tipo* → *Parâmetros* (velocidade, potência %, passes) → *Geometria* (kerf, direção/dpi para raster) → *Avançado*. Validação inline contra o perfil (velocidade máxima, potência mínima) com mensagens claras.
- Presets de material (`GET/POST /material-presets`): aplicar a todas as operações do tipo, salvar a partir do formulário atual; seed com 5–8 materiais comuns (MDF 3 mm, acrílico 3 mm, compensado 6 mm…).
- Persistência do rascunho no job (`PUT /jobs/{id}/params` com debounce).

Aceite
- Usuário sem ler documentação atribui layer → tipo, ajusta velocidade/potência e gera um `.rd` cujos `C9`/`C6` refletem os valores (teste E2E com Playwright decodificando o arquivo).

### Sprint 5 — Estimativa e preview de percurso · 1 semana

**Feature:** antes de baixar, ver tempo estimado, ordem de corte e deslocamentos.

Tarefas
- Worker exporta `path.svg` do cutcode (corte em cor da operação, deslocamento tracejado) e `stats.json` por operação (Sprint 0 já produz os números; aqui entra o desenho).
- Front: painel *Resultado* com tempo total/corte/deslocamento, tabela por operação, toggle "mostrar deslocamentos", scrubber simples opcional (anima a ordem das operações).
- Avisos do MeerK40t (fora da mesa, não atribuído, velocidade excessiva, DPI) como banner + badge na operação; aviso crítico exige confirmação para baixar.
- Botão "Regerar" quando parâmetros mudam após a geração (estado `stale`).

Aceite
- Alterar passes de 1 → 2 dobra o tempo estimado da operação; elemento fora da mesa bloqueia o download até confirmação.

### Sprint 6 — Download, histórico e compartilhamento · 0,5–1 semana

**Feature:** o usuário recupera jobs anteriores e reutiliza parâmetros.

Tarefas
- Lista de jobs (nome, máquina, data, tempo estimado, status) com re-download e "duplicar com novos parâmetros".
- Nome do `.rd` derivado do arquivo + perfil (`peca_ruida-900x600.rd`); metadados no cabeçalho do job quando o formato permitir.
- Link compartilhável somente-leitura de um job (token) — útil para o operador da máquina receber do projetista.
- Exportar/importar `params.json` (para automação e suporte).

Aceite
- Job de ontem reaparece após restart do serviço; duplicar preserva parâmetros e gera novo `.rd`.

### Sprint 7 — Hardening, validação em hardware e deploy · 1,5 semana

**Feature:** pronto para uso real.

Tarefas
- **Validação em máquina Ruida real**: 3 jobs (vetor, raster, misto) — conferir origem/canto, espelhamento, kerf, velocidades de deslocamento; ajustar perfil padrão. *Bloqueante para "produção".*
- Segurança: limites de taxa, tamanho, tipos; sanitização de nomes de arquivo (nunca interpolar nomes do usuário no batch sem escapar); execução do worker sem privilégios; secrets via env.
- Observabilidade: healthcheck, métricas Prometheus, alerta de fila parada.
- Deploy: `docker compose` (api + worker + redis + web) e guia para VPS/Raspberry Pi; backups do SQLite/`data/`.
- Documentação de usuário (3 páginas) e de operação; CI com testes do Sprint 0 + E2E do Sprint 4.
- *Bônus:* seletor de saída `gcode`/`egv` reutilizando os `save_job` dos outros drivers (mudança: `driver` no perfil).

Aceite
- Checklist de deploy concluído; 3 arquivos cortados fisicamente com resultado correto; suíte CI verde.

**Total: ~9 semanas** (1 dev). Com um segundo dev no front a partir do Sprint 3, ~6 semanas.

---

## 5. Decisões técnicas e alternativas

| Decisão | Escolha | Alternativa descartada e porquê |
|---|---|---|
| Integração com MeerK40t | subprocess por job (`-z -Z -X -p -b`) | importar kernel no worker: crash derruba o worker, estado global, não reentrante |
| Backend | FastAPI + SQLModel (Python, mesma stack do MeerK40t) | Node: duplicaria conhecimento e complicaria testes que usam o kernel |
| Fila | RQ/Redis (Sprint 2); `BackgroundTasks` no Sprint 1 | Celery: peso desnecessário para o volume esperado |
| Preview do desenho | SVG gerado pelo worker (`save preview.svg`) | parser DXF no browser: duplica a lógica de importação e diverge do que será cortado |
| Preview do percurso | SVG do cutcode gerado no worker | WebGL no browser: só se o volume de linhas exigir |
| Front | Vite + TypeScript (Svelte ou React) com CSS variables dos tokens | wxPython/servidor renderizando HTML: sem interatividade suficiente |
| Autenticação v1 | API key + links com token | OAuth: fora do escopo até haver multiusuário |

---

## 6. Assets visuais a produzir manualmente (iconografia)

Formato: SVG `viewBox="0 0 24 24"`, `currentColor`, stroke 1,75 px, paths apenas
(ver tokens no plano de UX). Os mesmos ícones servem depois à GUI wx (`VectorIcon`).

| Grupo | Ícones |
|---|---|
| Fluxo | upload, arquivo-dxf, arquivo-svg, arquivo-rd, download, regerar, duplicar, histórico, compartilhar |
| Máquina/perfil | máquina-laser, mesa, origem-canto (4 variantes ou 1 rotacionável), espelhar-x, espelhar-y, trocar-xy |
| Operações | cortar, gravar (vetor), raster, imagem, camada, cor-chip (não é ícone: componente), ligado/desligado (olho), arrastar-ordem |
| Parâmetros | velocidade, potência, passes, kerf, dpi, direção-raster (4), preset-material, salvar-preset |
| Resultado | tempo, distância, percurso, deslocamento, play/scrub, aviso, crítico, ok |
| UI genérica | fechar, expandir/colapsar, mais (⋯), ajuda, buscar, configurações, tema claro/escuro |

~45 ícones. Além disso: 1 ilustração de estado vazio (drop-zone), 1 logotipo/marca do
serviço, favicon.

---

## 7. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| `.rd` estruturalmente válido mas incorreto na máquina (origem, espelho, kerf) | Alto | Sprint 7 bloqueante; perfis conservadores; comparar com um `.rd` gerado pelo RDWorks para o mesmo desenho |
| Comandos de console do MeerK40t mudam entre versões | Médio | Pinar versão; testes do Sprint 0 rodam contra a versão pinada; PR upstream do `save_job` |
| Boot de ~1 s por job vira gargalo com muitos usuários | Baixo | Workers em paralelo; pool de processos "quentes" só se necessário |
| Fontes/texto em DXF (`TEXT`/`MTEXT`) dependem de fontes disponíveis no servidor | Médio | Instalar fontes Hershey/TrueType no container; avisar quando texto for convertido |
| Rasters grandes (imagens) estouram tempo/memória | Médio | Limite de DPI/tamanho por perfil; timeout maior para `raster`/`image` |

---

## 8. Estado da implementação (branch `main`)

Implementado em `service/` (ver [service/README.md](../service/README.md)):

| Sprint | Estado | Observações |
|---|---|---|
| 0 — núcleo headless | ✅ | `service/core/mk_job.py` roda dentro do subprocess; opera a árvore de elementos diretamente (sem interpolar strings no console). Correções no MeerK40t: `save_job` Ruida (arquivo vazio) e fallback do nome de layer no loader DXF. **Rasterizador headless** (`headless_raster.py`) substitui o `render-op/make_raster` da GUI — sem ele, operações raster saíam vazias. Estatísticas por operação via `CutCode.provide_statistics`. |
| 1 — API | ✅ | FastAPI com jobs, perfis, presets, download, duplicar, excluir, API key opcional. Persistência em JSON por job (`RD_DATA_DIR/jobs/<id>/job.json`) em vez de SQLite — suficiente para v1 e trivial de inspecionar. |
| 2 — worker | ◐ | `ThreadPoolExecutor` + um subprocess por job com timeout e classificação de erro (timeout/crash/internal). Sem Redis/RQ: fila em processo. Jobs interrompidos por restart viram `failed`. Falta TTL de artefatos e métricas. |
| 3 — upload e preview | ✅ | SPA sem build (`service/web`), tokens CSS claro/escuro, estado vazio, drop-zone, preview sobre a mesa com grade e origem, nav bar do canvas. |
| 4 — editor de operações | ✅ | Cards com chips legíveis, tipo/nome, parâmetros por estágio, validação inline espelhando o servidor, reordenar, ativar/desativar, presets de material, otimização colapsada. |
| 5 — estimativa e percurso | ✅ | Tempo total/corte/vazio, tabela por operação, `path.svg` sobreposto (cores por operação, tracejado = deslocamento), avisos com bloqueio de download em críticos, estado `stale`. |
| 6 — histórico | ◐ | Lista de trabalhos recentes, reabrir, duplicar, excluir. Sem link compartilhável nem export de `params.json`. |
| 7 — hardening | ☐ | Validação em máquina real pendente. Limites de upload e whitelist de extensões existem; falta rate limit, métricas, Docker. |

Testes: `python -m pytest service/tests` (6 testes: núcleo, avisos, falhas, fluxo HTTP completo).

## 9. Backlog pós-v1

- Posicionamento simples no browser (mover/rotacionar/encaixar na mesa) — reaproveita `translate`/`rotate` do console.
- Nesting básico de múltiplas peças.
- Múltiplos controladores de saída (gcode/egv) e perfis compartilhados pela comunidade.
- Modo "estação" em Raspberry Pi ao lado da máquina, com envio direto (reaproveita o kernel real) — converge com o caminho 3 do plano de UX.
