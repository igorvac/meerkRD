# CLAUDE.md

As instruções para agentes de código estão em [AGENTS.md](AGENTS.md) — leia-o
inteiro antes de começar. O que segue é específico de sessões com Claude Code.

- Responda ao usuário em **português do Brasil**; código, identificadores e
  mensagens de commit em inglês.
- Trabalhe na branch `main` (padrão do fork `igorvac/meerkRD`). Commite ao
  concluir cada feature; **não** faça push nem altere o remote sem pedido.
- Servidor de preview: `.claude/launch.json` (`rd-service`, porta 8765, usa
  `.venv/bin/python`). Se a porta estiver ocupada por um servidor que o usuário
  subiu no terminal, não o mate — valide numa porta alternativa ou peça para
  reiniciar. Mudanças em `service/api/main.py` só entram com reinício.
- Ao validar no navegador embutido: navegue com um parâmetro de query novo
  (`?v=N`) para forçar o `app.js` atualizado; coordenadas de clique seguem o
  frame da última captura.
- Rode `.venv/bin/python -m pytest tests` antes de commitar mudanças no motor,
  no serviço ou no nesting; `node --check service/web/app.js` para o front.
- O usuário testa em uma laser CO2 Ruida real. Tudo que afeta coordenadas,
  header do `.rd` ou modo âncora precisa de comparação com um `.rd` do RDWorks
  antes de ser dado como certo — e de aviso explícito quando não foi testado em
  hardware.
- Funcionalidade nova: implemente com a correção de usabilidade embutida
  (estado visível, ação seguinte óbvia, aviso antes de descartar trabalho
  manual), verifique ao vivo, atualize `docs/SERVICE.md` se o contrato mudou.
