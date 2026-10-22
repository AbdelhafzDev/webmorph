import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { FileArtifactStore } from '../core/store.js';
import type { Logger } from '../core/job.js';
import { silentLogger } from '../core/job.js';
import { newJobId } from '../core/ids.js';
import { BrowserRuntime, gotoWithPolicy, type IsolatedContext } from '../browser/runtime.js';
import { quickState } from '../browser/inspect.js';
import { buildLocators } from '../browser/locators.js';
import { CONSEQUENTIAL_PATTERN } from '../browser/classify.js';
import { ScopePolicy } from '../net/scope.js';
import type { Resolver } from '../net/ssrf.js';
import type { SiteManifest } from '../schemas/siteManifest.js';
import { RecordingSession, RECORDING_VERSION, type ElementDescriptor, type RecordedEvent, type RecordedState } from '../schemas/recording.js';
import type { RawElement } from '../browser/collect.js';
import { BINDING_NAME, buildInstrumentScript, type InPageElement, type InPageEvent } from './instrument.js';

export interface RecorderOptions {
  store: FileArtifactStore;
  siteId: string;
  manifest: SiteManifest;
  startUrl: string;
  /** Keep typed values of non-sensitive fields. Default false: only field semantics are kept. */
  keepValues?: boolean;
  screenshots?: boolean;
  headed?: boolean;
  maxMinutes?: number;
  resolver?: Resolver;
  logger?: Logger;
  now?: () => Date;
}

/**
 * Mode A recording: a browser WebMorph owns, in which a person performs a
 * workflow. Every action becomes a semantic event with locators and before and
 * after states, streamed to disk as it happens. Credentials never leave the page.
 */
export class Recorder {
  readonly sessionId: string;
  readonly dir: string;
  private runtime?: BrowserRuntime;
  private ctx?: IsolatedContext;
  private page?: Page;
  private session: RecordingSession;
  private seq = 0;
  private last: RecordedState | undefined;
  /** The latest event, held until the next event or stop supplies its after-state. */
  private pending: RecordedEvent | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private closed?: Promise<void>;
  private resolveClosed?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: RecorderOptions) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.sessionId = `rec-${newJobId(this.now())}`;
    this.dir = options.store.recordingDir(options.siteId, this.sessionId);
    this.session = {
      schemaVersion: RECORDING_VERSION,
      sessionId: this.sessionId,
      siteId: options.siteId,
      jobId: options.manifest.jobId,
      startUrl: options.startUrl,
      startedAt: this.now().toISOString(),
      status: 'recording',
      policy: { keepValues: options.keepValues ?? false, screenshots: options.screenshots ?? false, allowWrites: true, headed: options.headed ?? true },
      eventCount: 0,
      pagesVisited: [],
      networkRecords: 0,
      notes: ['Typed values are redacted unless keepValues was set; sensitive fields are always redacted.', 'Writes performed by the person are allowed; nothing is replayed during recording.'],
    };
  }

  /** Launch the browser, open the start page and begin capturing. Returns the page for programmatic driving (tests). */
  async start(): Promise<{ sessionId: string; page: Page }> {
    const m = this.options.manifest.data;
    const scope = new ScopePolicy(m.scope, { hosts: m.prohibited.hosts, pathPatterns: m.prohibited.pathPatterns });
    this.runtime = new BrowserRuntime({
      scope,
      allowPrivate: m.scope.allowPrivateNetwork,
      userAgent: m.scope.userAgent,
      headed: this.options.headed ?? true,
      allowWrites: true,
      blockHeavyResources: false,
      resolver: this.options.resolver,
      captureNetwork: true,
      now: this.now,
    });
    await this.runtime.launch();
    this.ctx = await this.runtime.newContext({ pageUrl: this.options.startUrl });
    await mkdir(this.dir, { recursive: true });
    await this.writeSession();

    const context = this.ctx.context;
    await context.exposeBinding(BINDING_NAME, async (_source, payload: InPageEvent) => {
      // Snapshot now, while the page is still in the state the person acted on.
      const state = await this.snapshot();
      this.enqueue(() => this.onInPageEvent(payload, state));
    });
    await context.addInitScript(buildInstrumentScript());
    this.page = await context.newPage();
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.page.on('close', () => this.resolveClosed?.());
    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page?.mainFrame()) return;
      const url = frame.url(); // read now; the frame moves on
      this.enqueue(() => this.onNavigation(url));
    });
    if (this.options.maxMinutes) this.timer = setTimeout(() => void this.stop('time limit reached'), this.options.maxMinutes * 60_000);

    const nav = await gotoWithPolicy(this.page, this.options.startUrl, { timeout: m.budget.pageLoadTimeoutMs });
    void nav;
    return { sessionId: this.sessionId, page: this.page };
  }

  /** Resolves when the person closes the page or the session is stopped. */
  waitForClose(): Promise<void> {
    return this.closed ?? Promise.resolve();
  }

  async stop(reason = 'stopped'): Promise<RecordingSession> {
    if (this.timer) clearTimeout(this.timer);
    await this.chain;
    await this.flushPending(await this.snapshot());
    if (this.session.status === 'recording') {
      this.session.status = reason === 'aborted' ? 'aborted' : 'completed';
      this.session.endedAt = this.now().toISOString();
      this.session.notes.push(`ended: ${reason}`);
    }
    if (this.ctx) {
      for (const r of this.ctx.stats.network) await appendFile(join(this.dir, 'network.jsonl'), JSON.stringify(r) + '\n');
      this.session.networkRecords = this.ctx.stats.network.length;
      await this.ctx.close();
      this.ctx = undefined;
    }
    await this.runtime?.close();
    this.runtime = undefined;
    await this.writeSession();
    this.resolveClosed?.();
    this.logger.info(`recording ${this.sessionId}: ${this.session.status}, ${this.session.eventCount} events, ${this.session.pagesVisited.length} pages`);
    return this.session;
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((err) => this.logger.warn(`recorder: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async writeSession(): Promise<void> {
    await writeFile(join(this.dir, 'session.json'), JSON.stringify(RecordingSession.parse(this.session), null, 2));
  }

  /** Cheap, immediate state capture. Undefined while the page is between documents. */
  private async snapshot(): Promise<RecordedState | undefined> {
    if (!this.page || this.page.isClosed()) return undefined;
    try {
      const q = await quickState(this.page);
      return { url: q.url, title: q.title || undefined, textLength: q.textLength, stateHash: q.stateHash };
    } catch {
      return undefined;
    }
  }

  private async flushPending(after: RecordedState | undefined): Promise<void> {
    const event = this.pending;
    if (!event) return;
    this.pending = undefined;
    if (after && !event.after) event.after = after;
    await appendFile(join(this.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    this.session.eventCount += 1;
    this.logger.info(`event ${event.seq} ${event.type}${event.target?.name ? ` "${event.target.name}"` : ''}${event.navigation ? ` -> ${event.navigation.to}` : ''}`);
  }

  private async screenshot(): Promise<RecordedEvent['screenshot']> {
    if (!this.options.screenshots || !this.page || this.page.isClosed()) return undefined;
    try {
      const buf = await this.page.screenshot({ type: 'png' });
      return this.options.store.writeBlob(this.options.siteId, this.sessionId, 'screenshots', 'image/png', buf, '.png').then((b) => ({ ...b, path: b.path }));
    } catch {
      return undefined;
    }
  }

  private toDescriptor(el: InPageElement): ElementDescriptor {
    const raw: RawElement = {
      index: 0,
      tag: el.tag,
      role: el.role,
      name: el.name,
      text: el.text,
      attrs: { ...el.attrs },
      visible: true,
      inViewport: true,
      region: undefined,
      inDialog: el.inDialog,
      inDetails: false,
      isSubmit: el.isSubmit,
      stableId: el.stableId,
      cssPath: el.cssPath,
      counts: el.counts,
    };
    const label = `${el.name ?? ''} ${el.text ?? ''} ${el.attrs.value ?? ''}`;
    const consequential = (el.tag === 'a' || el.tag === 'button' || el.isSubmit) && (CONSEQUENTIAL_PATTERN.test(label) || (el.isSubmit && el.formMethod === 'post'));
    return {
      tag: el.tag,
      role: el.role,
      name: el.name,
      text: el.text,
      attributes: { id: el.attrs.id, name: el.attrs.name, type: el.attrs.type, href: el.attrs.href, testId: el.attrs.testId, ariaLabel: el.attrs.ariaLabel, placeholder: el.attrs.placeholder },
      locators: buildLocators(raw),
      formAction: el.formAction,
      formMethod: el.formMethod,
      isSubmit: el.isSubmit,
      inDialog: el.inDialog,
      consequential,
      ...(el.resultContext ? { resultContext: el.resultContext } : {}),
    };
  }

  /** Record an action: the state captured when it happened is its before-state and the previous event's after-state. */
  private async emit(partial: Omit<RecordedEvent, 'sessionId' | 'seq' | 'at' | 'pageUrl' | 'before' | 'after' | 'status' | 'screenshot'> & { status?: RecordedEvent['status'] }, state: RecordedState | undefined, after?: RecordedState): Promise<void> {
    await this.flushPending(state);
    const before = state ?? this.last;
    const screenshot = await this.screenshot();
    const event: RecordedEvent = {
      sessionId: this.sessionId,
      seq: this.seq++,
      at: this.now().toISOString(),
      pageUrl: before?.url ?? this.page?.url() ?? this.options.startUrl,
      ...partial,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(screenshot ? { screenshot } : {}),
      status: partial.status ?? 'ok',
    };
    this.last = after ?? state ?? this.last;
    this.pending = event;
  }

  private async onNavigation(url: string): Promise<void> {
    if (!this.session.pagesVisited.includes(url)) this.session.pagesVisited.push(url);
    await this.page?.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
    const loaded = await this.snapshot();
    const from = this.last?.url;
    await this.emit({ type: 'navigation', navigation: { from, to: url, title: loaded?.title } }, loaded, loaded);
    await this.writeSession();
  }

  private async onInPageEvent(payload: InPageEvent, state: RecordedState | undefined): Promise<void> {
    const target = this.toDescriptor(payload.target);
    if (payload.type === 'click') return this.emit({ type: 'click', target }, state);
    if (payload.type === 'submit') return this.emit({ type: 'submit', target }, state);
    if (payload.type === 'key') return this.emit({ type: 'key', key: payload.key, target }, state);
    const keep = this.options.keepValues && !payload.sensitive && payload.value !== undefined;
    return this.emit({
      type: payload.type,
      target,
      input: {
        fieldType: payload.fieldType,
        valueKind: payload.valueKind,
        valueLength: payload.valueLength,
        redacted: !keep,
        ...(keep ? { value: payload.value } : {}),
        ...(payload.optionLabel ? { optionLabel: payload.optionLabel } : {}),
      },
    }, state);
  }
}
