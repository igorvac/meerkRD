# Laser RD — MeerK40t como serviço de geração de arquivos `.rd`

Interface web + API que recebe um desenho (DXF/SVG/LightBurn…), deixa o usuário
ajustar velocidade, potência, passes e estratégia por operação, e devolve um arquivo
`.rd` pronto para o painel/pendrive de uma máquina Ruida. Nenhuma conexão física com
a laser é necessária. Plano e decisões em [docs/RD_SERVICE_PLAN.md](../docs/RD_SERVICE_PLAN.md).

```
service/
├── core/
│   ├── mk_job.py          # roda DENTRO do subprocess MeerK40t: analyze / generate
│   ├── headless_raster.py # substitui o renderizador wx para operações raster
│   └── runner.py          # um subprocess por job, timeout, contenção de crash
├── api/main.py            # FastAPI: jobs, perfis de máquina, presets, download
├── web/                   # SPA sem build: tokens CSS, ícones substituíveis, app.js
├── seed/                  # perfis de máquina e presets iniciais
├── tests/                 # pytest (núcleo + API)
└── requirements.txt
```

## Rodar localmente

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r service/requirements.txt
uvicorn service.api.main:app --host 127.0.0.1 --port 8765
```

Abra <http://127.0.0.1:8765>. O botão **Usar exemplo** carrega `web/exemplo.dxf`
(layers `CUT`, `ENGRAVE`, `LOGO`).

Variáveis de ambiente:

| Variável | Padrão | Uso |
|---|---|---|
| `RD_DATA_DIR` | `service/data` | jobs, perfis e presets persistidos (JSON em disco) |
| `RD_API_KEY` | — | se definida, toda rota `/api` exige `X-API-Key` |
| `RD_WORKERS` | `2` | subprocessos MeerK40t em paralelo |
| `RD_JOB_TIMEOUT` | `180` | segundos por job |
| `RD_MAX_UPLOAD_MB` | `25` | limite de upload |

## Fluxo

1. `POST /api/jobs` (multipart `file` + `profile_id`) → status `analyzing`.
2. O worker roda `python -m service.core.mk_job <job_dir>` com `action=analyze`:
   carrega o arquivo, exporta `preview.svg`, detecta operações por layer
   (`CUT`/`ENGRAVE`/`RASTER` no nome) ou por cor → status `ready_for_params`
   com `params` já preenchidos.
3. `PUT /api/jobs/{id}/params` com o JSON de operações (validado por pydantic e
   novamente no front, com as mesmas regras).
4. `POST /api/jobs/{id}/generate` → `action=generate`: recria as operações a partir
   do JSON (atribuição determinística por layer/cor, sem `classify`), planeja com ou
   sem otimização, grava `job.rd` (`save_job`), `path.svg` (percurso) e
   `stats.json` (tempo/distância por operação via `CutCode.provide_statistics`).
5. `GET /api/jobs/{id}/file` baixa o `.rd` (`<nome>_<perfil>.rd`).

Mudar parâmetros depois de gerar marca o job como `stale`: o download fica bloqueado
até gerar novamente. Avisos críticos (geometria fora da mesa, velocidade acima do
perfil) exigem confirmação explícita para baixar.

## Contrato de parâmetros

```json
{
  "optimize": {"enabled": true, "inner_first": true, "reduce_travel": true},
  "material_preset": "mdf-3mm",
  "operations": [
    {"id": "op_1", "source": {"layer": "CUT"}, "type": "cut", "order": 2,
     "speed_mm_s": 12, "power_pct": 65, "passes": 2, "kerf_mm": 0.1, "color": "#ff0000"},
    {"id": "op_3", "source": {"layer": "LOGO"}, "type": "raster", "order": 0,
     "speed_mm_s": 300, "power_pct": 25, "dpi": 254, "direction": "top_to_bottom"}
  ]
}
```

`source` aceita `{"layer": ...}`, `{"color": "#rrggbb"}` ou `{"element_ids": [...]}`.
`power_pct` é 0–100 (internamente 0–1000). Tipos: `cut | engrave | raster | image`.

## Perfis de máquina

`seed/machine_profiles.json` → copiado para `RD_DATA_DIR/machine_profiles.json` no
primeiro start. Os campos `bed_mm`, `home_corner`, `flip_x/flip_y/swap_xy` e `magic`
entram no `.rd`, por isso o perfil é obrigatório mesmo sem conexão. `max_speed_mm_s`
e `min_power_pct` alimentam a validação e os avisos.

## Testes

```bash
python -m pytest service/tests -v
```

Cobrem: detecção de layers, geração de `.rd` válido (magic, EOF, velocidades por
camada decodificadas do arquivo), raster headless, avisos, fluxo HTTP completo
(upload → params → generate → download → stale → duplicar → excluir).

## Limitações conhecidas

- **Texto** (`TEXT`/`MTEXT` em DXF, `<text>` em SVG) não é gravado: precisa de fontes
  que só a GUI renderiza. Converta em curvas no CAD. O serviço avisa.
- **Kerf** usa o offset interno do MeerK40t, que lineariza arcos em muitos segmentos:
  adiciona ~5 s por job e deixa o `path.svg` maior. Otimização com kerf em desenhos
  grandes pode chegar a dezenas de segundos — cabe no timeout padrão, mas é o
  primeiro alvo de otimização.
- O `.rd` é estruturalmente válido e decodificável pelo próprio loader do MeerK40t,
  mas **ainda não foi validado numa Ruida real** (Sprint 7 do plano).

## Personalização visual

Todos os tokens (cores claro/escuro, tipografia, espaçamento, tamanhos) estão no
primeiro bloco de `web/styles.css`. Os ícones ficam em `web/icons.js`, um por nome,
como paths SVG 24×24 em `currentColor` — substitua o conteúdo mantendo os nomes.
