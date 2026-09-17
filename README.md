# meerkRD

**Do desenho ao arquivo da laser, no navegador.** Envie um ou mais DXF/SVG, ajuste
velocidade e potência, clique nas formas para separar corte de gravação e baixe um
`.rd` pronto para o pendrive de uma máquina com controlador Ruida. Sem instalar
nada no computador do usuário, sem cabo USB, sem conhecer o MeerK40t.

> **Beta.** O `.rd` gerado é comparado byte a byte com arquivos do RDWorks e o
> posicionamento (modo âncora) foi validado com o *frame* numa máquina real, mas o
> projeto ainda está em teste em laboratório. Confira o *frame* no painel da
> máquina antes de cortar material caro.

## Um fork do MeerK40t — e por quê isso importa

Este projeto é um **fork do [MeerK40t](https://github.com/meerk40t/meerk40t)**, o
software livre de controle de lasers criado por Tatarize e mantido por uma
comunidade de dezenas de pessoas. Tudo que acontece com o desenho — importar o DXF,
planejar o percurso, otimizar a ordem de corte, gerar o raster e escrever o arquivo
`.rd` com o protocolo Ruida — é feito pelo **motor do MeerK40t**, inalterado no que
importa. O meerkRD é uma camada em cima dele: uma interface web pensada para quem
só quer cortar uma peça, e um serviço que roda o motor sem janela.

Isso só é possível porque o MeerK40t é **open source, sob licença MIT**. Anos de
engenharia reversa do protocolo Ruida, de correção de bugs em controladores reais
e de trocas em fóruns estão embutidos em cada arquivo que este projeto gera. Se
você usa o meerkRD, está usando o trabalho dessa comunidade — considere
[apoiar o MeerK40t](https://github.com/meerk40t/meerk40t) e devolver o que
aprender. As poucas mudanças feitas no motor (o modo âncora do Ruida, a correção
do `save_job`, um ajuste no importador DXF) estão documentadas para que possam
voltar para o projeto original.

O meerkRD continua **MIT** ([LICENSE](LICENSE)): use, copie, modifique e
redistribua, mantendo o aviso de copyright do MeerK40t e deste projeto.

## Feito com vibe coding

O código do serviço, da interface e da adaptação do motor foi escrito em sessões
de *vibe coding* com os modelos **Claude** (Anthropic), a partir de uma revisão
crítica de UX da interface original do MeerK40t e de testes numa laser CO2 real.
As decisões de produto, os testes na máquina e a direção do projeto são humanos; a
digitação, em grande parte, não. Os arquivos [AGENTS.md](AGENTS.md) e
[CLAUDE.md](CLAUDE.md) existem para que novas sessões de agentes de código
continuem o trabalho com o mesmo contexto.

## Como funciona

```
navegador ──HTTP/JSON──▶ FastAPI ──subprocess──▶ MeerK40t headless ──▶ job.rd
 (service/web)          (service/api)            (service/core/mk_job.py)
```

1. **Peças.** O usuário envia arquivos; cada um vira uma peça com quantidade e
   opção de girar 90°. Cada peça é analisada num subprocesso do motor (tamanho,
   layers, número de formas).
2. **Nesting.** Um empacotador por retângulo delimitador (`service/core/nesting.py`,
   Python puro) posiciona todas as cópias na mesa da máquina escolhida. O motor
   carrega o layout completo e devolve um SVG de pré-visualização com um id
   estável por forma.
3. **Operações por cor.** Layers `CUT`/`ENGRAVE`/`RASTER` viram operações
   automaticamente; os demais são separados por cor. Na barra de cores embaixo do
   desenho, clicar numa forma e depois numa cor move a forma para aquela operação
   (ou cria uma nova). Velocidade, potência, passes, kerf e DPI são editados por
   operação, com presets por material.
4. **Geração.** Um subprocesso recarrega as mesmas peças na mesma ordem, aplica as
   atribuições, planeja e otimiza o percurso e grava `job.rd`, o percurso em SVG
   e as estatísticas (tempo, distância, avisos).
5. **Download.** O `.rd` vai para o pendrive. A máquina só precisa de "Origem" no
   painel (modo âncora, igual ao RDWorks) e "Iniciar".

Cada job roda num **processo novo** do MeerK40t: um crash do motor não derruba o
servidor e nada vaza entre trabalhos. O estado é JSON em disco (`service/data/`),
sem banco de dados.

## Stack

| Camada | Tecnologia | Onde |
|---|---|---|
| Motor | MeerK40t (Python), enxuto: kernel, core, driver Ruida, loaders DXF/SVG/LightBurn/xTool, raster | `meerk40t/` |
| Serviço | FastAPI + pydantic, uvicorn, workers em `ThreadPoolExecutor`, um subprocesso por job | `service/api`, `service/core` |
| Nesting | Shelf packing por bounding box, sem dependências | `service/core/nesting.py` |
| Interface | HTML + CSS + JavaScript puro (ES modules), sem build; tokens de design em `styles.css` | `service/web` |
| Persistência | JSON em disco por job; perfis de máquina e presets em `service/seed` | `service/data/` |
| Testes | pytest: suíte do MeerK40t para o que ficou do motor + suíte do serviço | `tests/` |

Dependências Python: `numpy`, `Pillow`, `ezdxf`, `pyusb`, `pyserial` (motor);
`fastapi`, `uvicorn`, `pydantic`, `python-multipart` (serviço).

## Rodar

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r service/requirements.txt
uvicorn service.api.main:app --host 127.0.0.1 --port 8765
```

Abra <http://127.0.0.1:8765>. "Usar exemplo" carrega uma peça com três layers.
Para expor na rede do laboratório: `--host 0.0.0.0` e defina `RD_API_KEY`.

```bash
python -m pytest tests
```

Referência completa da API, variáveis de ambiente, contrato de parâmetros e
limitações conhecidas: [docs/SERVICE.md](docs/SERVICE.md).

## Estrutura

```
meerkRD/
├── meerk40t/     motor (fork enxuto do MeerK40t; árvore completa na tag antes-da-limpeza)
├── service/
│   ├── api/      FastAPI: jobs, peças, nesting, perfis, presets, download
│   ├── core/     mk_job.py (roda dentro do subprocesso), runner.py, nesting.py, headless_raster.py
│   ├── web/      interface (index.html, app.js, styles.css, icons.js, exemplo.dxf)
│   ├── seed/     perfis de máquina e presets iniciais
│   └── data/     jobs e configurações em tempo de execução (não versionado)
├── tests/
│   ├── engine/   suíte do MeerK40t para kernel, core, Ruida e DXF
│   └── service/  nesting, núcleo multi-peça e API HTTP
└── docs/         SERVICE.md (referência), planos de UX e do serviço
```

## Limitações conhecidas

- Só Ruida. Outros controladores foram removidos do fork; o motor original os
  suporta.
- Nesting por retângulo delimitador, numa única chapa — não é nesting irregular.
- Texto em DXF/SVG não é gravado (precisa de fontes que só a GUI renderiza);
  converta em curvas no CAD.
- Testado em uma máquina. Relate o que encontrar.
