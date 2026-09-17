# MeerK40t — Análise crítica de UX/UI e plano de melhorias

**Versão analisada:** 0.9.9040 (src), macOS 15 / wxPython 4.2.3
**Branch de trabalho:** `main` (antiga `ux-review`)
**Referência de bom design:** Autodesk Fusion 360 (Design + Manufacture)
**Método:** execução real do app com perfil isolado (`-P 9 -X`), navegação pelos fluxos
principais (importar/criar → classificar em operações → parametrizar → posicionar →
simular → executar), inspeção de todas as janelas principais e revisão do código da GUI
(`meerk40t/gui/`).

> Este documento é deliberadamente duro. O MeerK40t é tecnicamente muito capaz
> (kernel, planner, drivers, otimização de percurso) mas a interface esconde essa
> capacidade atrás de uma UI que expõe a arquitetura interna em vez do fluxo de trabalho
> de quem opera uma laser. O objetivo aqui não é "deixar bonito": é reduzir tempo até o
> primeiro corte, reduzir erro operacional e tornar o software defensável frente a
> LightBurn e ao padrão de qualidade que o Fusion 360 estabeleceu para fabricação digital.

---

## 1. Resumo executivo

| Área | Nota (0–10) | Diagnóstico em uma linha |
|---|---|---|
| Arquitetura de informação | 3 | A UI espelha a estrutura interna (kernel/planner/spooler), não o fluxo do usuário. |
| Ribbon / ações principais | 3 | 25+ botões de peso igual; "Start" tem o mesmo destaque que "Notes" e "Wordlist". |
| Canvas / cena | 6 | Boa base (régua, grid, snap, handles), mas sem barra de navegação, sem estado vazio, sem feedback de segurança. |
| Árvore (Tree) | 4 | Rótulos crípticos (`Raster =B2T 150.0mm/s @1000`, `Rect - #0000ff`), sem olho/cadeado, três ramos fixos. |
| Editor de operações | 4 | Tabs obsoletas, template de label exposto (`Cut ({percent}, {speed}mm/s)`), unidades ausentes, sem tempo estimado ao vivo. |
| Painel Laser-Control | 3 | 5 abas (Laser/Jog/Plan/Optimize/Move) misturam segurança, motion, debug e otimização num painel de 250 px. |
| Barra de status | 2 | 16 "chips" coloridos (C1…R4) sem significado explícito, texto de 8 px, checkboxes ilegíveis. |
| Janelas flutuantes | 3 | Properties, Navigation, Simulation, Console, Spooler, Controller… tudo em janelas soltas; nada é dockado por padrão. |
| Preferências | 3 | 10+ abas com overflow, knobs de desenvolvedor expostos ("Process input while typing", "hover before description 2000 ms"). |
| Sistema visual | 3 | Ícones monocromáticos de espessura inconsistente, tipografia sem escala, captions de 9 px truncadas ("To…", "M…"). |
| Segurança / feedback | 3 | Teclas `a/d/w/s` movem fisicamente o cabeçote; warnings escondidos atrás de um botão; "Arm" sem explicação. |
| Robustez percebida | 2 | 3 crashes reproduzidos em 30 min só abrindo a UI (ver §8). Um comando de console derruba o app inteiro. |
| Acessibilidade | 2 | Ribbon e canvas invisíveis para a árvore de acessibilidade; sem navegação por teclado no ribbon. |
| Onboarding | 2 | Nenhum estado vazio, nenhum wizard de máquina, dica inicial diz "aperte F11". |

**Veredito:** a UI é um "painel de instrumentos de engenharia" — completa, mas com carga
cognitiva alta e sem hierarquia. O software precisa de uma reestruturação por
**workspaces orientados a etapa** (Design → Preparar → Executar → Máquina), um
**inspector dockado** no lugar de janelas flutuantes, uma **barra de job** com a ação
primária inequívoca, e um **sistema visual** com tokens (espaçamento, tipografia, ícones,
cores semânticas). Isso é exatamente o que o Fusion 360 faz bem e é replicável em
wxPython com disciplina.

---

## 2. Fluxos de uso analisados (lentes da análise)

Os fluxos abaixo são os "jobs to be done" reais de quem opera cortadoras/gravadoras
laser. Cada achado do §4 referencia um ou mais deles.

| # | Fluxo | Frequência | Estado atual (resumo) |
|---|---|---|---|
| F1 | **Primeiro uso**: instalar, escolher a máquina, ver a mesa, cortar um teste | 1x / usuário | Sem wizard; janela "Tips" com lâmpada gigante; mesa aparece mas nada indica "o que fazer agora". |
| F2 | **Importar SVG/DXF → atribuir operações → parametrizar (velocidade/potência/passes)** | Diária | Atribuição automática por cor ("classify") é mágica e opaca; parametrizar exige abrir janela flutuante "Properties". |
| F3 | **Posicionar peças na mesa / usar câmera / enquadrar (frame/outline)** | Diária | Ferramentas espalhadas entre Navigation (janela), Laser-Control (aba Jog e Move) e ribbon. |
| F4 | **Pré-visualizar / estimar tempo / verificar percurso** | Diária | Só existe na janela "Simulation"; nenhum tempo estimado na tela principal; warnings escondidos. |
| F5 | **Executar, pausar, parar em emergência** | Diária | "Start" cinza até "Arm" (não explicado); Stop com peso visual igual a "Outline". |
| F6 | **Biblioteca de materiais / presets** | Semanal | Combo "— Load preset —" solto no topo da árvore; Material Manager em janela de 860×800 separada. |
| F7 | **Gravação raster / imagem (DPI, dither, direção)** | Semanal | Parâmetros como `=B2T` no rótulo da operação; wizard de imagem em outra janela. |
| F8 | **Configurar/ajustar máquina (origem, tamanho da mesa, porta, aceleração)** | Mensal | Espalhado entre Config ribbon, Preferences (10 abas), Devices, Controller. |
| F9 | **Batch / wordlist / variáveis de texto** | Rara | Presente e potente, mas ocupa espaço nobre do ribbon principal. |

---

## 3. O que o Fusion 360 faz bem (e que devemos importar)

Não se trata de copiar estética, mas os **princípios de organização**:

1. **Workspaces por intenção** (Design / Manufacture / Simulation). O toolbar muda com o
   workspace; nada de "todas as ações o tempo todo". → MeerK40t: Design / Preparar /
   Executar / Máquina.
2. **Toolbar em grupos com um botão primário + dropdown** (Create ▾, Modify ▾,
   Inspect ▾). Cada grupo tem *label visível*. Resultado: 6–8 grupos, não 25 botões.
3. **Browser (árvore) com olho e cadeado** por item, ícones de status inline
   (⚠ precisa regenerar, ✓ ok). Não há três ramos fixos; há hierarquia do documento.
4. **Diálogo de comando pequeno e contextual**, ancorado próximo ao canvas, exibindo
   apenas os parâmetros do comando, com **manipuladores on-canvas** e **preview ao vivo**.
   → Nada de janela "Properties" com 12 seções e scroll.
5. **Fluxo CAM em estágios**: Setup (stock/origem) → Operation (tool, geometry, heights,
   passes, linking — sempre as mesmas abas na mesma ordem) → Simulate → Post Process.
   → Para laser: Máquina/Material → Operação (Tipo, Geometria, Parâmetros, Passes,
   Avançado) → Simular → Enviar.
6. **Navigation bar** no rodapé central do canvas (orbit/pan/zoom/fit/display/grid) +
   ViewCube. → Barra de navegação 2D: fit mesa / fit seleção / zoom / grid / snap /
   posição do laser / overlay de câmera.
7. **Marking menu e busca de comandos ("S")**. → Paleta de comandos (Ctrl+K) que reutiliza
   o console de comandos já existente. Isso é um *superpoder* do MeerK40t que hoje está
   escondido atrás de uma janela de terminal.
8. **Sistema de ícones coerente** (dois tons, mesma espessura, azul de acento para
   estados ativos) e **tema claro/escuro paritário**.
9. **Mensagens de aviso no local do problema** (ícone amarelo no item do browser + banner
   no diálogo), não num botão global.
10. **Defaults razoáveis e disclosure progressiva**: 90 % dos parâmetros ficam em
    "Advanced/More"; o essencial cabe sem scroll.

---

## 4. Achados críticos, por área

Legenda de severidade: **P0** bloqueia/segurança · **P1** custo alto de uso diário ·
**P2** fricção · **P3** polimento.

### 4.1 Arquitetura de informação e layout

| ID | Sev | Achado (evidência) | Proposta |
|---|---|---|---|
| IA-1 | P1 | A UI expõe conceitos internos como navegação principal: abas **"Plan"** (tabela `# / Plan / Status / Content – "0 items", "Init"`) e **"Optimize"** dentro do Laser-Control; botões **Spooler**, **Controller**, **Console**, **Wordlist** no ribbon primário. Isso é o *pipeline* (`CutPlan → Spooler → Driver`) virando UI. | Reorganizar em 4 workspaces: **Design** (criar/editar), **Preparar** (operações, materiais, otimização), **Executar** (job, jog, spooler, câmera), **Máquina** (device, portas, calibração). "Plan" e "Console" viram ferramentas de desenvolvedor acessíveis por menu/paleta, não abas. |
| IA-2 | P1 | Sete janelas flutuantes de primeira classe (Properties, Navigation, Simulation, Console, Spooler, Controller, Preferences) que abrem sempre no mesmo ponto (327,213) e se sobrepõem. Nada é dockado por padrão exceto Tree e Laser-Control. | Um **Inspector dockado à direita** (substitui Properties + Burn-Operation + Details), um **painel Executar** dockado (substitui Laser-Control + Navigation + Spooler) e **Simulação como modo do canvas**. Janelas flutuantes só para utilitários raros. |
| IA-3 | P1 | Painel direito inferior tem 5 abas (Laser / Jog / Plan / Optimize / Move) espremidas em ~250 px. "Move" está 80 % vazio com um grid 3×3 de botões "1–9" de 10 px sem rótulo. "Optimize" é uma lista de 9 checkboxes com scroll interno. | Eliminar as abas. Jog e "mover laser para" viram um painel único de **Motion**; "Move" e "Plan" são removidos; "Optimize" vai para o diálogo de job (etapa Simular/Enviar) como *disclosure* "Otimização ▾". |
| IA-4 | P2 | Tabs no rodapé da árvore: **"Burn-Operation"** e **"Details"** — "Details" é a própria árvore. Nomenclatura sem sentido para o usuário. | Uma árvore única (Browser) com seção *Operações* e *Elementos* e os controles de atribuição integrados (ver TREE-*). |
| IA-5 | P2 | Combo **"Material: — Load preset —"** solto no topo da árvore, sem relação visível com o que está abaixo. | Mover o seletor de material para o cabeçalho do workspace *Preparar* / do editor de operação, junto de "Máquina" e "Espessura". |
| IA-6 | P2 | Captions dos painéis AUI com 9 px e truncadas: **"To…"**, **"M…"**, **"Ribbon"** (cortado no topo-esquerdo). | Nomes completos, 12–13 px, ou remover captions de painéis fixos (Fusion não tem "caption" no browser). |

### 4.2 Ribbon (barra de ferramentas principal)

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| RB-1 | P0 | **Start** (ação mais crítica e perigosa do app) fica no canto direito com o mesmo tamanho/peso de *Notes*, *CSV Batch*, *Wordlist*. Aparece **cinza** até o usuário clicar em **Arm**, sem nenhuma explicação visível do porquê. **Stop** é um botão monocromático igual aos outros. | **Barra de job** dedicada (rodapé ou topo-direito) com: tempo estimado · ajuste à mesa · avisos · `[Enquadrar] [Simular] [▶ Iniciar]` (botão primário colorido) e `[■ Parar]` sempre vermelho e sempre visível. "Arm" vira segurar-para-iniciar ou um toggle explícito com texto "Laser armado". |
| RB-2 | P1 | Aba **Project** tem ~25 botões em 6 grupos sem rótulo de grupo visível; todos os ícones têm o mesmo peso. Aba **Modify** tem 17 botões (boolean, alinhamento, distribuição, mirror…) igualmente planos. | Reduzir a ≤ 8 grupos com **label de grupo** e **botão primário + dropdown** (padrão Fusion "Create ▾"). Ex.: *Arquivo* (Abrir ▾, Salvar), *Editar* (Desfazer/Refazer, Cortar/Copiar/Colar ▾), *Criar* (Retângulo ▾ …), *Modificar* (Alinhar ▾, Boolean ▾, Transformar ▾), *Máquina* (Home, Jog ▾, Câmera ▾). |
| RB-3 | P1 | Botões de **Config** (Keymap, Wordlist Editor, CSV Batch Run, Font-Manager, Devices, Config, Rotary) ocupam uma aba inteira do ribbon. | Mover para **Preferências / Máquina** e paleta de comandos. Ribbon não é lugar de configuração. |
| RB-4 | P2 | Ícones ambíguos: **Arm** (uma porta?), **Spooler** (losango), **Outline**, **Wordlist** (`{ }`), **Notes**. Ícones outline com espessura visivelmente diferente (Camera vs Spooler vs Home). | Redesenhar o set de ícones sob um grid de 24 px, 1,75 px de stroke, cantos consistentes; usar preenchimento/acento para estado ativo. Validar com teste de reconhecimento (5 s). |
| RB-5 | P2 | Estado desabilitado é um cinza claro quase idêntico ao habilitado (ver Delete/Cut/Copy/Paste vs Open/Save na captura inicial). | Desabilitado = 40 % opacidade + sem hover; habilitado = 100 %. Definir como token. |
| RB-6 | P2 | Rótulos das abas do ribbon ("Project", "Modify", "Config") têm ~9 px, sem estado ativo claro. | Abas de 13 px, indicador de ativo de 2 px na cor de acento, área de clique ≥ 32 px. |
| RB-7 | P3 | Botão **Warning** aparece/desaparece no ribbon mudando o layout; avisos só visíveis ao clicar. | Ver SF-2. |

### 4.3 Barra de ferramentas esquerda (toolbar de criação/seleção)

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| TB-1 | P1 | Dois painéis ("To…", "M…") com ~20 ícones de **12 px** numa tela de 1710 px, cada "grupo" gasta ~40 px verticais só para um chevron azul ▾ repetido 10 vezes. Nenhum rótulo, nenhum tooltip descoberto por teclado. | Uma toolbar vertical única de 40 px com ícones de 24 px, grupos por separador, dropdown só onde há variantes (Polígono ▾ estrela/free-hand). Rótulo do modo ativo no canto do canvas ("Retângulo — arraste para desenhar, Shift = quadrado"). |
| TB-2 | P2 | Ferramentas de desenho não têm painel de parâmetros contextual: ao desenhar um retângulo não há campos W/H/raio nem preview numérico. | **Diálogo de comando** flutuante ancorado ao canvas (padrão Fusion): campos de W/H/ângulo editáveis durante o arraste, `Enter` confirma, `Esc` cancela. |
| TB-3 | P3 | Ferramentas de "Modify" duplicadas: existem na aba *Modify* do ribbon e na toolbar esquerda ("M…"). | Manter num único lugar (ribbon *Modificar* ▾) e no menu de contexto do canvas. |

### 4.4 Canvas / cena

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| CV-1 | P1 | **Sem estado vazio.** Um usuário novo vê mesa branca em fundo cinza e nada indica o próximo passo. | Estado vazio com 3 ações: *Importar arquivo*, *Desenhar*, *Abrir exemplo* + link "Configurar máquina". Some ao primeiro elemento. |
| CV-2 | P1 | Não há **barra de navegação** do canvas (fit mesa / fit seleção / zoom / grid / snap / mostrar posição do laser / overlay de câmera). Snap-to-grid/element estão como checkboxes de 8 px na barra de status. | Barra flutuante no rodapé central do canvas (padrão Fusion). Snap e grid viram toggles com ícone. |
| CV-3 | P1 | Nenhuma **indicação da posição atual do cabeçote** nem da origem da máquina de forma legível (há um marcador vermelho/verde no canto que não é explicado). | Reticle com rótulo "Laser: X 0.0 Y 0.0" e legenda de origem; toggle na nav bar. |
| CV-4 | P2 | Handles de seleção e linhas de cota em rosa/lilás pálidos e finos; contraste ruim sobre grid. Cotas ("309.47 mm", "7 mm") aparecem em posições estranhas ao redor de um texto. | Handles com preenchimento branco e borda de acento; cotas em chip com fundo; sempre alinhadas ao bbox. |
| CV-5 | P2 | Não há aviso visual on-canvas quando um elemento está **fora da mesa** ou **não atribuído** (só via Warning). | Contorno tracejado vermelho + badge ⚠ no elemento; item da árvore com ícone de status. |
| CV-6 | P3 | Régua e grid com números de 8 px girados; zoom inicial não é "fit mesa". | Fit mesa no load; números de régua horizontais com 10–11 px. |

### 4.5 Árvore (Operações / Elementos / Regmarks)

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| TREE-1 | P1 | Rótulos de operação crípticos: `Raster =B2T 150.0mm/s @1000`, `Engrave 20.0mm/s @1000 #0000ff00-S` (truncado), `Cut 1.0mm/s @1000 #ff000000-S`. Elementos: `Rect - #0000ff`, `Ellipse - #0000ff`. | Linha de operação = **chip de cor + nome + tipo + chips legíveis** (`20 mm/s · 100 % · 1 passe`) + badge de status. Elementos: nome do arquivo/label + ícone de tipo; cor só como chip. |
| TREE-2 | P1 | Sem **olho** (visível/oculto) nem **cadeado** por item; "Visible"/"Lock element" estão enterrados em Properties. | Colunas de olho e cadeado como no Fusion/Illustrator, clicáveis na própria árvore. |
| TREE-3 | P1 | "Classify" (atribuição automática por cor) é invisível e sem feedback: o usuário não sabe por que um elemento foi para "Engrave". Painel *Burn-Operation* tem colunas **"A S C"** sem legenda e um bloco "Classification: Leave color / Exclusive / Similar". | Renomear para **"Atribuir por cor"**, mostrar no inspector do elemento "Atribuído a: Cut (por cor vermelha)" com botão *Alterar*. Colunas com cabeçalho legível ou ícones com tooltip. |
| TREE-4 | P2 | Três ramos fixos (Operations / Elements / Regmarks) forçam scroll e não representam a hierarquia do documento (arquivos, grupos, layers). | Browser com *Operações* (topo, colapsável) e *Documento* (arquivos/grupos/layers). "Regmarks" vira um layer bloqueado especial. |
| TREE-5 | P2 | Fonte 11 px, ícones de 14 px, sem zebra/hover; barra de rolagem horizontal aparece por causa dos rótulos longos. | Linha de 26 px, fonte 12–13 px, ícones 16 px, truncamento com ellipsis + tooltip. |

### 4.6 Editor de operações e propriedades (Inspector)

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| OP-1 | P1 | Janela "Properties" da operação mostra o **template cru** no campo Label: `Cut ({percent}, {speed}mm/s)`. Tab **"RectNode"** permanece na janela da operação (estado obsoleto da seleção anterior). | Label resolvido; tabs sempre correspondem à seleção atual (bug em `propertywindow.py`). |
| OP-2 | P1 | Parâmetros sem unidade/contexto: `Kerf compensation: 0` (mm?), `Power (ppi) (100.0%) 1000.0 /1000`, `Passes` desabilitado por padrão, `Coolant: No changes`. Sem **tempo estimado** ao editar. | Formulário estruturado tipo Fusion CAM: *Tipo* → *Parâmetros* (velocidade, potência %, passes) → *Geometria* (kerf mm, direção) → *Avançado*. Estimativa de tempo recalculada ao vivo ("~4 min 20 s"). |
| OP-3 | P1 | Properties de elemento: linha de 9 botões de cor fixos (black/blue/green/red/cyan/magenta/yellow/white + Custom) em cores puras, texto "magent a" quebrado, seguida de checkbox "Immediately classify after colour change". Stroke width padrão `1.09865 pt`. | Um seletor de cor (swatch + popover com paleta do projeto); largura de traço com valor arredondado e unidade padrão da preferência; "classificar ao mudar cor" vira preferência global. |
| OP-4 | P2 | Tudo numa única página longa com scroll (Id/Label, cantos, cor, largura, join, fillrule, linestyle, tabs, lock, X/Y/W/H…). Posição/tamanho — o mais usado — ficam no fim. | Inspector com seções colapsáveis; **Transformar** (X/Y/W/H/ângulo/lock ratio) no topo; *Aparência* e *Avançado* abaixo. |
| OP-5 | P2 | Ícone da operação (raio/estrela) sem estado; bloco de cor de 86×51 px sem função clara. | Chip de cor clicável = cor de atribuição; ícone com badge de tipo. |
| OP-6 | P3 | Checkboxes misteriosas à direita de Id/Label (ver captura) sem tooltip. | Remover ou rotular ("copiar do arquivo"). |

### 4.7 Laser-Control, Navigation e execução

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| EX-1 | P0 | **Atalhos de tecla única movem o cabeçote fisicamente**: `a/d/w/s` → `+left/+right/+up/+down`, `l/u` → lock/unlock (`core/bindalias.py:70-75`). Um usuário digitando com foco no canvas move a máquina. | Remover teclas únicas para motion global; jog por teclado só com o painel Motion focado e com modificador (ex.: `Ctrl+setas`). Mostrar atalho no tooltip. |
| EX-2 | P1 | "Start" cinza + sublinhado laranja, "Pause"/"Stop" como texto plano; "Arm/Outline/Simulate" com ícones de 8 px. "Job progress: No job running" ocupa 60 % do painel. | Barra de job (RB-1). Progresso como barra + tempo restante + operação atual; Pause/Stop com ícone e cor semânticos. |
| EX-3 | P1 | Janela **Navigation**: 3 grids de 9 botões de 70 px (jog, enquadrar cantos, transformar objeto) + Short pulse + Move to + Object dimensions. Mistura *mover a máquina* com *transformar o objeto*, dois modelos mentais opostos, no mesmo layout. | Separar: **Motion** (jog, home, ir para, pulso, enquadrar) no workspace *Executar*; **Transformar** no inspector do elemento. |
| EX-4 | P2 | Spooler e Controller são janelas separadas com tabelas; o usuário não vê "fila de jobs" na tela principal. | Fila no painel *Executar* (lista compacta: nome, tempo, status) com detalhes por clique. |
| EX-5 | P2 | Simulation abre janela separada de 706×755, canvas cinza sem régua, tabela de números com **duas colunas sem cabeçalho** (`51.33 m / 51.37 m`, `0:09:16 / 0:10:00`), botão "Send to Laser" gigante, toggle "<" sem rótulo. | Simulação como **modo do canvas principal** (scrubber no rodapé, timeline de operações coloridas, estatísticas em card). "Enviar" volta para a barra de job. |

### 4.8 Barra de status

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| ST-1 | P1 | 16 chips **C1 C2 C3 E1…E9 R1…R4 >** em vermelho/azul/verde com texto de 8 px. Nada explica que são operações padrão para atribuir. | Substituir por "Atribuir a ▾" no inspector/menu de contexto com nomes reais das operações. Se ficar na status bar, chips com nome (`Cut 10 mm/s`) e tooltip. |
| ST-2 | P2 | Coordenadas X/Y/W/H em campos de 57×18 px com fonte de 8 px; "Snap to Grid"/"Snap to Element" ilegíveis; ícones de 12 px à direita sem função óbvia. | Status bar com 3 zonas: *estado da máquina* (conectado/idle/rodando), *cursor* (X Y), *seleção* (W×H). Snap sai para a nav bar do canvas. |

### 4.9 Preferências e configuração

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| PR-1 | P1 | 10+ abas com **overflow e setas de rolagem**; grupos aninhados 3 níveis (Laser > General > Delay hull trace); scrollbar horizontal em 525 px de largura. | Diálogo com **lista lateral** de 6 categorias (Geral, Interface, Canvas, Operações, Máquina, Avançado) + **campo de busca** que filtra opções. Aplicação ao vivo, sem botão Save. |
| PR-2 | P1 | Knobs de desenvolvedor expostos ao usuário final: "Process input while typing", "Process input while moving slider handle", "Button repeat-interval 0.5", "Ribbon: hover before description 2000 ms", "ToolTip duration 10000 ms", "Delay hull trace". | Mover para *Avançado* (colapsado por padrão) ou remover. Defaults corretos > opções. |
| PR-3 | P2 | Botões **Save / Export / Import** no rodapé sugerem que nada é aplicado até "Save", mas checkboxes aplicam ao vivo. Inconsistente. | Aplicação ao vivo + "Restaurar padrões" + Import/Export em menu ⋯. |

### 4.10 Sistema visual (UI)

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| VS-1 | P1 | **Sem escala tipográfica**: 8 px (status), 9 px (captions/abas), 11 px (árvore), 13 px (diálogos). Fonte do sistema sem hierarquia de peso. | Escala: 11 / 12 / 13 / 15 / 20 px; pesos regular/medium/semibold; nunca abaixo de 11 px. |
| VS-2 | P1 | **Sem escala de espaçamento**: paddings de 2, 3, 5, 8, 11 px misturados; StaticBoxes com bordas duplas. | Grid de 4 px (4/8/12/16/24); remover StaticBox aninhado; usar cabeçalhos de seção. |
| VS-3 | P1 | Ícones: 246 VectorIcons com espessura, grid e estilo inconsistentes (outline fino vs preenchido; 12 vs 60 px). Estado ativo mostrado só por fundo cinza. | Set único em 16/24 px, stroke uniforme, cor de acento para ativo; ícones de estado semânticos (verde ok, amarelo aviso, vermelho erro). |
| VS-4 | P2 | Cores: seleção lilás, sublinhado laranja no "Start", chips vermelho/azul/verde puros, cores puras nas swatches. Sem paleta semântica. | Tokens: `accent`, `danger`, `warning`, `success`, `surface-1/2/3`, `border`, `text-1/2/3`. Tema escuro derivado dos mesmos tokens (`themes.py` já tem a base). |
| VS-5 | P2 | Painéis AUI com gripper/caption cinza escuro de 12 px e chevrons "▾" azuis saturados em toda a toolbar. | Remover grippers de painéis fixos; chevrons neutros de 8 px. |
| VS-6 | P3 | Janela **Tips** inicial: lâmpada de 200 px, texto "aperte F11", checkbox "Automatically Update" ao lado de "Show tips at startup". | Substituir por tour de 3 passos no primeiro uso ou remover. |

### 4.11 Segurança e feedback

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| SF-1 | P0 | Ver EX-1 (teclas únicas movem a máquina). | — |
| SF-2 | P1 | Sistema de **Warnings** bom (`gui_mixins.Warnings`: fora da mesa, muito rápido, não atribuído, DPI…) mas só aparece como botão no ribbon; texto só ao clicar. | Banner inline na barra de job ("2 avisos: 1 elemento fora da mesa, 3 não atribuídos — *Ver*"), badge no item da árvore e contorno no canvas. Bloquear "Iniciar" em avisos *críticos* com confirmação explícita. |
| SF-3 | P1 | Nenhum feedback de conexão da máquina na tela principal além de "#2: Controller: Active" (8 px). | Indicador de estado no canto da barra de job: ● Conectado / ○ Desconectado / ▶ Executando + nome do device. |
| SF-4 | P2 | Ações destrutivas (Delete, Clear) sem confirmação nem feedback; o undo existe (snapshot) mas nada na UI comunica "o que" será desfeito. | Toast "Excluído · Desfazer" e tooltip do botão Undo com a descrição do último `undo.mark()` ("Desfazer: mover 3 elementos"). |

### 4.12 Acessibilidade e internacionalização

| ID | Sev | Achado | Proposta |
|---|---|---|---|
| AC-1 | P1 | Ribbon é 100 % custom-drawn: **invisível para a árvore de acessibilidade** (AX vazio), sem navegação por Tab/setas, sem nomes. Canvas idem. | Expor botões do ribbon via `wx.Accessible` ou migrar para `wx.ToolBar`/botões nativos com desenho custom mínimo. Atalhos `Alt+letra` para grupos. |
| AC-2 | P2 | Contraste: texto cinza sobre cinza (captions, desabilitados), 8 px. | Mínimo 4.5:1 e 11 px. |
| AC-3 | P3 | pt_BR presente, mas termos como *Regmarks*, *Wordlist*, *Spooler*, *Classify*, *Hull trace*, *Arm* não têm equivalente conceitual na tradução. | Glossário de produto (§6) antes de traduzir. |

---

## 5. Conceito-alvo (proposta de layout)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Design] [Preparar] [Executar] [Máquina]          ⌘K Buscar   ● K40 conectado│
├──────────────────────────────────────────────────────────────────────────────┤
│ Arquivo ▾ │ Editar ▾ │ Criar ▾ │ Modificar ▾ │ Alinhar ▾ │ Câmera ▾          │  ← ribbon contextual (≤ 8 grupos, com rótulo)
├────────┬──────────────────────────────────────────────┬──────────────────────┤
│ Tools  │                                              │ INSPECTOR            │
│ ▸ Sel. │                 CANVAS                       │ ┌ Transformar ─────┐ │
│ ▸ Rect │      (estado vazio → Importar / Desenhar)    │ │ X Y W H ∠ 🔒     │ │
│ ▸ Elip.│                                              │ └──────────────────┘ │
│ ▸ Texto│   ┌─ diálogo de comando (Retângulo) ─┐       │ ┌ Operação ────────┐ │
│ ▸ Imag.│   │ W [60] H [40] raio [0] ✓ ✗       │       │ │ ● Cut · 10mm/s   │ │
│  …     │   └──────────────────────────────────┘       │ │   100 % · 1 passe│ │
│        │                                              │ │  Alterar ▾       │ │
│        │                                              │ └──────────────────┘ │
│        │                                              │ ┌ Aparência ▾ ─────┐ │
├────────┤  ⌂ fit │ ⤢ sel │ ⊞ grid │ ⌖ snap │ ✛ laser  │ BROWSER              │
│        │        (nav bar do canvas)                   │ ▾ Operações          │
│        │                                              │   ● Cut   10mm/s ⚠ 👁│
│        │                                              │   ● Engrv 200mm/s 👁 │
│        │                                              │ ▾ Documento          │
│        │                                              │   ▸ caixa.svg   👁 🔒│
├────────┴──────────────────────────────────────────────┴──────────────────────┤
│ ⚠ 2 avisos · Ver   │  ~ 4 min 20 s  │ [Enquadrar] [Simular]  [▶ Iniciar] [■]│  ← barra de job
└──────────────────────────────────────────────────────────────────────────────┘
```

**Workspaces:**

- **Design** — ferramentas de criação/edição, inspector de elemento, browser. Sem nada de máquina além do indicador de conexão.
- **Preparar** — browser com foco nas operações; editor de operação estruturado (Tipo → Parâmetros → Geometria → Passes → Avançado); biblioteca de materiais integrada ("Aplicar preset ▾"); otimização como seção colapsada; tempo estimado ao vivo.
- **Executar** — canvas em modo simulação (scrubber, timeline por operação), painel *Motion* (jog, home, ir para, enquadrar, pulso), fila de jobs, câmera. Barra de job em destaque.
- **Máquina** — device manager, portas/conexão, tamanho da mesa e origem com preview, calibração de câmera, rotary, preferências específicas do driver.

**Elementos transversais:** paleta de comandos (`Ctrl+K`, reaproveita o console), menu de contexto rico no canvas e no browser, toasts com *Desfazer*, tooltips com atalho, tema claro/escuro paritário.

---

## 6. Glossário de produto (renomeações propostas)

| Termo atual | Problema | Proposta (en) | Proposta (pt-BR) |
|---|---|---|---|
| Classify | Jargão interno; ação opaca | Assign by color | Atribuir por cor |
| Regmarks | Abreviação obscura | Registration marks (layer locked) | Marcas de registro |
| Emphasized / Highlighted / Targeted | Três estados de seleção sem UI própria | Selected / Hover / Focus | Selecionado / Sob cursor / Foco |
| Arm | Sem explicação | Laser armed (toggle) / Hold to start | Laser armado / Segure para iniciar |
| Outline | Ambíguo (contorno do desenho?) | Frame (trace boundary) | Enquadrar |
| Spooler | Termo de impressora | Job queue | Fila de trabalhos |
| Controller | Genérico | Machine connection | Conexão da máquina |
| Wordlist | Não descreve o recurso | Variables (text merge) | Variáveis de texto |
| Hull trace | Interno | Frame convex hull | Enquadrar contorno |
| Plan / Blob / Preopt | Pipeline interno | (não exposto) | — |
| Burn-Operation | Redundante | Operations | Operações |
| Material: Load preset | Sem contexto | Material preset | Preset de material |
| Op labels `=B2T @1000` | Cifra | chips legíveis | chips legíveis |

---

## 7. Roadmap de implementação

Cada fase entrega valor isolado e é mergeável. Estimativas em dias-pessoa (dp) para
alguém familiarizado com wxPython e a base do MeerK40t.

### Fase 0 — Correções e quick wins (≈ 8 dp) · *sem mudança de layout*

| Tarefa | Arquivos | dp |
|---|---|---|
| Corrigir crash `window close` (passa resultado de `close()` ao `wx.CallAfter`) | `gui/wxmeerk40t.py:913` | 0,5 |
| Import de `cv2` protegido em `scene.py` (crash sem OpenCV) | `gui/scene/scene.py:813`, `camera/camera.py` | 0,5 |
| Compatibilidade wxPython 4.3 (AUI notebook exige page filho) | `gui/wxmtree.py:117` e demais `AddPage` | 1 |
| Remover atalhos de tecla única para motion (`a/d/w/s/l/u`) | `core/bindalias.py` | 0,5 |
| Label de operação: resolver template `{percent}` na UI; tab obsoleta ("RectNode") na janela de operação | `gui/propertypanels/propertywindow.py`, `operationpropertymain.py` | 1 |
| Rótulos de operação/elemento legíveis na árvore (chips de texto: `Cut · 10 mm/s · 100 %`) | `core/node/op_*.py` (`label`), `gui/wxmtree.py` | 1 |
| Captions truncadas ("To…", "M…", "Ribbon") e fonte mínima 11 px em status bar | `gui/wxmmain.py`, `gui/statusbarwidgets/*` | 1 |
| Tooltip de Undo/Redo com a descrição do último `undo.mark()` | `gui/wxmmain.py` (listener `undoredo`), `core/undos.py` | 0,5 |
| Unidades e ajuda inline em kerf, potência, passes | `gui/propertypanels/operationpropertymain.py` | 1 |
| Ocultar aba "Plan" e "Move" do Laser-Control por padrão (atrás de flag de desenvolvedor) | `gui/laserpanel.py` | 0,5 |
| Preferências: mover knobs de dev para seção "Avançado" colapsada | `gui/preferences.py`, `choicepropertypanel.py` | 0,5 |

### Fase 1 — Sistema visual e ribbon (≈ 20 dp)

| Tarefa | Arquivos | dp |
|---|---|---|
| Tokens de design (cores semânticas, escala tipográfica, espaçamento 4 px) centralizados; tema escuro derivado | `gui/themes.py`, `gui/guicolors.py`, `gui/wxutils.py` | 3 |
| Novo set de ícones 16/24 px com stroke uniforme; estados ativo/desabilitado por token | `gui/icons.py` (SVG), `gui/ribbon.py` | 6 |
| Ribbon: grupos com rótulo, botão primário + dropdown, ≤ 8 grupos por aba; abas com 13 px e indicador de ativo | `gui/wxmribbon.py`, `gui/ribbon.py` | 5 |
| Barra de job (Enquadrar / Simular / ▶ Iniciar / ■ Parar / tempo / avisos / conexão) | novo `gui/jobbar.py`; remove botões de execução do ribbon; `laserpanel.py` | 4 |
| Toolbar esquerda única de 40 px, ícones 24 px, rótulo de modo no canvas | `gui/toolwidgets/toolcontainer.py`, `gui/wxmscene.py` | 2 |

### Fase 2 — Reestruturação de layout (≈ 30 dp)

| Tarefa | Arquivos | dp |
|---|---|---|
| Inspector dockado à direita (Transformar / Operação / Aparência / Avançado), substitui janela Properties e abas Burn-Operation/Details | novo `gui/inspector.py`; refatorar `propertypanels/*` em seções reutilizáveis | 8 |
| Browser unificado com olho/cadeado, badges de status, seções Operações/Documento; menu de contexto | `gui/wxmtree.py`, `core/node/*` (flags) | 6 |
| Nav bar do canvas (fit/zoom/grid/snap/laser/câmera); estado vazio | `gui/wxmscene.py`, `gui/scenewidgets/*` | 4 |
| Painel Motion (jog + ir para + enquadrar + pulso) dockado no workspace Executar; remover janela Navigation e abas Jog/Move | `gui/navigationpanels.py`, `gui/laserpanel.py` | 4 |
| Workspaces (Design/Preparar/Executar/Máquina) como troca de perspectiva AUI + ribbon contextual | `gui/wxmmain.py` (`__set_panes`, perspectives), `gui/wxmribbon.py` | 6 |
| Preferências com lista lateral + busca + aplicação ao vivo | `gui/preferences.py`, `gui/choicepropertypanel.py` | 2 |

### Fase 3 — Fluxo de preparação e execução (≈ 25 dp)

| Tarefa | Arquivos | dp |
|---|---|---|
| Editor de operação estruturado (Tipo → Parâmetros → Geometria → Passes → Avançado) com tempo estimado ao vivo | `propertypanels/operationpropertymain.py`, `core/cutplan.py` (estimativa incremental) | 6 |
| Materiais integrados ao editor ("Aplicar preset ▾", "Salvar como preset") | `gui/materialmanager.py` → serviço + popover | 4 |
| Simulação como modo do canvas (scrubber, timeline por operação, estatísticas em card) | `gui/simulation.py` → `scenewidgets/simulationwidget.py` | 8 |
| Avisos inline (banner na barra de job, badge no browser, contorno no canvas); bloqueio com confirmação para críticos | `gui/gui_mixins.py` (Warnings), `wxmtree.py`, `scenewidgets/elementswidget.py` | 3 |
| Diálogos de comando para ferramentas de criação (W/H/raio inline, Enter/Esc) | `gui/toolwidgets/tool*.py` | 4 |

### Fase 4 — Onboarding, paleta, acessibilidade (≈ 15 dp)

| Tarefa | Arquivos | dp |
|---|---|---|
| Wizard de primeira máquina (tipo → conexão → mesa/origem → teste de movimento) | `gui/devicepanel.py` → `gui/devicewizard.py` | 5 |
| Paleta de comandos `Ctrl+K` sobre o console (busca de comandos, ações do ribbon, preferências) | novo `gui/commandpalette.py`, `kernel` (help metadata) | 3 |
| Acessibilidade do ribbon (nomes AX, navegação por teclado) | `gui/ribbon.py` | 4 |
| Glossário aplicado + revisão de `locale/pt_BR` | `locale/*` | 2 |
| Remover janela Tips; tour de 3 passos opcional | `gui/tips.py` | 1 |

**Total aproximado: ~100 dp.** As fases 0 e 1 já mudam radicalmente a percepção de
qualidade sem tocar na arquitetura de painéis.

---

## 8. Bugs de robustez encontrados durante a análise

Reproduzidos em macOS 15.6 / Python 3.12 / wxPython 4.2.3 e 4.3.1:

1. **wxPython 4.3.1**: crash na inicialização — `wxAssertionError: page must be a child
   of the notebook` em `gui/wxmtree.py:117` (`notetab.AddPage(basic_op, …)`). O painel é
   criado com parent errado. Bloqueia qualquer instalação com wx recente.
2. **Sem OpenCV**: `ModuleNotFoundError: No module named 'cv2'` em
   `gui/scene/scene.py:813` (`from meerk40t.camera.camera import
   composite_bed_photo_on_device_dc`) derruba o app no primeiro refresh da cena. O log
   até avisa "OpenCV is not installed. Disabling Camera." — mas a cena não respeita isso.
3. **`window close <nome>`** derruba o app: `gui/wxmeerk40t.py:913` faz
   `wx.CallAfter(path.close(...), None)` (chama `close` e passa o retorno `None` como
   callable). Qualquer comando de console com erro não tratado encerra o processo inteiro
   — não há contenção de falhas na camada de UI.
4. **`python.app` (Anaconda)**: segfault em `core/wordlist.py:608` (`wordlist_datestr`)
   ao iniciar — provavelmente `time.strftime` com locale; não investigado a fundo, mas
   vale um `try/except` com fallback.

Recomendação transversal: envolver `console()` chamado a partir da GUI em um
`try/except` que reporte para um toast/log em vez de propagar até o crash handler.

---

## 9. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Rejeição da comunidade a mudanças de layout (usuários com memória muscular) | Fases 0–1 são compatíveis; a partir da Fase 2, oferecer perspectiva "Clássica" por 2 releases; comunicar via changelog com GIFs. |
| Limitações de wxPython/AUI para inspector e nav bar flutuante | Já existe custom drawing extensivo (ribbon, scene). Nav bar = `wx.Panel` sobreposto ao `ScenePanel`; inspector = `wx.ScrolledWindow` com seções. Provar em spike de 2 dp antes da Fase 2. |
| Tradução (12 idiomas) desatualizada com renomeações | Glossário primeiro; `translate_check.py` no CI; aceitar strings em inglês temporariamente. |
| Plugins externos que registram botões em `button/...` | Manter o registro; grupos novos mapeiam os antigos por tabela de compatibilidade em `wxmribbon.py`. |
| Regressão em drivers por mudanças no `label` dos nós | Labels são só de apresentação; testar `test_node_*`. |

---

## 10. Como medir sucesso

| Métrica | Hoje (estimado) | Meta |
|---|---|---|
| Tempo até o primeiro corte (usuário novo, máquina já conectada) | > 20 min com documentação | < 5 min sem documentação |
| Cliques para alterar velocidade/potência de uma operação | 4 (selecionar → Property Window → localizar campo → editar) | 1–2 (inspector visível) |
| Erros de execução evitáveis (fora da mesa, não atribuído) por sessão | frequentes (só Warning global) | bloqueio/aviso inline antes de Iniciar |
| SUS (System Usability Scale) com 8 operadores | ~45 (estimado) | ≥ 70 |
| Reconhecimento de ícones (teste de 5 s, 20 ícones) | ~50 % | ≥ 85 % |
| Crash por sessão em ambiente limpo | 3 encontrados em 30 min | 0 |

Validação por fase: 5 sessões de teste moderado (think-aloud) com os fluxos F1, F2, F4 e
F5 do §2, antes e depois de cada fase; comparar tempo, erros e SUS.

---

## 11. Próximos passos imediatos (esta branch)

1. Abrir issues/PRs para os 4 bugs do §8 (Fase 0, ~3 dp) — ganhos imediatos e sem
   controvérsia.
2. Spike de 2 dp: protótipo do **inspector dockado** + **barra de job** em wxPython para
   validar viabilidade técnica com a arquitetura AUI atual.
3. Produzir mockups de média fidelidade dos 4 workspaces (§5) para discussão com a
   comunidade antes de codar a Fase 2.
4. Definir os tokens de design (§7 Fase 1) em `themes.py` como fonte única de verdade.
