# Serviço RD — referência

Interface web + API que recebe um ou mais desenhos (DXF/SVG/LightBurn…) — um
**projeto** com várias **peças** —, posiciona automaticamente cada cópia na mesa
(**nesting** por retângulo delimitador), deixa o usuário selecionar formas
individuais no desenho e atribuí-las a operações por cor, ajustar velocidade,
potência, passes e estratégia por operação, e devolve um arquivo `.rd` pronto
para o painel/pendrive de uma máquina Ruida. Nenhuma conexão física com a laser
é necessária. Visão geral no [README](../README.md); plano e decisões em
[RD_SERVICE_PLAN.md](RD_SERVICE_PLAN.md).

```
service/
├── core/
│   ├── mk_job.py          # roda DENTRO do subprocess MeerK40t: analyze_part / analyze_nested / generate
│   ├── nesting.py         # empacotamento por retângulo delimitador (shelf packing), puro Python
│   ├── headless_raster.py # substitui o renderizador wx para operações raster
│   └── runner.py          # um subprocess por execução, timeout, contenção de crash
├── api/main.py            # FastAPI: jobs, peças, nesting, perfis de máquina, presets, download
├── web/                   # SPA sem build: tokens CSS, ícones substituíveis, app.js
│                          #   painel lateral = etapas 1-2-3 recolhíveis (uma aberta por vez)
├── seed/                  # perfis de máquina e presets iniciais
└── requirements.txt
tests/
├── engine/                # suíte do MeerK40t para o que ficou do motor
└── service/               # pytest (nesting, núcleo multi-peça, API)
```

## Rodar localmente

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r service/requirements.txt
uvicorn service.api.main:app --host 127.0.0.1 --port 8765
```

O pacote `meerk40t/` é uma versão enxuta do MeerK40t (ver README); a árvore
completa está na tag `antes-da-limpeza`.

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

1. `POST /api/jobs` (multipart `files[]` + `profile_id`) — um ou mais arquivos, cada
   um vira uma **peça** (`parts[]`) → status `analyzing_parts`.
2. Para cada peça, o worker roda `action=analyze_part` (bbox, camadas, nº de
   elementos) → quando todas terminam, status `parts_ready`. Dá para ajustar
   **quantidade** (cópias) e **girar 90°** por peça, e `POST /api/jobs/{id}/parts`
   para adicionar mais arquivos ao mesmo projeto a qualquer momento.
3. `POST /api/jobs/{id}/nest?spacing_mm=5&margin_mm=5` → `service/core/nesting.py`
   (puro Python, sem subprocess) empacota cada cópia pedida na mesa (shelf
   packing por retângulo delimitador, com rotação 0°/90°). `spacing_mm` é o
   espaço deixado entre as cópias e `margin_mm` o recuo das bordas da mesa
   (0–200 mm; a interface mostra os dois campos acima de "Nestear peças",
   lembra os últimos valores usados e o job guarda `nest_spacing_mm` /
   `nest_margin_mm`). Peças que não couberem ficam em `unplaced_part_ids` e
   viram aviso. Em seguida dispara `action=analyze_nested`:
   carrega cada instância na posição calculada (cada forma recebe um id estável
   `<peça>#<cópia>:<índice>`), agrega operações por **nome de layer entre todas
   as peças/cópias** (todo "CUT" de todo arquivo vira uma única operação Cut) e
   exporta o `preview.svg` do layout completo → status `ready_for_params` com
   `params.assignments` (mapa `id_do_elemento → id_da_operação`) já preenchido.
4. `PUT /api/jobs/{id}/params` com `operations` + `assignments` (validado por
   pydantic e no front). Na **barra inferior** do canvas (que também mostra o
   status e o tema; estilo
   RDWorks/LightBurn: uma cor = uma operação) o usuário clica numa forma e
   depois numa cor: cor já usada → move para aquela operação; cor livre da
   paleta → cria uma operação nova com aquela cor (copiando os parâmetros da
   operação de origem) e move a seleção para ela. Operação que fica sem formas
   some da lista; os parâmetros dela ficam guardados por cor e voltam se a cor
   for reutilizada. Isso só edita `operations`/`assignments`, nunca `source`
   (que fica só como rótulo informativo). Cada forma ganha um clone invisível
   com traço largo (`.svc-hit`) para o clique não exigir mira; o canvas tem
   zoom (roda do mouse / botões) e pan (arrastar), e aproxima das peças
   automaticamente ao abrir um layout.
   **Layout manual.** Com o layout na tela, o alternador "Mover peças" (tecla
   `M`; "Selecionar" / `V` volta ao modo de cores) deixa arrastar cópias
   inteiras, girá-las pela alça superior (Shift = de 15 em 15°) e escalá-las
   pelos cantos (sempre proporcional). Clique numa cópia para selecioná-la,
   Shift+clique ou arrastar na mesa vazia (marquee) para várias; setas movem
   1 mm (Shift: 10 mm); botão do meio ou Espaço+arrastar faz pan. Ao lado da
   seleção aparece uma caixa com **deslocamento em X/Y** (relativo, Enter
   aplica), rotação e escala (absolutas para uma peça, relativas para várias)
   e o tamanho resultante em mm. Cada edição vai para
   `PUT /api/jobs/{id}/layout` (`placements[]` com `part_id`,
   `instance_index`, `cx_mm`, `cy_mm`, `rotation_deg`, `scale` — o conjunto de
   cópias precisa ser o mesmo do nesting) e dispara o status **`relayout`**:
   `analyze_nested` roda de novo só para redesenhar o `preview.svg` e medir as
   caixas; como os ids de elemento dependem só da ordem de carregamento,
   `params`/`assignments` são preservados. Enquanto isso o canvas mostra a
   transformação localmente (delta entre `placements` e
   `rendered_placements`, os placements da última análise). O canvas também
   avisa peça fora da mesa, sobreposição (pelos contornos desenhados: um
   segmento cruzando outro ou um vértice dentro do contorno de outra peça, com
   regra par-ímpar — uma peça dentro do furo de outra é válida) e escala
   alterada. `POST /api/jobs/{id}/layout/reset` volta ao `nest_placements`
   (a saída intacta do nesting); nestear de novo, mudar quantidade ou máquina
   descarta o layout manual com confirmação. Um job já gerado fica `stale`.
   **Escala altera o tamanho real de corte** — a interface mostra as medidas,
   mas confira antes de cortar.
5. `POST /api/jobs/{id}/generate` → `action=generate`: recarrega as mesmas
   instâncias na mesma ordem (ids batem com os de `analyze_nested`), aplica
   `assignments` diretamente (sem recombinar por layer/cor), planeja, grava
   `job.rd`, `path.svg` e `stats.json`.
6. `GET /api/jobs/{id}/file` baixa o `.rd` (`<nome>_<perfil>.rd`).

`PUT /api/jobs/{id}/profile` troca a máquina de um trabalho existente (o
seletor "Máquina salva" faz isso com um trabalho aberto; salvar o perfil em uso
com a mesa editada re-nesteia via `force`). As peças, quantidades e rotação
ficam; layout e atribuições voltam do zero, porque a mesa muda.

Qualquer mudança nas peças (adicionar/remover/quantidade/girar) invalida o nesting
e a análise (`params`/`analysis` voltam a `null`, status volta a `parts_ready` ou
`analyzing_parts`) — os ids dependem da ordem exata de carregamento, então uma
peça a mais ou a menos desalinha tudo que já foi atribuído manualmente.

Mudar parâmetros depois de gerar marca o job como `stale`: o download fica bloqueado
até gerar novamente. Avisos críticos (geometria fora da mesa, velocidade acima do
perfil, peça que não coube no nesting) exigem confirmação explícita para baixar.

## Contrato de parâmetros

```json
{
  "optimize": {"enabled": true, "inner_first": true, "reduce_travel": true},
  "material_preset": "mdf-3mm",
  "assignments": {"bracket#1:0": "op_1", "bracket#1:1": "op_1", "plate#1:0": "op_3"},
  "operations": [
    {"id": "op_1", "source": {"layer": "CUT"}, "type": "cut", "order": 2,
     "speed_mm_s": 12, "power_pct": 65, "passes": 2, "kerf_mm": 0.1, "color": "#ff0000"},
    {"id": "op_3", "source": {"layer": "LOGO"}, "type": "raster", "order": 0,
     "speed_mm_s": 300, "power_pct": 25, "dpi": 254, "direction": "top_to_bottom"}
  ]
}
```

`source` (`{"layer": ...}` ou `{"color": "#rrggbb"}`) é só o rótulo de onde a
operação veio por padrão — quem manda em quem-corta-o-quê é `assignments`.
`power_pct` é 0–100 (internamente 0–1000). Tipos: `cut | engrave | raster | image`.

## Contrato de placement

```json
{"part_id": "bracket", "instance_index": 2,
 "cx_mm": 200.0, "cy_mm": 80.0, "rotation_deg": 37.0, "scale": 0.5,
 "x_mm": 164.0, "y_mm": 46.0, "width_mm": 72.0, "height_mm": 68.1, "rotated": false}
```

O motor (`mk_job.py:position_part_instance`) escala e gira cada cópia em torno
do centro do seu próprio retângulo delimitador (que é invariante às duas
operações) e leva esse centro a `(cx_mm, cy_mm)`; `x/y/width/height` são a
caixa medida depois da transformação, só informativos, e `rotated` é o flag
0°/90° do nesting. Layouts gravados antes desse contrato (só `x_mm/y_mm` e
`rotated`) são normalizados na leitura — para caixas a 0°/90° as duas formas
são idênticas. O job guarda três listas: `placements` (o que vale),
`nest_placements` (saída do nesting, base do reset) e `rendered_placements`
(o que o `preview.svg` atual mostra).

## Perfis de máquina

`seed/machine_profiles.json` → copiado para `RD_DATA_DIR/machine_profiles.json` no
primeiro start. Os campos `bed_mm`, `home_corner`, `flip_x/flip_y/swap_xy` e `magic`
entram no `.rd`, por isso o perfil é obrigatório mesmo sem conexão. `max_speed_mm_s`
e `min_power_pct` alimentam a validação e os avisos.

## Testes

```bash
python -m pytest tests
```

`tests/engine` é a suíte do MeerK40t para o que ficou (kernel, núcleo, Ruida,
DXF); `tests/service` cobre o serviço.

Cobrem: o algoritmo de nesting isolado (sem overlap, sem estourar a mesa, rotação,
peça que não cabe), o núcleo multi-peça (`analyze_part`/`analyze_nested`/`generate`
com múltiplas cópias posicionadas sem sobreposição, agregação de layer entre peças,
rotação livre e escala por centro, placement legado), o layout manual pela API
(preserva atribuições, rejeita conjunto de cópias diferente, reset, `stale`),
geração de `.rd` válido (magic, EOF, velocidades por camada decodificadas do
arquivo), raster headless, avisos, e o fluxo HTTP completo (upload multi-arquivo →
nest → reatribuir elemento a outra operação → generate → download → stale →
adicionar peça invalida o job → duplicar → excluir).

## Limitações conhecidas

- **Nesting é por retângulo delimitador (bounding box), não irregular de verdade.**
  Não há busca de encaixe entre formas não-retangulares (tipo SVGnest/Deepnest) —
  cada peça ocupa o retângulo do seu próprio contorno, então formas muito não-
  retangulares desperdiçam chapa. V1 também só usa uma chapa: peças que não cabem
  ficam de fora com aviso, não sobra pra uma segunda folha.
- **Texto** (`TEXT`/`MTEXT` em DXF, `<text>` em SVG) não é gravado: precisa de fontes
  que só a GUI renderiza. Converta em curvas no CAD. O serviço avisa.
- **Kerf** usa o offset interno do MeerK40t, que lineariza arcos em muitos segmentos:
  adiciona ~5 s por job e deixa o `path.svg` maior. Otimização com kerf em desenhos
  grandes pode chegar a dezenas de segundos — cabe no timeout padrão, mas é o
  primeiro alvo de otimização.
- **Pontos de referência** (`elem point` no DXF) aparecem no desenho mas não são
  selecionáveis nem contam para nenhuma operação: o MeerK40t não os corta.
- **Layout manual não foi testado em máquina real.** Rotação livre e escala
  passaram pelo motor (a caixa medida bate com a geometria esperada) e pelo
  navegador, mas um `.rd` com peças giradas em ângulos arbitrários — sobretudo em
  modo âncora, cujo header usa o canto mínimo da geometria — ainda precisa de
  comparação com o RDWorks e de um corte de teste. A detecção de sobreposição
  amostra os contornos a cada ~2 mm (imagens e texto contam pela caixa) e não
  considera kerf nem folga mínima. Escalar peças com imagem raster
  (`elem image`) não foi verificado.
- O `.rd` é estruturalmente válido e decodificável pelo próprio loader do MeerK40t,
  e já foi comparado byte a byte com um `.rd` real do RDWorks — mas **ainda não foi
  testado numa Ruida física** (Sprint 7 do plano).

## Personalização visual

Todos os tokens (cores claro/escuro, tipografia, espaçamento, tamanhos) estão no
primeiro bloco de `web/styles.css`. Os ícones ficam em `web/icons.js`, um por nome,
como paths SVG 24×24 em `currentColor` — substitua o conteúdo mantendo os nomes.
