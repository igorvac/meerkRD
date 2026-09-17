# AGENTS.md — guia para agentes de código

Leia isto antes de mexer no repositório. É o contexto que uma nova sessão precisa
para continuar o desenvolvimento sem redescobrir o projeto.

## O que é

**meerkRD**: serviço web + interface que transforma DXF/SVG em arquivos `.rd`
para lasers com controlador Ruida. É um fork enxuto do MeerK40t (MIT); o motor
(`meerk40t/`) faz todo o trabalho de importar, planejar e gerar o `.rd`, e o
serviço (`service/`) o roda em subprocessos sem GUI. Público-alvo: alunos de um
laboratório de fabricação, que só precisam subir o desenho, ajustar parâmetros e
levar o arquivo no pendrive. Está em beta. Idioma da interface e da documentação:
**português do Brasil**; código e identificadores em inglês.

Leitura complementar: [README.md](README.md) (visão geral),
[docs/SERVICE.md](docs/SERVICE.md) (API, contrato de parâmetros, variáveis de
ambiente, limitações), [docs/RD_SERVICE_PLAN.md](docs/RD_SERVICE_PLAN.md) e
[docs/UX_UI_REVIEW_PLAN.md](docs/UX_UI_REVIEW_PLAN.md) (histórico das decisões).

## Mapa do repositório

```
meerk40t/                 motor. Só kernel, core, ruida, dxf, image, fill, device
                          (basedevice/dummy), extra (coolant, lbrn, xcs_reader,
                          encode_detect, imageactions), tools (pmatrix, raster-
                          plotter, zinglplotter, pathtools), svgelements, main.
  internal_plugins.py     lista de plugins que o kernel carrega — reduzida ao acima
  ruida/rdjob.py          protocolo .rd (swizzle, comandos, modo âncora)
  ruida/driver.py         plot -> comandos; aplica o deslocamento do modo âncora
  ruida/device.py         serviço do dispositivo; comando save_job; choice job_reference
  dxf/dxf_io.py           importador DXF (fallback do nome de layer corrigido aqui)
service/
  api/main.py             FastAPI. Modelos pydantic, persistência JSON, workers,
                          rotas. ~800 linhas, um arquivo só — de propósito.
  core/mk_job.py          RODA DENTRO DO SUBPROCESSO. Único lugar que importa o
                          kernel. Ações: analyze_part, analyze_nested, generate.
  core/runner.py          sobe o subprocesso (arquivos request/result únicos por
                          execução, timeout, contenção de crash)
  core/nesting.py         shelf packing por bounding box, Python puro
  core/headless_raster.py substitui o renderizador wx para operações raster
  web/index.html          layout: header, canvas + barra de cores, painel lateral
                          em 3 etapas recolhíveis, barra de ações
  web/app.js              SPA sem framework (~1.1k linhas): estado, render*, ações
  web/styles.css          tokens de design no primeiro bloco; resto não deveria
                          precisar de edição para re-skin
  web/icons.js            ícones SVG inline por nome
  seed/                   perfis de máquina e presets copiados para data/ no 1º start
  data/                   runtime, ignorado pelo git
tests/
  engine/                 suíte do MeerK40t para o que ficou (bootstrap.py carrega
                          só os plugins existentes)
  service/                nesting, núcleo multi-peça (subprocesso real), API HTTP
docs/                     SERVICE.md + planos
```

## Fluxo e estados de um job

```
POST /api/jobs (files[], profile_id)
  -> analyzing_parts  (analyze_part por peça, em paralelo)
  -> parts_ready
POST /api/jobs/{id}/nest
  -> nesting (nesting.py) -> analyze_nested (subprocesso) -> ready_for_params
PUT  /api/jobs/{id}/layout  (mover/girar/escalar cópias; POST .../layout/reset)
  -> relayout (analyze_nested de novo, params preservados) -> status anterior
PUT  /api/jobs/{id}/params   (operations + assignments; stale=true se já gerou)
POST /api/jobs/{id}/generate -> generating -> ready | failed
GET  /api/jobs/{id}/file     -> job.rd
```

Invariantes que não podem quebrar:

- **Ids de elemento são posicionais**: `<peça>#<cópia>:<índice>`, atribuídos por
  ordem de carregamento. `analyze_nested` e `generate` carregam as mesmas peças
  na mesma ordem para que `params.assignments` (elemento -> operação) continue
  válido. Qualquer mudança em peças, quantidade, rotação ou máquina passa por
  `reset_nesting_state()` e zera `analysis`/`params`. Mover, girar ou escalar
  cópias no canvas (`PUT /layout`, status `relayout`) **não** muda ids e
  preserva `params`: só redesenha o `preview.svg`.
- **Placement é por centro**: `cx_mm/cy_mm` + `rotation_deg` + `scale`, aplicados
  em `position_part_instance`; o front replica a mesma sequência para mostrar
  a peça antes da reanálise. `x/y/width/height` são informativos.
- **`assignments` manda, `source` é rótulo.** `build_operations()` cria os nós de
  operação a partir de `params.operations`; `assign_elements()` liga os elementos
  pelo mapa. Nunca recombine por layer/cor na geração.
- **`elem point` não é cortável**: o motor não aceita referência de ponto numa
  operação. O front não deixa selecionar nem conta esses elementos.
- **Uma cor = uma operação** na interface. Operação sem formas some da lista;
  os parâmetros dela ficam em `state.colorMemory` por cor.
- **Modo âncora** (`job_reference: "anchor"`): o header do `.rd` usa `REF_POINT_1`
  e as coordenadas são relativas ao canto mínimo da geometria; o driver
  desconta `anchor_dx/dy` em `_move()`. `"absolute"` é o comportamento original
  do MeerK40t. Não altere sem comparar com um `.rd` do RDWorks.
- **Um subprocesso por execução** com arquivos `request-*.json`/`result-*.json`
  únicos: duas análises do mesmo job rodam em paralelo.

## Como trabalhar aqui

- **Ambiente**: `python3 -m venv .venv && .venv/bin/pip install -r service/requirements.txt`.
  Use sempre o Python do venv; o `python` do sistema pode não ter `pyusb`, e o
  motor importa ele mesmo sem hardware.
- **Rodar**: `.venv/bin/python -m uvicorn service.api.main:app --port 8765`
  (sem `--reload`, mudanças em `main.py` exigem reiniciar). O front é servido
  com `Cache-Control: no-cache`, mas navegadores embutidos às vezes seguram o
  módulo `app.js`; recarregue com um parâmetro de query novo.
- **Testar**: `.venv/bin/python -m pytest tests` (~50 s; 551 testes). Os testes
  de `tests/service` sobem subprocessos reais do motor — se um ficar
  intermitente, suspeite de concorrência em disco antes de suspeitar do motor.
- **Front sem build**: edite `app.js`/`styles.css`/`index.html` direto e valide
  com `node --check service/web/app.js`. Não introduza bundler nem framework.
- **Verifique no navegador** o que for visual: suba o servidor, abra um job,
  clique. Testes de API não cobrem o front.
- **Commits** pequenos, mensagem em inglês no imperativo, explicando o porquê.
  Não faça push nem mude o remote sem o usuário pedir.
- **Antes de apagar código do motor**, meça: instrumente o subprocesso para
  listar `sys.modules` após `analyze_part`/`analyze_nested`/`generate` e confira
  imports tardios com grep. A árvore completa está na tag `antes-da-limpeza`.
- **Mudanças no motor** devem ser mínimas e localizadas (hoje: `ruida/rdjob.py`,
  `ruida/driver.py`, `ruida/device.py`, `dxf/dxf_io.py`, `internal_plugins.py`,
  `main.py`), para que possam ser propostas de volta ao MeerK40t.
- **Não escreva** comentários que narram o óbvio nem READMEs paralelos; atualize
  os documentos existentes.

## Estado atual e próximos passos plausíveis

Feito e validado: upload multi-arquivo, nesting por bounding box, operações por
cor com seleção no canvas, zoom/pan, perfis de máquina editáveis, troca de
máquina num job existente, modo âncora Ruida, painel em etapas, `.rd` validado
contra RDWorks e frame conferido em máquina real. Layout manual no canvas
(mover/girar/escalar, caixa numérica, reset) validado no navegador e no motor,
**não** em máquina.

Em aberto (ver também "Limitações conhecidas" em `docs/SERVICE.md`):

- Corte real de material em laboratório com o `.rd` multi-peça.
- Nesting irregular (contorno, não bounding box) e múltiplas chapas.
- Texto em DXF/SVG (precisa de fontes; hoje é aviso).
- Autenticação simples para uso fora da rede local (hoje só `RD_API_KEY`).
- Limpeza automática de jobs antigos em `service/data`.
- Empacotamento (Docker, ou app desktop com pywebview + PyInstaller).
