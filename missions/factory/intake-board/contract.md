# Validation Contract — intake-board

> Author: coordinator (Opus). Reader: the held-out validator.
> Written BEFORE any code. The validator gets ONLY this file and the mission diff.

## Definition of done

Um requisito que o Tenant A falou num áudio é rastreável, **na tela publicada**, até o veredito
da missão que o construiu — e um requisito que ninguém despachou diz isso de si mesmo em vez de
ficar invisível. O engine não ganha nenhum literal de produto no caminho, e o `intake.py` some
sem levar junto nenhuma capacidade.

## Assertions

| id | Assertion (comportamento observável) | Prova |
|----|--------------------------------------|-------|
| I1 | `parseIntake(text)` devolve uma linha por `\| IN-NN \|` da tabela, com as 6 colunas separadas; uma célula contendo `\|` escapado chega **inteira** em um único campo (nunca vira duas colunas) | `scripts/intake-report.test.mjs` |
| I2 | Roundtrip: `writeRow(text, id, fields)` seguido de `parseIntake` devolve `fields` verbatim, inclusive um `\|` literal no meio de uma célula (re-escapado na escrita) | idem |
| I3 | Um bloco `### IN-35 + IN-40` do `# Detalhamento técnico` é anexado aos **dois** ids, e ambos são marcados `shared: true` | idem |
| I4 | `detailBlockSpan(lines, id)` devolve `null` para bloco compartilhado e o span exato `[start,end)` para bloco exclusivo — o `end` para **antes** do próximo heading de qualquer nível | idem |
| I5 | `deleteRow(text, "IN-35")` remove a linha da tabela e **preserva** o bloco de Detalhamento (compartilhado com IN-40). `deleteRow(text, "IN-44")` remove linha **e** bloco, sem comer o `### IN-45` seguinte nem o `## §2` final | idem |
| I6 | Nada em `intake-report.mjs` lança: arquivo ausente, markdown sem tabela, sem seção de Detalhamento, ou heading `###` sem id → `{rows: [], details: {}}` ou lista parcial, nunca throw | idem |
| I7 | `resolveProject({project}).profile.intake` é um array de `{file, prefix, label}` com `file` **absoluto**; profile sem o campo, ou com o campo corrompido, → `[]` (o resolver continua TOTAL) | `scripts/project-profile.test.mjs` |
| I8 | Toda entrada `intake[]` de todo profile em disco tem `file` string não-vazia e relativa, e `prefix` casando `/^[A-Z]+$/`. A existência do arquivo é asserida no checkout principal e `t.skip`ada dentro de um worktree (o `path` relativo sub-resolve — D-27), com um motivo que não mente | idem |
| I9 | O modelo do board ganha `intake.rows` e a cadeia: para cada `IN-NN`, os ids de backlog cujas células "Porquê / fonte" o citam. `IN-33` → `["C3"]`; `IN-39` → `["C7"]`; um `IN` não citado → `[]` | `scripts/board-report.test.mjs` |
| I10 | O HTML renderizado para um projeto **com** `intake` traz `data-tab="intake"` exatamente uma vez, um card por linha do intake, e o breadcrumb `IN-33 → C3 → sdr-nonlead-gate` com o veredito da missão | idem + render real |
| I11 | O HTML renderizado para um projeto **sem** `intake` (`factory`, `tenant-c`) **não** traz `data-tab="intake"` nem painel de intake. Nenhuma aba vazia | idem |
| I12 | Todo texto vindo do `.md` é escapado antes de qualquer transformação: um `<script>` numa célula de Resumo aparece como texto no HTML, e um `**` desbalanceado não abre tag pendurada (mesma invariante de `renderInline`) | idem |
| I13 | `intake-server.mjs` faz bind em `127.0.0.1` e em nenhuma outra interface | leitura + `scripts/intake-server.test.mjs` |
| I14 | `POST /row/:id` cria `<arquivo>.bak` **antes** de escrever, e o `.bak` contém o conteúdo anterior byte a byte | idem |
| I15 | `GET /` do servidor local e a aba do board publicado saem do **mesmo** `renderIntakeTab()` — um parser, um renderer (nenhuma segunda implementação) | grep: um único caller-side import; `intake.py` deletado |
| I16 | O engine continua sem literais de produto (`scripts/`, `templates/`, `skills/`), com o caminho do intake vivendo só em `projects/wahub/project.json` | `scripts/project-profile.test.mjs:255` (meta-teste) |
| I17 | A contagem de testes **cresceu** e nenhuma asserção foi apagada. Baseline: **493 testes / 489 pass / 0 fail / 4 skip** | `pnpm test` comparado ao baseline |

## Explicitamente FORA desta missão (dito, para que o silêncio não seja lido como cobertura)

- `mission:ratify` NÃO passa a escrever no `requirements-intake.md`. A linha `IN` continua sendo
  virada para `Landed` à mão, pela skill `tenant-a-intake`. Escrita cruzada de repo a partir do
  ratify é decisão própria, não efeito colateral desta missão.
- Nenhum write a partir do VPS. A publicação continua `rsync` de uma projeção estática (D-08).
- O intake do CIPE e o do CIDS **não** são declarados em profile nenhum e portanto não são
  parseados nem publicados. Isso é o controle, não um esquecimento.
- Nenhuma dependência de runtime nova (`marked` incluso). O engine segue com `backlog.md` como
  única devDep.

## House-standard gate

- `pnpm test` a partir da raiz da fábrica sai 0 (`FACTORY_ROOT` ancorado no checkout principal).
- `node scripts/board-autopublish.mjs --dry-run` renderiza sem erro e mostra a aba.
