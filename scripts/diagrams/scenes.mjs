// Diagram definitions for docs/diagrams/*. Each scene is an Excalidraw "skeleton" (the input of
// convertToExcalidrawElements): boxes with labels and arrows bound to them. Edit here, then run
// `pnpm diagrams` to regenerate the .excalidraw sources and the SVGs the README embeds.

const INK = '#1e1e1e';
const FONT = 5; // Excalifont (hand-drawn)
export const COLORS = {
  blue: '#a5d8ff',
  green: '#b2f2bb',
  yellow: '#ffec99',
  orange: '#ffd8a8',
  red: '#ffc9c9',
  violet: '#d0bfff',
  teal: '#96f2d7',
  gray: '#e9ecef',
  white: '#ffffff',
};

class Scene {
  constructor(name, title) {
    this.name = name;
    this.elements = [];
    this.boxes = new Map();
    this.nextSeed = 1;
    if (title) this.text(title, 0, 0, { fontSize: 28 });
  }

  /** Push an element with a deterministic seed, so re-rendering a scene reproduces the same strokes. */
  add(element) {
    this.elements.push({ seed: this.nextSeed++, ...element });
  }

  text(text, x, y, { fontSize = 16, color = INK, align = 'left' } = {}) {
    this.add({ type: 'text', x, y, text, fontSize, fontFamily: FONT, strokeColor: color, textAlign: align });
  }

  /** A labelled rounded box. */
  box(id, x, y, width, height, label, { color = COLORS.gray, fontSize = 14, dashed = false, textColor = INK, stroke = INK, align = 'center' } = {}) {
    this.boxes.set(id, { x, y, width, height });
    this.add({
      type: 'rectangle',
      id,
      x,
      y,
      width,
      height,
      strokeColor: stroke,
      backgroundColor: color,
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: dashed ? 'dashed' : 'solid',
      roughness: 1,
      roundness: { type: 3 },
      label: { text: label, fontSize, fontFamily: FONT, strokeColor: textColor, textAlign: align, verticalAlign: 'middle' },
    });
    return id;
  }

  /** A faint lane behind a group of boxes, with a caption. */
  lane(x, y, width, height, caption, color = '#f8f9fa', captionX = x + 14) {
    this.add({ type: 'rectangle', x, y, width, height, strokeColor: '#868e96', backgroundColor: color, fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'dashed', roughness: 0, roundness: { type: 3 } });
    this.text(caption, captionX, y + 10, { fontSize: 15, color: '#495057' });
  }

  /** A decision diamond. */
  diamond(id, x, y, width, height, label, { color = COLORS.yellow, fontSize = 14 } = {}) {
    this.boxes.set(id, { x, y, width, height });
    this.add({ type: 'diamond', id, x, y, width, height, strokeColor: INK, backgroundColor: color, fillStyle: 'solid', strokeWidth: 2, roughness: 1, label: { text: label, fontSize, fontFamily: FONT, strokeColor: INK, textAlign: 'center', verticalAlign: 'middle' } });
    return id;
  }

  /**
   * Arrow between two boxes. Anchors are chosen from the boxes' relative positions and aligned with
   * the other end so straight connections stay straight; `via` adds waypoints (absolute coordinates).
   */
  arrow(fromId, toId, { label, via = [], color = INK, dashed = false, from, to, bidirectional = false } = {}) {
    const a = this.boxes.get(fromId);
    const b = this.boxes.get(toId);
    if (!a || !b) throw new Error(`unknown box in arrow ${fromId} -> ${toId}`);
    const firstTarget = via[0] ? pointBox(via[0]) : b;
    const lastTarget = via.length ? pointBox(via[via.length - 1]) : a;
    const startSide = from ?? sideTowards(a, firstTarget);
    const endSide = to ?? sideTowards(b, lastTarget);
    let start = anchor(a, startSide, firstTarget);
    let end = anchor(b, endSide, lastTarget);
    if (!via.length) {
      const vertical = (startSide === 'bottom' && endSide === 'top') || (startSide === 'top' && endSide === 'bottom');
      const horizontal = (startSide === 'right' && endSide === 'left') || (startSide === 'left' && endSide === 'right');
      if (vertical) {
        const x = (a.width <= b.width ? a.x + a.width / 2 : b.x + b.width / 2);
        const xa = clamp(x, a.x + 24, a.x + a.width - 24);
        const xb = clamp(x, b.x + 24, b.x + b.width - 24);
        start = [xa, start[1]];
        end = [xb, end[1]];
      } else if (horizontal) {
        const y = (a.height <= b.height ? a.y + a.height / 2 : b.y + b.height / 2);
        start = [start[0], clamp(y, a.y + 18, a.y + a.height - 18)];
        end = [end[0], clamp(y, b.y + 18, b.y + b.height - 18)];
      }
    }
    const abs = [start, ...via, end];
    const points = abs.map(([x, y]) => [x - start[0], y - start[1]]);
    this.add({
      type: 'arrow',
      x: start[0],
      y: start[1],
      points,
      strokeColor: color,
      strokeWidth: 2,
      strokeStyle: dashed ? 'dashed' : 'solid',
      roughness: 1,
      startArrowhead: bidirectional ? 'arrow' : null,
      endArrowhead: 'arrow',
      start: { id: fromId },
      end: { id: toId },
      ...(label ? { label: { text: label, fontSize: 13, fontFamily: FONT, strokeColor: '#495057' } } : {}),
    });
  }

  /** A sticky note: dashed box with left-aligned text. */
  note(x, y, width, height, text, color = COLORS.yellow) {
    this.add({ type: 'rectangle', x, y, width, height, strokeColor: '#868e96', backgroundColor: color, fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'dashed', roughness: 1, roundness: { type: 3 }, label: { text, fontSize: 13, fontFamily: FONT, strokeColor: INK, textAlign: 'left', verticalAlign: 'middle' } });
  }
}

const pointBox = ([x, y]) => ({ x, y, width: 0, height: 0 });
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Point on a box side, aligned with the other end where that keeps the arrow straight. */
function anchor(box, side, other) {
  const ocx = other.x + other.width / 2;
  const ocy = other.y + other.height / 2;
  const cx = clamp(ocx, box.x + 24, box.x + box.width - 24);
  const cy = clamp(ocy, box.y + 18, box.y + box.height - 18);
  switch (side) {
    case 'right':
      return [box.x + box.width, cy];
    case 'left':
      return [box.x, cy];
    case 'top':
      return [cx, box.y];
    default:
      return [cx, box.y + box.height];
  }
}

function sideTowards(box, target) {
  const dx = target.x + target.width / 2 - (box.x + box.width / 2);
  const dy = target.y + target.height / 2 - (box.y + box.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

// ---------------------------------------------------------------------------------------------
// 1. The discovery pipeline: eleven stages in four lanes, evidence in and validated tools out.
// ---------------------------------------------------------------------------------------------
function pipeline() {
  const s = new Scene('pipeline', 'WebMorph discovery pipeline: evidence in, validated tools out');
  const W = 250;
  const H = 112;
  const GAP = 60;
  const X0 = 40;
  const LANE_H = 165;
  const LANE_GAP = 40;
  const lanes = [
    { y: 70, caption: 'Deterministic discovery  ·  HTTP only, no browser, no model', color: '#e7f5ff' },
    { y: 70 + (LANE_H + LANE_GAP), caption: 'Browser evidence  ·  Playwright behind the policy proxy, read-only probes', color: '#ebfbee' },
    { y: 70 + 2 * (LANE_H + LANE_GAP), caption: 'Website model  ·  deterministic first; facts cite evidence, hypotheses cite facts', color: '#fff9db' },
    { y: 70 + 3 * (LANE_H + LANE_GAP), caption: 'Tools  ·  data, not code; API first; validated against the live site before publishing', color: '#fff4e6' },
  ];
  const laneX = X0 - 20;
  const laneW = 4 * (W + GAP) - GAP + 40;
  // Captions start to the right of the first column so the lane-transition arrows never cross them.
  for (const l of lanes) s.lane(laneX, l.y, laneW, LANE_H, l.caption, l.color, X0 + W + 20);
  const by = (i) => lanes[i].y + 42;
  const bx = (j) => X0 + j * (W + GAP);
  const gapY = (i) => lanes[i].y + LANE_H + LANE_GAP / 2;

  s.box('s0', bx(0), by(0), W, H, '0  Scope\nSiteManifest\nnormalize, allowed hosts, budgets,\nSSRF check of the start host', { color: COLORS.blue });
  s.box('s1', bx(1), by(0), W, H, '1  Docs\nDocumentationIndex\nllms.txt, OpenAPI / Swagger,\ndocs pages (site-controlled input)', { color: COLORS.blue });
  s.box('s2', bx(2), by(0), W, H, '2  Sitemap\nURLInventory\nrobots.txt, sitemap tree,\nround-robin URL budget', { color: COLORS.blue });
  s.box('s3', bx(3), by(0), W, H, '3  Crawl\nPageInventory · PageTemplates\nCrawlReport · sampled by URL shape,\ntemplates, render mode, bot blocks', { color: COLORS.blue, fontSize: 13 });

  s.box('s4', bx(0), by(1), W, H, '4  Plan\nInspectionPlan\nrepresentatives per template,\nor every route for SPA shells', { color: COLORS.green });
  s.box('s5', bx(1), by(1), W, H, '5  Inspect\nPageModel · ElementInventory\nrendered text, hydration delta,\nranked locators, screenshots', { color: COLORS.green });
  s.box('s6', bx(2), by(1), W, H, '6  Interact\nInteractionEvidence\nsearch, pagination, filters, tabs;\nfresh context per probe', { color: COLORS.green });
  s.box('s7', bx(3), by(1), W, H, '7  Network\nNetworkEvidence · ApiCandidates\nredacted XHR/fetch capture,\ncredentials by name only', { color: COLORS.green });

  s.box('s8', bx(0), by(2), W, H, '8  Website model\nWebsiteModel\npage types, entities, capabilities\nwith mechanics tied to APIs', { color: COLORS.yellow });
  s.box('llm', bx(1), by(2), W, H, 'Claude enrichment (optional)\npurpose, descriptions, hypotheses;\nungrounded output rejected;\nnever changes mechanics', { color: COLORS.white, dashed: true });
  s.box('s9', bx(2), by(2), W, H, '9  Workflows\nWorkflowDefinition\nrecorded sessions become steps;\nwrites marked, never replayed', { color: COLORS.yellow });
  s.box('rec', bx(3), by(2), W, H, 'Recording (Mode A)\na person drives a browser\nWebMorph owns; values redacted,\nsecrets never leave the page', { color: COLORS.white, dashed: true });

  s.box('s10a', bx(0), by(3), W, H, '10a  Generate\nToolDefinition\nHTTP route first, browser fallback,\napiGaps with reasons', { color: COLORS.orange });
  s.box('s10b', bx(1), by(3), W, H, '10b  Validate\nValidationReport\nreplay ×N: runs, schema,\nnon-empty, stable, latency', { color: COLORS.orange });
  s.box('pub', bx(2), by(3), W, H, 'Publish (operator)\nregistry.json\nsnapshot pinned to job + artifacts;\ndegrades after site changes', { color: COLORS.orange });
  s.box('mcp', bx(3), by(3), W, H, 'Serve\nMCP server (stdio)\ntyped inputs and outputs,\nstructured results, error codes', { color: COLORS.orange });

  for (const [a, b] of [['s0', 's1'], ['s1', 's2'], ['s2', 's3'], ['s4', 's5'], ['s5', 's6'], ['s6', 's7'], ['s10a', 's10b'], ['s10b', 'pub'], ['pub', 'mcp']]) s.arrow(a, b);
  // lane transitions: down into the gap between lanes, across, down into the next lane's first box
  const drop = (from, to, laneIdx, xTo) => {
    const a = s.boxes.get(from);
    const b = s.boxes.get(to);
    const x2 = xTo ?? b.x + b.width / 2;
    s.arrow(from, to, { via: [[a.x + a.width / 2, gapY(laneIdx)], [x2, gapY(laneIdx)]], from: 'bottom', to: 'top' });
  };
  drop('s3', 's4', 0);
  drop('s7', 's8', 1);
  s.arrow('s8', 'llm', { dashed: true, bidirectional: true });
  s.arrow('rec', 's9');
  drop('s8', 's10a', 2, bx(0) + 70);
  s.arrow('s9', 's10a', { via: [[bx(2) + W / 2, gapY(2)], [bx(0) + W - 60, gapY(2)]], from: 'bottom', to: 'top', dashed: true });

  s.note(laneX, lanes[3].y + LANE_H + 30, laneW, 78, 'Every artifact is immutable per job and carries an envelope: schema version, site and job IDs, producing stage,\nsource artifacts, provenance. Stages talk only through artifacts, so a job can be inspected, resumed and diffed.', '#f8f9fa');
  return s;
}

// ---------------------------------------------------------------------------------------------
// 2. Network safety: the same policy on both paths, enforced twice for the browser.
// ---------------------------------------------------------------------------------------------
function safety() {
  const s = new Scene('safety', 'Network safety: one policy, two paths, defense in depth');
  s.box('stages', 40, 100, 260, 130, 'Discovery stages\nand the tool interpreter\n(HTTP tools: json, html-data,\nhtml-list)', { color: COLORS.gray, fontSize: 15 });
  s.box('browser', 40, 340, 260, 130, 'Chromium (Playwright)\ninspection, probes,\nbrowser tools, recording', { color: COLORS.gray, fontSize: 15 });

  s.box('http', 380, 70, 330, 190, 'SafeHttpClient\nper hop: exact-host scope, prohibited\npaths, blocked hostnames, size cap,\ntimeout, bounded retries honoring\nRetry-After, per-host delay,\nconcurrency and request budget', { color: COLORS.blue });
  s.box('route', 380, 310, 330, 190, 'Route layer (per request)\ndocument scope, method policy (GET only\nunless write probes), images, media and\nfonts skipped, fetch with redirects\ndisabled, every hop re-checked,\nWebSockets refused', { color: COLORS.green });

  s.box('dns', 790, 70, 310, 190, 'Pinned DNS lookup\nresolve through WebMorph\'s resolver,\nrefuse private and reserved ranges\n(IPv4, IPv6, mapped, NAT64),\ndial the address that was checked', { color: COLORS.violet });
  s.box('proxy', 790, 310, 310, 190, 'Policy proxy (per connection)\nresolve and pin every host, including\nredirect targets and subresources;\nrebinding cannot change the verdict;\nmetadata and link-local refused', { color: COLORS.violet });

  s.box('site', 1180, 210, 200, 150, 'Any website\n(public site, read-only)', { color: COLORS.yellow, fontSize: 16 });

  s.arrow('stages', 'http');
  s.arrow('http', 'dns');
  s.arrow('dns', 'site');
  s.arrow('browser', 'route');
  s.arrow('route', 'proxy');
  s.arrow('proxy', 'site');

  s.note(40, 560, 1340, 110, 'What never happens: a redirect or link to another host is followed (it is recorded as out of scope); a bot challenge or\nrate limit is evaded (it is recorded as blocked); a probe or tool sends a POST (writes need an explicit flag, and even then\nonly search or filter forms without sensitive fields); a credential WebMorph observed is replayed on its own authority (D21, D23).', '#fff4e6');
  s.note(40, 700, 1340, 70, 'Evidence is redacted at capture: sensitive query values replaced, request bodies never stored (JSON shapes only),\ncookie and credential headers recorded by name, never by value.', '#f8f9fa');
  return s;
}

// ---------------------------------------------------------------------------------------------
// 3. API first: how a read capability becomes tools.
// ---------------------------------------------------------------------------------------------
function apiFirst() {
  const s = new Scene('api-first', 'API first: how a read capability becomes tools (decision D25)');
  const left = 40;
  s.box('cap', left, 200, 260, 120, 'Read capability\nsearch · list · detail\nfrom the WebsiteModel, with\nmechanics tied to evidence', { color: COLORS.yellow });

  const dx = 400;
  const dw = 360;
  const dh = 170;
  const step = 230;
  const dy0 = 70;
  s.diamond('q1', dx, dy0, dw, dh, 'Public JSON or GraphQL endpoint,\nobserved or documented,\nwithout a credential\n(or with one the operator configured)?', { fontSize: 13 });
  s.diamond('q2', dx, dy0 + step, dw, dh, 'Detail page publishes\nJSON-LD, Open Graph or\nembedded JSON state?', { fontSize: 13 });
  s.diamond('q3', dx, dy0 + 2 * step, dw, dh, 'Result list present in the\nserver-rendered HTML\n(3 or more result links)?', { fontSize: 13 });

  const tx = 860;
  const tw = 330;
  s.box('t1', tx, dy0 + 35, tw, 100, 'HTTP tool  ·  http → extract json\nGET, or GraphQL query over POST;\ndeclared variables become inputs', { color: COLORS.green, fontSize: 13 });
  s.box('t2', tx, dy0 + step + 35, tw, 100, 'HTTP tool  ·  http → html-data\nJSON-LD, meta tags, embedded JSON;\nembedded keys described, never enforced', { color: COLORS.green, fontSize: 13 });
  s.box('t3', tx, dy0 + 2 * step + 35, tw, 100, 'HTTP tool  ·  http → html-list\nlinks from the page, enriched with\nschema.org ItemList offers', { color: COLORS.green, fontSize: 13 });
  const gy = dy0 + 3 * step;
  s.box('gap', dx, gy, dw, 100, 'apiGap, with a reason\nclient-rendered · credentialed · write ·\nno sample · no mechanics', { color: COLORS.red, fontSize: 13 });
  s.box('br', left, gy, 260, 120, 'Browser tool\nnavigate, fill, press, wait,\nassert, extract; named\n<capability>_browser when an\nHTTP route exists, plain otherwise', { color: COLORS.blue, fontSize: 13 });

  s.arrow('cap', 'q1', { via: [[left + 130, dy0 + dh / 2]], from: 'top', to: 'left' });
  s.arrow('q1', 't1', { label: 'yes' });
  s.arrow('q1', 'q2', { label: 'no' });
  s.arrow('q2', 't2', { label: 'yes' });
  s.arrow('q2', 'q3', { label: 'no' });
  s.arrow('q3', 't3', { label: 'yes' });
  s.arrow('q3', 'gap', { label: 'no' });
  s.arrow('cap', 'br', { dashed: true, label: 'always, as the fallback' });

  const vy = gy + 180;
  s.box('val', left, vy, 1210, 100, 'Replay validation ×N against the live site, with the example inputs derived from evidence\nruns succeed · output matches the JSON Schema · output non-empty · results stable across runs · latency within the tool timeout', { color: COLORS.orange });
  const trunk = tx + tw + 30;
  for (const t of ['t1', 't2', 't3']) {
    const b = s.boxes.get(t);
    s.arrow(t, 'val', { via: [[trunk, b.y + b.height / 2], [trunk, vy - 1]], from: 'right', to: 'top' });
  }
  s.arrow('br', 'val', { from: 'bottom', to: 'top' });
  s.box('out', 1300, vy, 230, 100, 'validated → publishable\nfailed → stays draft,\nreason recorded', { color: COLORS.gray, fontSize: 13 });
  s.arrow('val', 'out');

  s.note(1300, dy0 + 35, 230, 200, 'The HTTP route carries the\ncapability\'s own name\n(search_cars, get_car).\n\nAn agent integration is\njudged by the API surface\nit exposes, so the browser\nroute is only the fallback.', '#f8f9fa');
  return s;
}

// ---------------------------------------------------------------------------------------------
// 4. Agent call path at run time.
// ---------------------------------------------------------------------------------------------
function runtime() {
  const s = new Scene('runtime', 'Serving tools: the agent call path');
  const y = 100;
  s.box('agent', 40, y, 220, 120, 'Agent\nany MCP client\n(Claude Code, your app)\ntools/list · tools/call', { color: COLORS.gray });
  s.box('mcp', 330, y, 250, 120, 'MCP server (stdio)\nlists published tools, HTTP first,\nwith JSON Schema in/out and\nreadOnlyHint; structuredContent', { color: COLORS.orange, fontSize: 13 });
  s.box('exec', 650, y - 20, 310, 160, 'ToolExecutor\npublished? read-only? session-free?\nnot degraded? · per-site concurrency ·\ntimeout · call statistics · degrade\nafter 2 consecutive site failures', { color: COLORS.orange, fontSize: 13 });
  s.box('interp', 1040, y, 270, 120, 'Interpreter\ndeclarative steps, never code;\ntyped error codes\n(INPUT_INVALID … SITE_CHANGED)', { color: COLORS.yellow, fontSize: 13 });
  s.box('http', 1040, y + 220, 270, 90, 'SafeHttpClient\nno browser; the same policy\nas discovery', { color: COLORS.blue, fontSize: 13 });
  s.box('br', 1040, y + 360, 270, 90, 'BrowserRuntime\nfresh context per call,\nbehind the policy proxy', { color: COLORS.green, fontSize: 13 });
  s.box('site', 1440, y + 250, 200, 150, 'The website', { color: COLORS.yellow, fontSize: 16 });

  s.box('reg', 650, y + 220, 310, 110, 'registry.json (mutable, per site)\nsnapshot of each published tool pinned\nto the job and artifact IDs it was\nvalidated against; status history; stats', { color: COLORS.gray, fontSize: 13 });
  s.box('cfg', 650, y + 370, 310, 110, 'config.json (mutable, per site, 0600)\noperator-configured credentials,\nresolved by name at run time; never\nstored in artifacts, evidence or logs', { color: COLORS.gray, fontSize: 13 });

  s.arrow('agent', 'mcp');
  s.arrow('mcp', 'exec');
  s.arrow('exec', 'interp');
  s.arrow('interp', 'http', { label: 'http steps' });
  s.arrow('interp', 'br', { via: [[1370, y + 60], [1370, y + 405]], from: 'right', to: 'right', label: 'browser steps' });
  s.arrow('http', 'site');
  s.arrow('br', 'site');
  s.arrow('reg', 'exec', { dashed: true, label: 'policy' });
  s.arrow('cfg', 'interp', { via: [[1000, y + 425], [1000, y + 170], [1070, y + 170]], from: 'right', to: 'bottom', dashed: true });

  s.note(40, y + 220, 540, 150, 'Results carry a run record: per-step status, the extracted output validated\nagainst the output schema, the final URL. Failures carry a code an agent can\nact on. After two consecutive site-change failures a tool is degraded and\nrefused with TOOL_UNAVAILABLE until an operator revalidates it; agents\nnever retry blindly against a changed site.', '#f8f9fa');
  return s;
}

// ---------------------------------------------------------------------------------------------
// 5. Operator-configured credentials for keyed public APIs (D23).
// ---------------------------------------------------------------------------------------------
function credentials() {
  const s = new Scene('credentials', 'Keyed public APIs: the operator configures, discovery never captures (decision D23)');
  const y = 90;
  s.box('obs', 40, y, 290, 130, 'Observed in the browser\nthe site\'s own front end calls\nGET search-api.example/…\nwith Authorization: Bearer pk_…', { color: COLORS.green, fontSize: 13 });
  s.box('ev', 430, y, 290, 130, 'NetworkEvidence record\ncredentialed: true\ncredentialHeaders: ["authorization"]\n(names only; the value is never kept)', { color: COLORS.gray, fontSize: 13 });
  s.box('cfg', 40, y + 230, 290, 130, 'Operator decision\nwebmorph credentials set <site> \\\n  host:authorization=Bearer pk_…\nwritten to config.json (0600) only', { color: COLORS.yellow, fontSize: 13 });
  s.box('man', 430, y + 230, 290, 130, 'SiteManifest.auth.apiCredentials\n{ name, host, header }, copied by\nstage 0 by reference: the job stays\nreproducible without the secret', { color: COLORS.gray, fontSize: 13 });
  s.box('s7', 810, y + 115, 300, 130, 'Stage 7 and the model\nonly credential = configured header\nfor that host, no auth cookie →\n"configured", not "credentialed"', { color: COLORS.blue, fontSize: 13 });
  s.box('tool', 1190, y + 115, 280, 130, 'HTTP tool\nhttp step carries\ncredentialRef: "name"\n(never the value)', { color: COLORS.orange, fontSize: 13 });
  s.box('run', 1190, y + 330, 280, 150, 'Run time (validate, call, MCP)\nresolve the name from config.json;\nsend the header only to the configured\nhost, never across a redirect;\nmissing → PERMISSION_DENIED', { color: COLORS.violet, fontSize: 13 });

  s.arrow('obs', 'ev');
  s.arrow('cfg', 'man');
  s.arrow('ev', 's7');
  s.arrow('man', 's7');
  s.arrow('s7', 'tool');
  s.arrow('tool', 'run');
  s.arrow('cfg', 'run', { via: [[185, y + 560], [1330, y + 560]], from: 'bottom', to: 'bottom', dashed: true, label: 'value read at run time, from the config only' });

  s.note(810, y + 300, 300, 180, 'Configuring a credential is the\noperator\'s statement that the site\nallows the key to be used this way.\nWebMorph never infers permission\nfrom a key\'s prefix or its presence\nin a JavaScript bundle.', '#fff4e6');
  return s;
}

export const scenes = [pipeline(), safety(), apiFirst(), runtime(), credentials()];
