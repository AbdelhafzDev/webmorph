/** The Studio page: one HTML document, no build step, no framework. All data rendering goes through DOM APIs, never innerHTML. */
export const STUDIO_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebMorph Studio</title>
<style>
  :root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --accent:#0b5fff; --ok:#1a7f37; --warn:#b26a00; --bad:#b3261e; --chip:#f2f2f7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#9a9a9f; --line:#2a2a2e; --accent:#6ea0ff; --chip:#1e1e22; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color:var(--fg); background:var(--bg); }
  header { display:flex; gap:16px; align-items:center; padding:12px 20px; border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; } header a { color:var(--accent); text-decoration:none; }
  main { padding:16px 20px; max-width:1200px; }
  h2 { font-size:18px; margin:18px 0 8px; } h3 { font-size:15px; margin:14px 0 6px; }
  table { border-collapse:collapse; width:100%; margin:6px 0 12px; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; font-size:12px; }
  .chip { display:inline-block; padding:1px 8px; border-radius:10px; background:var(--chip); font-size:12px; margin-right:4px; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .muted { color:var(--muted); }
  button { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--chip); color:var(--fg); cursor:pointer; } button.primary { background:var(--accent); color:#fff; border-color:var(--accent); } button:disabled { opacity:.5; cursor:default; }
  input, select { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  nav.tabs { display:flex; gap:4px; flex-wrap:wrap; margin:10px 0; } nav.tabs button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  pre { background:var(--chip); padding:10px; border-radius:6px; overflow:auto; max-height:360px; font-size:12px; }
  details { margin:6px 0; } summary { cursor:pointer; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  img.shot { max-width:320px; border:1px solid var(--line); border-radius:4px; display:block; margin:4px 0; }
  form.inline { display:flex; gap:8px; flex-wrap:wrap; align-items:end; } form.inline label { display:flex; flex-direction:column; font-size:12px; color:var(--muted); }
  .log { font-family: ui-monospace, Menlo, monospace; font-size:12px; white-space:pre-wrap; background:var(--chip); padding:8px; border-radius:6px; max-height:300px; overflow:auto; }
</style>
</head>
<body>
<header><h1>WebMorph Studio</h1><a href="#/">Sites</a><span id="status" class="muted"></span></header>
<main id="app"></main>
<script>
(() => {
  const app = document.getElementById('app');
  const status = document.getElementById('status');
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v; else if (k === 'onclick') el.addEventListener('click', v); else if (k === 'onsubmit') el.addEventListener('submit', v); else if (v !== undefined && v !== null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const api = async (path, body) => {
    const res = await fetch('/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  };
  const chip = (text, cls) => h('span', { class: 'chip ' + (cls || '') }, text);
  const verdictClass = (v) => v === 'validated' || v === 'published' || v === 'completed' || v === 'ok' ? 'ok' : v === 'failed' || v === 'degraded' || v === 'blocked' ? 'bad' : v === 'skipped' || v === 'draft' || v === 'disabled' ? 'warn' : '';
  const json = (obj) => h('pre', {}, JSON.stringify(obj, null, 2));
  const table = (columns, rows) => h('table', {}, h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((cell) => h('td', {}, cell))))));
  const short = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
  const setStatus = (text) => { status.textContent = text || ''; };

  async function render() {
    const hash = location.hash || '#/';
    const [, route, siteId, tab, extra] = hash.split('/');
    app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      if (route === 'site' && siteId) await renderSite(decodeURIComponent(siteId), tab || 'overview', extra);
      else if (route === 'run' && siteId) await renderRun(siteId);
      else await renderSites();
    } catch (err) {
      app.replaceChildren(h('p', { class: 'bad' }, 'Error: ' + err.message));
    }
  }

  async function renderSites() {
    const sites = await api('/sites');
    const form = h('form', { class: 'inline', onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const r = await api('/discover', { url: f.get('url'), options: { maxPages: Number(f.get('maxPages')) || 50, maxPagesToInspect: Number(f.get('inspect')) || 15, model: f.get('model') === 'on', allowPrivate: f.get('private') === 'on', stages: f.get('stages') } });
      location.hash = '#/run/' + r.runId;
    } },
      h('label', {}, 'Start URL', h('input', { name: 'url', type: 'url', required: '', placeholder: 'https://example.com', size: '40' })),
      h('label', {}, 'Max pages', h('input', { name: 'maxPages', type: 'number', value: '50', min: '1' })),
      h('label', {}, 'Inspect pages', h('input', { name: 'inspect', type: 'number', value: '15', min: '1' })),
      h('label', {}, 'Stages', h('select', { name: 'stages' }, h('option', { value: 'all' }, 'all'), h('option', { value: 'phase3' }, 'through tools'), h('option', { value: 'phase1' }, 'static only'))),
      h('label', {}, h('span', {}, 'Model enrichment'), h('input', { name: 'model', type: 'checkbox', checked: '' })),
      h('label', {}, h('span', {}, 'Allow private network'), h('input', { name: 'private', type: 'checkbox' })),
      h('button', { class: 'primary', type: 'submit' }, 'Discover'));
    const runs = await api('/runs');
    app.replaceChildren(
      h('h2', {}, 'Discover a site'), form,
      runs.length ? h('div', {}, h('h3', {}, 'Runs'), table(['run', 'url', 'status', 'site'], runs.map((r) => [h('a', { href: '#/run/' + r.runId }, r.runId), r.startUrl, chip(r.status, verdictClass(r.status)), r.siteId ? h('a', { href: '#/site/' + r.siteId }, r.siteId) : '']))) : null,
      h('h2', {}, 'Sites'),
      sites.length ? table(['site', 'origin', 'latest job', 'published', 'degraded', 'recordings'], sites.map((s) => [h('a', { href: '#/site/' + encodeURIComponent(s.siteId) }, s.siteId), s.origin, s.latestJobId, chip(String(s.published), s.published ? 'ok' : ''), chip(String(s.degraded), s.degraded ? 'bad' : ''), String(s.recordings)])) : h('p', { class: 'muted' }, 'No sites yet. Run a discovery above or with the CLI.'));
  }

  async function renderRun(runId) {
    const run = await api('/runs/' + runId);
    app.replaceChildren(
      h('h2', {}, 'Run ', runId, ' ', chip(run.status, verdictClass(run.status))),
      h('p', {}, run.startUrl, run.siteId ? [' → ', h('a', { href: '#/site/' + run.siteId }, run.siteId)] : null, run.error ? h('span', { class: 'bad' }, ' ' + run.error) : null),
      h('div', { class: 'log' }, run.log.join('\n')));
    if (run.status === 'running') setTimeout(() => { if (location.hash === '#/run/' + runId) render(); }, 1500);
  }

  async function renderSite(siteId, tab, extra) {
    const detail = await api('/sites/' + encodeURIComponent(siteId));
    const job = (extra && detail.jobs.find((j) => j.jobId === extra)) || detail.jobs[0];
    const go = (t, j) => { location.hash = '#/site/' + encodeURIComponent(siteId) + '/' + t + (j ? '/' + j : ''); };
    const tabs = ['overview', 'pages', 'inspection', 'probes', 'docs', 'model', 'tools', 'workflows', 'recordings', 'registry'];
    const nav = h('nav', { class: 'tabs' }, tabs.map((t) => h('button', { class: t === tab ? 'active' : '', onclick: () => go(t, job && job.jobId) }, t)));
    const jobSelect = h('select', { 'aria-label': 'job' }, detail.jobs.map((j) => h('option', { value: j.jobId, ...(job && j.jobId === job.jobId ? { selected: '' } : {}) }, j.jobId + ' · ' + j.status + ' · ' + j.stages.filter((s) => s.status === 'completed').length + ' stages')));
    jobSelect.addEventListener('change', () => go(tab, jobSelect.value));
    const head = h('div', {}, h('h2', {}, detail.site.origin, ' ', h('span', { class: 'muted' }, siteId)), h('div', {}, h('span', { class: 'muted' }, 'Job '), jobSelect), nav);
    const body = h('div', {});
    app.replaceChildren(head, body);
    const art = (type) => job ? api('/sites/' + encodeURIComponent(siteId) + '/jobs/' + job.jobId + '/artifacts/' + type).catch(() => null) : Promise.resolve(null);
    const jobBase = job ? '/api/sites/' + encodeURIComponent(siteId) + '/jobs/' + job.jobId : '';

    if (tab === 'overview') {
      body.append(h('h3', {}, 'Jobs'), table(['job', 'status', 'created', 'stages'], detail.jobs.map((j) => [j.jobId, chip(j.status, verdictClass(j.status)), j.createdAt, h('div', {}, j.stages.map((s) => chip(s.id.replace(/^stage/, 's') + ' ' + s.status, verdictClass(s.status))))])));
      const report = await art('CrawlReport');
      if (report) body.append(h('h3', {}, 'Crawl'), json({ ...report.data, blockedSignals: report.data.blockedSignals }));
      return;
    }
    if (tab === 'pages') {
      const [templates, pages] = await Promise.all([art('PageTemplates'), art('PageInventory')]);
      if (templates) body.append(h('h3', {}, 'Templates'), table(['kind', 'pattern', 'pages', 'cohesion', 'forms', 'representatives'], templates.data.templates.map((t) => [chip(t.kind), t.urlPattern, String(t.pageCount), String(t.cohesion), t.formClassifications.join(', '), h('div', {}, t.representativeUrls.map((u) => h('div', {}, short(u))))])));
      if (pages) body.append(h('h3', {}, 'Pages (' + pages.data.pages.length + ')'), table(['outcome', 'url', 'status', 'title', 'render', 'links', 'forms'], pages.data.pages.map((p) => [chip(p.outcome, verdictClass(p.outcome)), short(p.requestedUrl), String(p.status || ''), p.html ? p.html.title || '' : p.error || p.blockedSignal || '', p.html ? p.html.renderMode.kind : '', p.html ? String(p.html.internalLinkCount) : '', p.html ? p.html.forms.map((f) => f.classification).join(', ') : ''])));
      return;
    }
    if (tab === 'inspection') {
      const [model, inv] = await Promise.all([art('PageModel'), art('ElementInventory')]);
      if (!model) { body.append(h('p', { class: 'muted' }, 'No browser inspection in this job.')); return; }
      body.append(h('p', {}, chip(model.data.stats.ok + '/' + model.data.stats.inspected + ' pages ok'), inv ? chip(inv.data.stats.elements + ' elements, ' + inv.data.stats.withUniqueLocator + ' uniquely locatable') : null));
      body.append(h('div', { class: 'grid' }, model.data.pages.map((p) => h('div', { class: 'card' },
        h('div', {}, chip(p.outcome, verdictClass(p.outcome)), ' ', h('strong', {}, p.title || short(p.url))),
        h('div', { class: 'muted' }, short(p.finalUrl), ' · ', p.loadMs + 'ms', p.hydration.delta !== undefined ? ' · hydration +' + p.hydration.delta : ''),
        p.screenshot ? h('img', { class: 'shot', src: jobBase + '/' + p.screenshot.path, alt: 'screenshot' }) : null,
        p.dialogs.length ? h('div', {}, p.dialogs.map((d) => chip('dialog: ' + d.kind, 'warn'))) : null,
        p.blockedRequests ? h('div', { class: 'muted' }, p.blockedRequests + ' requests refused by policy') : null,
        inv ? h('details', {}, h('summary', {}, 'Elements on this page'), table(['kind', 'category', 'name', 'locator'], inv.data.elements.filter((e) => e.pageUrl === p.finalUrl).slice(0, 200).map((e) => [e.kind, chip(e.category, e.consequential ? 'bad' : ''), e.name || e.text || '', e.locators[0] ? e.locators[0].strategy + ' ' + e.locators[0].value : '']))) : null))));
      return;
    }
    if (tab === 'probes') {
      const ev = await art('InteractionEvidence');
      if (!ev) { body.append(h('p', { class: 'muted' }, 'No interaction probes in this job.')); return; }
      body.append(h('p', {}, Object.entries(ev.data.stats.byOutcome).map(([k, v]) => chip(k + ' ' + v, verdictClass(k)))));
      body.append(table(['kind', 'page', 'target', 'outcome', 'after', 'why allowed'], ev.data.probes.map((p) => [p.kind, short(p.pageUrl), p.targetDescription, chip(p.outcome, p.outcome === 'navigated' || p.outcome === 'changed' ? 'ok' : p.outcome === 'error' ? 'bad' : ''), p.after ? short(p.after.url) : p.error || '', p.allowedBecause])));
      return;
    }
    if (tab === 'docs') {
      const [docs, apis] = await Promise.all([art('DocumentationIndex'), art('ApiCandidates')]);
      if (docs) {
        body.append(h('h3', {}, 'Documentation sources'), table(['kind', 'url', 'title'], docs.data.sources.filter((s) => !['missing', 'skipped'].includes(s.kind)).map((s) => [chip(s.kind, s.kind === 'error' ? 'bad' : ''), s.url, s.title || s.error || ''])));
        for (const a of docs.data.apis) body.append(h('h3', {}, (a.title || 'API') + ' (' + a.format + ')'), table(['operation', 'method', 'path', 'auth', 'side effect', 'params'], a.operations.map((o) => [o.operationId, o.method.toUpperCase(), o.path, o.authRequired ? chip('auth', 'warn') : chip('public', 'ok'), chip(o.sideEffectClass, o.sideEffectClass === 'read' ? 'ok' : 'bad'), o.parameters.map((p) => p.name + ':' + p.in).join(', ')])));
      } else body.append(h('p', { class: 'muted' }, 'No documentation stage in this job.'));
      if (apis) body.append(h('h3', {}, 'API candidates (observed)'), table(['method', 'url', 'params', 'count', 'documented', 'credentialed', 'confidence'], apis.data.candidates.map((c) => [c.method, c.urlTemplate, c.queryParams.join(', '), String(c.count), c.documentedOperationId || '', c.credentialed ? chip('yes', 'bad') : c.configuredCredential ? chip('configured: ' + c.configuredCredential, 'warn') : 'no', String(c.confidence)])));
      return;
    }
    if (tab === 'model') {
      const m = await art('WebsiteModel');
      if (!m) { body.append(h('p', { class: 'muted' }, 'No website model in this job.')); return; }
      const d = m.data;
      body.append(h('p', {}, h('strong', {}, d.site.purpose.statement), ' ', chip(d.site.purpose.source + ' ' + d.site.purpose.confidence), d.enrichment.applied ? chip('enriched by ' + d.enrichment.model, 'ok') : chip('deterministic' + (d.enrichment.error ? ': ' + d.enrichment.error : ''), 'warn')));
      body.append(h('h3', {}, 'Entities'), table(['name', 'plural', 'detail page type', 'confidence', 'source'], d.entities.map((e) => [e.name, e.plural, e.detailPageTypeId || '', String(e.confidence), e.source])));
      body.append(h('h3', {}, 'Capabilities'), table(['name', 'kind', 'status', 'confidence', 'inputs', 'api', 'evidence'], d.capabilities.map((c) => [c.name, chip(c.kind), chip(c.status, c.status === 'observed' ? 'ok' : 'warn'), String(c.confidence), c.inputs.map((i) => i.name).join(', '), c.mechanics.api ? chip(c.mechanics.api.source + ' GET', 'ok') : '', String(c.evidence.length)])));
      body.append(h('h3', {}, 'Observed facts (' + d.facts.length + ')'), h('details', {}, h('summary', {}, 'show'), table(['id', 'statement', 'evidence'], d.facts.map((f) => [f.factId, f.statement, f.evidence.map((e) => e.artifactType + (e.refId ? ':' + e.refId : '')).join('; ')]))));
      body.append(h('h3', {}, 'Hypotheses (' + d.hypotheses.length + ')'), table(['id', 'statement', 'confidence', 'based on', 'source'], d.hypotheses.map((x) => [x.hypothesisId, x.statement, String(x.confidence), x.basedOn.join(', '), x.source])));
      if (d.unresolved.length) body.append(h('h3', {}, 'Unresolved'), h('ul', {}, d.unresolved.map((u) => h('li', {}, u))));
      return;
    }
    if (tab === 'tools') {
      const [def, report] = await Promise.all([art('ToolDefinition'), art('ValidationReport')]);
      if (!def) { body.append(h('p', { class: 'muted' }, 'No tools generated in this job.')); return; }
      const reg = detail.registry.tools;
      const actions = h('div', {}, h('button', { class: 'primary', onclick: async () => { setStatus('publishing…'); const r = await api('/sites/' + encodeURIComponent(siteId) + '/publish', { jobId: job.jobId }); setStatus('published: ' + (r.published.join(', ') || 'nothing') + (r.skipped.length ? '; skipped ' + r.skipped.length : '')); render(); } }, 'Publish all validated'),
        ' ', h('button', { onclick: async () => { setStatus('revalidating…'); const r = await api('/sites/' + encodeURIComponent(siteId) + '/revalidate', {}); setStatus(r.map((x) => x.name + ':' + x.verdict).join(' ')); render(); } }, 'Revalidate published'));
      body.append(actions);
      body.append(table(['tool', 'transport', 'side effect', 'inputs', 'validation', 'registry', 'actions'], def.data.tools.map((t) => {
        const v = report ? report.data.tools.find((x) => x.toolId === t.toolId) : null;
        const r = reg[t.name];
        const tryBox = h('div', {});
        const tryBtn = h('button', { onclick: () => { tryBox.replaceChildren(tryForm(siteId, t)); } }, 'Try');
        const pub = h('button', { onclick: async () => { setStatus('publishing ' + t.name); await api('/sites/' + encodeURIComponent(siteId) + '/publish', { jobId: job.jobId, names: [t.name] }); setStatus(''); render(); } }, 'Publish');
        const dis = r && r.status !== 'disabled' ? h('button', { onclick: async () => { await api('/sites/' + encodeURIComponent(siteId) + '/tools/' + t.name + '/status', { status: 'disabled', reason: 'studio' }); render(); } }, 'Disable') : null;
        const en = r && r.status !== 'published' ? h('button', { onclick: async () => { await api('/sites/' + encodeURIComponent(siteId) + '/tools/' + t.name + '/status', { status: 'published', reason: 'studio' }); render(); } }, 'Enable') : null;
        return [h('div', {}, h('strong', {}, t.name), h('div', { class: 'muted' }, t.description)), t.transport || 'browser', chip(t.sideEffectClass, t.sideEffectClass === 'read' ? 'ok' : 'bad'), Object.keys((t.inputSchema.properties) || {}).join(', '),
          v ? h('div', {}, chip(v.verdict, verdictClass(v.verdict)), v.failureReasons.length ? h('div', { class: 'muted' }, v.failureReasons[0]) : null) : chip('not run', 'warn'),
          r ? h('div', {}, chip(r.status, verdictClass(r.status)), h('div', { class: 'muted' }, r.calls.total + ' calls, ' + r.calls.failed + ' failed')) : chip('not published'),
          h('div', {}, pub, ' ', dis, ' ', en, ' ', (r && r.status === 'published') ? tryBtn : null, tryBox)];
      })));
      return;
    }
    if (tab === 'workflows') {
      const wf = await art('WorkflowDefinition');
      if (!wf || !wf.data.workflows.length) { body.append(h('p', { class: 'muted' }, 'No workflows. Record a session with the CLI, then rerun discovery.')); return; }
      body.append(table(['workflow', 'intent', 'steps', 'inputs', 'side effect', 'replayable', 'approval', 'reasons'], wf.data.workflows.map((w) => [w.name, w.intent, String(w.steps.length), w.inputs.map((i) => i.name).join(', '), chip(w.sideEffectClass, w.sideEffectClass === 'read' ? 'ok' : 'bad'), w.replayable ? 'yes' : chip('no', 'warn'), w.requiresApproval ? chip('required', 'warn') : 'no', w.reasons.join('; ')])));
      return;
    }
    if (tab === 'recordings') {
      if (!detail.recordings.length) { body.append(h('p', { class: 'muted' }, 'No recordings for this site.')); return; }
      for (const s of detail.recordings) {
        const box = h('div', { class: 'card' }, h('div', {}, h('strong', {}, s.sessionId), ' ', chip(s.status, verdictClass(s.status)), ' ', s.eventCount + ' events, ' + s.pagesVisited.length + ' pages'), h('div', { class: 'muted' }, s.startedAt));
        const btn = h('button', { onclick: async () => { const r = await api('/sites/' + encodeURIComponent(siteId) + '/recordings/' + s.sessionId); box.append(table(['#', 'type', 'target', 'value', 'from', 'to'], r.events.map((e) => [String(e.seq), e.type, e.target ? (e.target.name || e.target.text || e.target.tag) : (e.navigation ? e.navigation.to : ''), e.input ? (e.input.redacted ? chip('redacted (' + e.input.valueLength + ' chars)', 'warn') : e.input.value) : '', e.before ? short(e.before.url) : '', e.after ? short(e.after.url) : '']))); btn.remove(); } }, 'Show timeline');
        box.append(btn);
        body.append(box);
      }
      return;
    }
    if (tab === 'registry') {
      body.append(json(detail.registry));
      return;
    }
  }

  function tryForm(siteId, tool) {
    const props = tool.inputSchema.properties || {};
    const out = h('pre', {});
    const form = h('form', { class: 'inline', onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const inputs = {};
      for (const [k, schema] of Object.entries(props)) { const raw = f.get(k); if (raw === null || raw === '') continue; inputs[k] = schema.type === 'integer' || schema.type === 'number' ? Number(raw) : raw; }
      out.textContent = 'calling…';
      const r = await api('/sites/' + encodeURIComponent(siteId) + '/tools/' + tool.name + '/call', { inputs });
      out.textContent = JSON.stringify(r, null, 2);
    } }, Object.entries(props).map(([k, schema]) => h('label', {}, k + (tool.inputSchema.required && tool.inputSchema.required.includes(k) ? ' *' : ''), schema.enum ? h('select', { name: k }, h('option', { value: '' }, '(none)'), schema.enum.map((v) => h('option', { value: v }, v))) : h('input', { name: k, type: schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text', placeholder: schema.description || '' }))), h('button', { class: 'primary', type: 'submit' }, 'Call'));
    return h('div', {}, form, out);
  }

  window.addEventListener('hashchange', render);
  render();
})();
</script>
</body>
</html>`;
