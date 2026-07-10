# Plano B — Intake integrado ao factory.example.com

> **Autoria: Fable 5** (modelo), sessão de 2026-07-09 com André.
> Texto preservado como escrito, antes do refino contra o código. É o registro do
> raciocínio original; a versão executada está em `brief.md` + `contract.md`.
> Salvo aqui a pedido do André: *"salve esse super plano em algum lugar, ele foi
> escrito pelo fable5"*.

## Contexto e problema

O `intake-viewer/intake.py` resolveu o dia (validação em uma passada) mas é uma ilha:
parser Python separado, visual próprio, roda à mão, e não conversa com o dashboard. O
André quer UMA experiência: ver requisito → linha do backlog → missão → veredito no mesmo
lugar (factory.example.com), sem app meia-boca paralelo.

## Fatos que moldam o design (verificados, com file:line)

- O dashboard é uma **projeção estática read-only** (filosofia D-08: disco é canônico;
  "se está errado, conserta o disco"). Renderer: `scripts/board-report.mjs`; publicação:
  `board-autopublish.mjs` (hash-guard + rsync), disparada por hooks git e por
  verdict/ratify. Basic-auth no VPS (`deploy/DEPLOY-VPS.md`).
- Join atual: brief `**Requirements:** C3` ↔ linhas A–D do PRD (`REQ_ID_RE=/^[A-D]\d+$/`,
  `board-report.mjs:47`). Tokens fora da forma são descartados em silêncio.
- `IN-NN` hoje é só prosa na coluna Porquê do backlog e em blocos de proveniência dos
  briefs — **nenhum script lê**. A cadeia IN→linha→missão existe semanticamente, não no render.
- O intake vive em `clients/tenant-a/*.md` (3 arquivos, prefixos IN/CIDS/CIPE), fora dos
  repos que o funil lê hoje. Conteúdo é sensível de cliente → só atrás do basic-auth.
- Perfis: todo fato per-projeto vai em `projects/<id>/` (D-15); editar `scripts/` para
  fato de produto falha o meta-teste de conformidade.

## Forma recomendada (decisão de engenharia; o Opus refina no /mission-plan)

**Leitura no dashboard publicado; escrita continua local-first.** Nunca dar write ao VPS
— manteria a projeção estática e a filosofia disco-canônico.

1. **F1 — `scripts/intake-report.mjs`**: port do parser Python (células com `\|`, blocos
   `### IN-NN` do Detalhamento, blocos compartilhados `IN-35 + IN-40`) → JSON. Fonte
   declarada em novo campo do profile (ex. `projects/wahub/project.json`:
   `"intake": [{"file": "<path clients/tenant-a/requirements-intake.md>", "prefix": "IN"}]`)
   — fato no profile, nunca no engine (D-15). Testes de conformidade estendidos.
2. **F2 — aba "Intake" no dashboard** (`board-report.mjs`): cards por dia/status/tipo como
   o viewer local, Detalhamento expandível, e a **cadeia completa**: IN-NN → linha do
   backlog (novo scan de `\b(IN|CIDS|CIPE)-\d+\b` na coluna Porquê) → missão (join
   existente) → veredito. Um IN citado por nenhuma linha aparece "não despachado" — o
   substituto honesto da coluna "Aterrissou em".
3. **F3 — edição local com a MESMA cara**: `pnpm intake` sobe um servidorzinho Node local
   que reusa o renderer do F2 + write-back nos `.md` (com `.bak`), aposentando o
   `intake.py`. Um parser, um visual; o que o André edita localmente aparece publicado no
   próximo autopublish.
4. **F4 — publicação**: o funil re-renderiza quando o intake muda (hash-guard já absorve;
   avaliar hook no repo `clients` ou re-render por timestamp). Sensibilidade: confirmar
   basic-auth obrigatório na rota antes de publicar conteúdo de cliente.
5. **Stretch (só se barato)**: `mission:ratify` flipa o Status da linha IN citada →
   `Landed` automaticamente (fecha o ciclo sem toque manual).

## Como despachar o Plano B

É trabalho de **engine da fábrica** → missões `--project factory` (perfil existe; a
extração v2.2 provou onboarding sem tocar engine — aqui é feature de engine mesmo, com
gate `pnpm test` do repo factory). Uma missão, 4 features (F1→F4 serial-ish; F1 destrava
F2/F3 em paralelo). Intent de uma linha para o Opus lead:
`/mission-plan --project factory "intake tab: parse clients-side requirements-intake.md (profile-declared) into the published board with IN→backlog→mission chain, plus a local edit server reusing the same renderer; retire intake.py"`.
Sequência global: Plano A (despacho wahub) primeiro — "resolver primeiro wahub depois a
fábrica" (André, hoje).

## Verificação (Plano B)

- `pnpm test` do repo factory (conformidade de profiles + testes novos do parser JS,
  incluindo o roundtrip pipe-escape que o parser Python já provou).
- `board-autopublish.mjs --dry-run` renderiza a aba Intake com os 52 rows reais e a cadeia
  C3↔sdr-nonlead-gate↔IN-33/35/38/40a visível.
- `pnpm intake` local: editar um row de teste → salvo no `.md` com `.bak` → re-render.

---

## Desvios ratificados na execução (2026-07-09, André)

1. **Publica-se tudo**, não um subconjunto: as linhas `business-decision (engagement)` e os
   blocos `# Detalhamento técnico` vão ao ar. O basic-auth (usuários `andre`/`tenant-a`/
   `operator`) é o único controle, e é aceito. Só o intake do WaHub é declarado — CIPE e CIDS
   ficam fora (CIPE é confidencial por contrato, cl. 4).
2. **Sem seat externo**: construído com modelos Anthropic no checkout principal, branch
   `agent/intake-board`. Nada de worktree (o `FACTORY_ROOT` de um worktree sub-resolve os
   caminhos relativos do profile — D-27), nada de `glm-5.2` (reservados ao Plano A).
3. **Sem `marked`**: o Detalhamento é renderizado pelo `esc()` + whitelist já documentado em
   `board-report.mjs:406`, e não por um parser markdown genérico — a invariante "escapa
   primeiro, transforma depois" vale mais que a conveniência, e o engine não tem nenhuma
   dependência de runtime.
4. **Stretch (5) fica fora do v1**: o intake é append-only por regra da skill `tenant-a-intake`;
   escrita cruzada de repo a partir do `mission:ratify` merece decisão própria.
