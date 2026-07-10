# Mission Brief — intake-board (a aba Intake e a cadeia requisito→veredito)

**Requirements:** none

> Provenance: plano escrito pelo **Fable 5** em 2026-07-09 (íntegro em `plan-fable5.md`),
> refinado contra o código e ratificado pelo André no mesmo dia. Missão de engine
> (`--project factory`), dogfood: a fábrica constrói a própria tela.

## Quem isto serve

- **André.** Hoje ele valida requisito em `clients/tenant-a/intake-viewer/intake.py` (app
  Python à parte, rodado à mão) e rastreia build em `factory.example.com`. Duas telas, dois
  parsers, dois visuais. Vira uma.
- **Tenant A.** Tem login no board (basic-auth). Passa a ver o próprio funil — o que ele falou
  num áudio, em que linha de backlog aquilo virou, qual missão está construindo, e qual foi o
  veredito — sem pedir status a ninguém.

## O buraco concreto

A cadeia `IN-39 → linha C7 do backlog → missão → veredito` existe hoje **só na prosa** da
coluna "Porquê / fonte". `REQ_ID_RE = /^[A-D]\d+$/` (`board-report.mjs:47`) é o único join
que um script lê; nenhum script lê `IN-NN`. O board publicado enxerga apenas a metade que vai
de `C7` pra frente — a origem do requisito não existe para a máquina.

## O que muda

1. **`scripts/intake-report.mjs`** — parser puro do `requirements-intake.md`: linhas da tabela
   (células com `\|` escapado) e os blocos `### IN-NN` do `# Detalhamento técnico`, inclusive os
   compartilhados (`### IN-35 + IN-40`).
2. **`profile.intake[]`** — a fonte é declarada em `projects/<id>/project.json`, nunca no engine
   (D-15; o meta-teste de `project-profile.test.mjs:255` falha o build se um id de produto
   aparecer em `scripts/`).
3. **Aba "Intake"** no `board-report.mjs`, com a cadeia completa. Um `IN` que nenhuma linha de
   backlog cita renderiza **"não despachado"** — o substituto honesto da coluna "Aterrissou em"
   escrita à mão. Sem `intake` no profile, **não há aba**: é a prova de que o engine continua
   agnóstico de produto.
4. **`pnpm intake`** — servidor local (`127.0.0.1`, `node:http`, zero dependência) que reusa o
   MESMO renderer e escreve de volta no `.md` com `.bak`. Aposenta o `intake.py`.

## Decisão difícil de reverter (ratificada por André, 2026-07-09)

O board publicado passa a servir **conteúdo de cliente**: as linhas de engajamento
(`business-decision`) e o `# Detalhamento técnico` — que é revisão de código interna, com as
armadilhas e as críticas. Basic-auth é o único controle. Só o intake do WaHub é declarado;
`cipe-plataforma/` e o CIDS São Leopoldo ficam **fora** (o CIPE é confidencial por contrato,
cl. 4). → linha `D-NN` em `decisions.md`.

## Fora de escopo

- `mission:ratify` virar o Status de uma linha `IN` para `Landed` automaticamente. O intake é
  append-only por regra da skill `tenant-a-intake`; escrita cruzada de repo merece decisão própria.
- Qualquer write a partir do VPS. A projeção continua estática e read-only (D-08).
- Adicionar um parser markdown genérico (`marked`) — quebraria a invariante "escapa primeiro,
  transforma depois" de `renderInline()` e seria a primeira dependência de runtime do engine.

## Armadilhas conhecidas

- **Worktree (D-27).** Dentro de `.worktrees/<slug>/` o `FACTORY_ROOT` vira o worktree e todo
  `path` relativo do profile sub-resolve (`../../products/wahub` some). Esta missão é construída
  no checkout principal, na branch `agent/intake-board`.
- **`parseBacklogTables` divide em `|` cru** (`board-import-backlog.mjs:52`). O parser do intake
  **não** pode reusá-lo: as células do intake carregam `\|` escapado.
- **Delete de bloco compartilhado.** Apagar `IN-35` não pode levar junto o Detalhamento do
  `IN-40`: o span só é removido quando o bloco pertence a um único id.
