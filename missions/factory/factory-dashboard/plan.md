# Mission Plan — factory-dashboard

Approved by Andre 2026-07-07 (plan-mode approval). Seats: orchestrator = Fable;
workers W1–W4 = GLM 5.2 via `pnpm factory:opencode` (serial, constitution C2);
validator = GLM 5.2 fresh session. Graduated fix ladder (R9).

## Features → milestones

| Feature | Scope | Contract rows |
|---------|-------|---------------|
| 01 — traceability model | Requirements-line parser, `buildTraceabilityModel` pure core (reuses `deriveMissionState` + `parseBacklogTables`), git-info collector, tests | A3, A4, A5 |
| 02 — HTML renderer + CLI | model → self-contained PT-BR HTML (3 views), `board-report.mjs` CLI shell, tests | A1, A2 |
| 03 — publish + deploy artifacts | `board-publish.sh` (+ dry-run), `deploy/factory-board/`, package.json scripts | A6, A7 |
| 04 — backfill + docs + integration | template Requirements field, 3 brief backfills, RUNBOOK section, real-repo run | A2 (real repo), invariant |

## Traceability decisions (fixed — do not relitigate)
- Join = explicit `**Requirements:** <IDs|none>` line in brief.md ONLY.
- Backfill: inbox-safety → A1,A2,A3,A4,A5 · pipeline-realtime → B1,B2,B3,B4 ·
  crm-dashboard-data → B1,B2,B3 · every other existing mission → none.
- role-funcionario stays unmapped (its C1–C3 are local IDs, a collision).

## Deploy decisions (fixed)
Copy `products/lead-searcher-deploy` pattern; nginx:alpine + bind-mount
`./public:/usr/share/nginx/html:ro`; Traefik `Host(\`factory.example.com\`)`,
websecure, certresolver=myresolver, network_public, basicauth middleware
`${FACTORY_BASICAUTH}`. Secrets live only in the VPS-side `.env`.
