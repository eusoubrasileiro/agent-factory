#!/usr/bin/env node
/**
 * Local intake editor — `pnpm intake`.
 *
 * Serves the SAME cards the published board's Intake tab renders (it imports
 * `renderIntakeTab` from `board-report.mjs`), plus the one thing a static
 * projection must never have: write-back. Editing a row rewrites the source
 * `requirements-intake.md` in place, after a `.bak` copy.
 *
 * The split is deliberate and is the whole architecture:
 *
 *   - the VPS gets a read-only rsync of rendered HTML (D-08: disk is canonical);
 *   - writes happen HERE, on the machine that owns the markdown, over loopback.
 *
 * So this binds `127.0.0.1` and nothing else. There is no auth because there is
 * no remote listener; adding one would be theatre. The sources it may touch are
 * exactly those the project profiles declare in `intake[]` — never a path from
 * the request.
 *
 * Usage:
 *   node scripts/intake-server.mjs [--project <id>] [--port <n>] [--publish] [--no-open]
 *
 * With no `--project`, every profile that declares an `intake[]` is served.
 * `--publish` re-runs `board-autopublish.mjs` after each successful write.
 *
 * Retires the per-client Python viewer whose behaviour it reproduces.
 *
 * Exit codes:
 *   0 ok · 1 unexpected error · 2 usage / no intake source
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { esc, renderIntakeTab, renderStyles, buildTraceabilityModel } from "./board-report.mjs";
import { STATUSES, TYPES, deleteRow, writeRow } from "./intake-report.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { loadProjects, resolveProject, FACTORY_ROOT } from "./lib/project.mjs";

const HOST = "127.0.0.1"; // loopback only — never bind a writable surface to the network
const DEFAULT_PORT = 8899;
const ROW_PATH_RE = /^\/api\/row\/([A-Z]+-\d+)$/;

// ─── Sources + model ──────────────────────────────────────────────────────────

/**
 * Every declared intake source, with the project it belongs to. A request never
 * names a file: a row id's PREFIX selects the source, exactly as `intake.py` did.
 *
 * @param {string|undefined} projectId — restrict to one project.
 * @returns {Array<{projectId: string, file: string, prefix: string, label: string}>}
 */
export function collectSources(projectId) {
  const ids = projectId ? [projectId] : loadProjects().map((p) => p.id);
  const sources = [];
  for (const id of ids) {
    const { profile } = resolveProject({ project: id });
    for (const src of profile.intake ?? []) {
      sources.push({ projectId: id, ...src });
    }
  }
  return sources;
}

/** The source that owns a row id, by prefix. `null` when nothing claims it. */
export function sourceFor(sources, id) {
  const prefix = String(id ?? "").split("-")[0];
  return sources.find((s) => s.prefix === prefix) ?? null;
}

/**
 * Build the intake model for every project that has a source, reusing the board's
 * own model builder so the chain (IN → backlog → mission → verdict) is identical
 * to the published one. Git is not consulted — branches do not affect intake.
 *
 * @param {string|undefined} projectId
 * @returns {Array<object>} intake rows, newest first.
 */
export function buildModel(projectId) {
  const ids = projectId ? [projectId] : loadProjects().map((p) => p.id);
  const rows = [];
  for (const id of ids) {
    const resolved = resolveProject({ project: id });
    if (!resolved.profile.intake?.length) continue;
    const model = buildTraceabilityModel({
      missionsDir: resolved.missionsRoot,
      prdPath: resolved.prdPath ?? "",
      gitInfo: { branches: [] },
      intakeSources: resolved.profile.intake,
      // The same aliases the board uses — otherwise this local viewer and
      // `pnpm board:report` disagree about which rows are dispatched.
      legacyReqMap: resolved.profile.legacyReqMap,
    });
    rows.push(...model.intake);
  }
  return rows;
}

// ─── Write-back (the only mutation in the whole board pipeline) ───────────────

/**
 * Rewrite or delete one row in its source markdown, backing the file up first.
 *
 * Pure transforms (`writeRow` / `deleteRow`) decide the new text; this function
 * only does IO. A row id with no declared source, or an id absent from its file,
 * throws — a silent no-op would look like a successful save.
 *
 * @param {Array<object>} sources
 * @param {string} id
 * @param {{delete?: boolean, fields?: object}} op
 * @returns {string} the file written.
 */
export function applyEdit(sources, id, op = {}) {
  const src = sourceFor(sources, id);
  if (!src) throw new Error(`nenhuma fonte declarada para ${id}`);
  if (!existsSync(src.file)) throw new Error(`fonte não encontrada: ${src.file}`);

  const before = readFileSync(src.file, "utf8");
  const after = op.delete ? deleteRow(before, id) : writeRow(before, id, op.fields ?? {});

  copyFileSync(src.file, `${src.file}.bak`);
  writeFileSync(src.file, after, "utf8");
  return src.file;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * The editor page: the board's own Intake panel (visible, not behind a tab) plus
 * an edit affordance per card. The row values are embedded UNESCAPED as JSON so
 * the form edits the markdown source, not its HTML rendering.
 * @param {Array<object>} intake
 * @returns {string}
 */
export function renderEditorPage(intake) {
  const rowsJson = JSON.stringify(intake).replace(/</g, "\\u003c");
  const panel = renderIntakeTab(intake, { hidden: false });
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intake — editor local</title>
  <style>
${renderStyles()}
.editor-bar { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
.editor-bar button { font: inherit; font-size: 0.75rem; padding: 0.15rem 0.6rem; border-radius: 4px; border: 1px solid var(--border); background: var(--card-bg); color: var(--fg); cursor: pointer; }
.editor-bar button:hover { background: var(--bg); }
.editor-bar button.danger { color: #991b1b; border-color: #fecaca; }
.edit-form { display: none; margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px dashed var(--border); }
.edit-form.open { display: grid; gap: 0.4rem; }
.edit-form label { font-size: 0.72rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.edit-form input, .edit-form textarea, .edit-form select { font: inherit; font-size: 0.85rem; width: 100%; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); }
.edit-form textarea { min-height: 5rem; resize: vertical; }
.toast { position: fixed; right: 1rem; bottom: 1rem; padding: 0.5rem 0.9rem; border-radius: 6px; font-size: 0.85rem; background: var(--card-bg); border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,.08); }
  </style>
</head>
<body>
  <header class="site">
    <h1>Intake — editor local <span class="muted" style="font-size:.8rem;font-weight:400">${esc(HOST)} · grava no .md, com .bak</span></h1>
  </header>
  <main>
${panel || '  <p class="muted" style="padding:2rem">Nenhuma fonte de intake declarada em projects/*/project.json.</p>'}
  </main>
  <script type="application/json" id="rows">${rowsJson}</script>
  <script>
${renderEditorScript()}
  </script>
</body>
</html>
`;
}

function renderEditorScript() {
  return `
(function () {
  var rows = JSON.parse(document.getElementById('rows').textContent);
  var TYPES = ${JSON.stringify(TYPES)};
  var STATUSES = ${JSON.stringify(STATUSES)};

  function toast(msg, ok) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    el.style.color = ok ? '#166534' : '#991b1b';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  function field(label, name, value, options) {
    var wrap = document.createElement('div');
    var lab = document.createElement('label');
    lab.textContent = label;
    wrap.appendChild(lab);
    var input;
    if (options) {
      input = document.createElement('select');
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o; opt.textContent = o; opt.selected = o === value;
        input.appendChild(opt);
      });
    } else if (name === 'summary') {
      input = document.createElement('textarea');
      input.value = value || '';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
    }
    input.name = name;
    wrap.appendChild(input);
    return wrap;
  }

  rows.forEach(function (row) {
    var card = document.getElementById('intake-' + row.id);
    if (!card) return;

    var bar = document.createElement('div');
    bar.className = 'editor-bar';
    var edit = document.createElement('button');
    edit.type = 'button'; edit.textContent = 'editar';
    var del = document.createElement('button');
    del.type = 'button'; del.textContent = 'apagar'; del.className = 'danger';
    bar.appendChild(edit); bar.appendChild(del);
    card.appendChild(bar);

    var form = document.createElement('form');
    form.className = 'edit-form';
    form.appendChild(field('Data · Fonte', 'dateSource', row.dateSource));
    form.appendChild(field('Tipo', 'type', row.type, TYPES));
    form.appendChild(field('Resumo', 'summary', row.summary));
    form.appendChild(field('Situação', 'status', row.status, STATUSES));
    form.appendChild(field('Aterrissou em', 'landedIn', row.landedIn));
    var save = document.createElement('button');
    save.type = 'submit'; save.textContent = 'salvar';
    form.appendChild(save);
    card.appendChild(form);

    edit.addEventListener('click', function () { form.classList.toggle('open'); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {};
      ['dateSource', 'type', 'summary', 'status', 'landedIn'].forEach(function (k) {
        payload[k] = form.elements[k].value;
      });
      post(row.id, payload);
    });

    del.addEventListener('click', function () {
      if (!confirm('Apagar ' + row.id + ' do .md? (o bloco técnico dele vai junto, se não for compartilhado)')) return;
      post(row.id, { _delete: true });
    });
  });

  function post(id, payload) {
    fetch('/api/row/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { toast(j.error || 'erro', false); return; }
        toast((payload._delete ? 'apagado ' : 'salvo ') + id, true);
        setTimeout(function () { location.reload(); }, 700);
      })
      .catch(function (err) { toast(String(err), false); });
  }
})();
`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

function json(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) reject(new Error("payload grande demais"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The request handler, exported so a test can drive it without a live socket.
 * @param {{projectId?: string, onWrite?: () => void}} opts
 */
export function createHandler({ projectId, onWrite } = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const body = Buffer.from(renderEditorPage(buildModel(projectId)), "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": body.length,
        });
        return res.end(body);
      }

      if (req.method === "GET" && url.pathname === "/api/rows") {
        return json(res, buildModel(projectId));
      }

      const m = req.method === "POST" && url.pathname.match(ROW_PATH_RE);
      if (m) {
        const id = m[1];
        const payload = JSON.parse((await readBody(req)) || "{}");
        const sources = collectSources(projectId);
        try {
          const file = payload._delete
            ? applyEdit(sources, id, { delete: true })
            : applyEdit(sources, id, { fields: payload });
          if (onWrite) onWrite();
          return json(res, { ok: true, id, file, deleted: Boolean(payload._delete) });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 400);
        }
      }

      return json(res, { ok: false, error: "not found" }, 404);
    } catch (err) {
      return json(res, { ok: false, error: err?.message ?? String(err) }, 500);
    }
  };
}

/** Re-render + publish, soft-fail: an editor must not die because rsync did. */
function republish() {
  const child = spawn(process.execPath, [path.join(FACTORY_ROOT, "scripts", "board-autopublish.mjs")], {
    stdio: "inherit",
  });
  child.on("error", (err) => process.stderr.write(`intake: autopublish falhou (${err.message})\n`));
}

function usage() {
  process.stderr.write(
    "Usage:\n  node scripts/intake-server.mjs [--project <id>] [--port <n>] [--publish]\n",
  );
}

function main() {
  const args = process.argv.slice(2);
  let projectId;
  let port = DEFAULT_PORT;
  let publish = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") projectId = args[++i];
    else if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--publish") publish = true;
    else {
      usage();
      return 2;
    }
  }

  const sources = collectSources(projectId);
  if (sources.length === 0) {
    process.stderr.write(
      "intake: nenhum profile declara `intake[]`. Adicione o campo em projects/<id>/project.json.\n",
    );
    return 2;
  }

  const server = createServer(createHandler({ projectId, onWrite: publish ? republish : undefined }));
  server.listen(port, HOST, () => {
    for (const s of sources) process.stdout.write(`intake: ${s.prefix} → ${s.file}\n`);
    process.stdout.write(`intake: http://${HOST}:${port}  (Ctrl-C para sair)\n`);
  });
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    const code = main();
    if (code !== 0) process.exit(code);
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}
