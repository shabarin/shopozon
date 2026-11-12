import type { CardExtraction } from '../shared/types.ts';
import { LIMITS } from '../shared/constants.ts';
import { normalizeText } from '../shared/util.ts';
import { extractSearchQuery } from '../parser/url.ts';
import { extractCard, findCardRoot } from './card-extractor.ts';
import { readJsonLd, type JsonLdIndex } from './jsonld.ts';
import { PRODUCT_LINK_SELECTOR, EXTRACTION_VERSION } from './selectors.ts';

export interface ScannerOptions {
  onCard: (card: CardExtraction) => void;
  isEnabled: () => boolean;
  getSessionId: () => string | null;
  getSourceUrl?: () => string;
  now?: () => Date;
}

interface ProcessedState {
  status: CardExtraction['extraction']['status'];
  attempts: number;
  lastAttemptAt: number;
  signature: string;
  retryScheduled: boolean;
  /** Cheap fingerprint used to notice virtualized DOM nodes reused for another card. */
  quick: string;
}

interface QueueItem {
  root: HTMLElement;
  sourceUrl: string;
  isUpdate: boolean;
}

interface IdleWindow {
  requestIdleCallback?: (callback: (deadline: IdleDeadline) => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

function idleWindow(): IdleWindow {
  return window as unknown as IdleWindow;
}

function cardSignature(card: CardExtraction): string {
  return [
    card.url,
    card.title,
    card.price,
    card.original_price,
    card.rating,
    card.review_count,
    card.seller,
    card.availability,
    card.extraction.status,
  ].join('|');
}

function quickFingerprint(root: HTMLElement): string {
  const hrefs = Array.from(root.querySelectorAll(PRODUCT_LINK_SELECTOR))
    .map((link) => link.getAttribute('href') ?? '')
    .join('|');
  return `${hrefs}#${normalizeText(root.textContent ?? '').slice(0, 120)}`;
}

/**
 * Discovers product cards in the live Ozon DOM. Extraction is done in idle
 * slices, the DOM is scanned at a throttled rate, and every root element is
 * remembered to avoid duplicate work.
 */
export class CardScanner {
  private readonly doc: Document;
  private readonly options: ScannerOptions;
  private processed = new WeakMap<Element, ProcessedState>();
  private queue: QueueItem[] = [];
  private observer: MutationObserver | null = null;
  private enabled = false;
  private scanTimer: number | null = null;
  private retryTimer: number | null = null;
  private idleHandle: number | null = null;
  private initialTimers: number[] = [];
  private currentUrl = '';
  private jsonLd: JsonLdIndex | null = null;
  private jsonLdUrl = '';
  private retryQueue: { root: HTMLElement; sourceUrl: string; attempt: number }[] = [];
  /** Signatures already sent to the background, to avoid recounting re-rendered tiles. */
  private emitted = new Set<string>();
  private currentSessionId: string | null = null;

  constructor(doc: Document, options: ScannerOptions) {
    this.doc = doc;
    this.options = options;
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.currentUrl = this.options.getSourceUrl?.() ?? this.doc.location?.href ?? location.href;
    this.attachObserver();
    this.resetPage(false);
    this.kick(0);
    for (const delay of [800, 2500]) {
      this.initialTimers.push(window.setTimeout(() => this.kick(0), delay));
    }
  }

  isRunning(): boolean {
    return this.enabled;
  }

  stop(): void {
    this.enabled = false;
    this.detachObserver();
    this.queue = [];
    this.retryQueue = [];
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.scanTimer = null;
    this.retryTimer = null;
    for (const timer of this.initialTimers) window.clearTimeout(timer);
    this.initialTimers = [];
    if (this.idleHandle !== null && idleWindow().cancelIdleCallback) {
      idleWindow().cancelIdleCallback?.(this.idleHandle);
    }
    this.idleHandle = null;
  }

  /** Call after an in-page navigation: old card roots are no longer relevant. */
  resetPage(rescan = true): void {
    this.processed = new WeakMap<Element, ProcessedState>();
    this.queue = [];
    this.retryQueue = [];
    this.emitted = new Set<string>();
    this.currentSessionId = this.options.getSessionId();
    this.jsonLd = null;
    this.jsonLdUrl = '';
    this.currentUrl = this.options.getSourceUrl?.() ?? this.doc.location?.href ?? location.href;
    if (rescan && this.enabled) this.kick(0);
  }

  private attachObserver(): void {
    if (this.observer || !this.doc.body) return;
    this.observer = new MutationObserver(() => {
      if (this.enabled) this.kick(LIMITS.scanDebounceMs);
    });
    this.observer.observe(this.doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private detachObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private kick(delay: number): void {
    if (!this.enabled) return;
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      this.scheduleIdleRun();
    }, delay);
  }

  private scheduleIdleRun(): void {
    if (!this.enabled) return;
    if (this.idleHandle !== null) return;
    const runner = (deadline?: IdleDeadline) => {
      this.idleHandle = null;
      if (!this.enabled) return;
      this.scanDocument();
      this.processQueue(deadline);
    };
    const idle = idleWindow().requestIdleCallback;
    if (idle) {
      this.idleHandle = idle.call(window, runner, { timeout: 1200 });
    } else {
      window.setTimeout(() => runner(), 0);
    }
  }

  private scanDocument(): void {
    if (!this.enabled) return;
    const url = this.options.getSourceUrl?.() ?? this.doc.location?.href ?? location.href;
    const sessionId = this.options.getSessionId();
    if (sessionId !== this.currentSessionId) {
      // A new collection session starts: every visible card is a new detection.
      this.currentSessionId = sessionId;
      this.processed = new WeakMap<Element, ProcessedState>();
      this.emitted = new Set<string>();
      this.queue = [];
      this.retryQueue = [];
    }
    if (url !== this.currentUrl) {
      this.currentUrl = url;
      this.processed = new WeakMap<Element, ProcessedState>();
      this.emitted = new Set<string>();
      this.queue = [];
      this.retryQueue = [];
      this.jsonLd = null;
      this.jsonLdUrl = '';
    }
    if (this.jsonLdUrl !== url) {
      this.jsonLd = readJsonLd(this.doc);
      this.jsonLdUrl = url;
    }

    const links = this.doc.querySelectorAll(PRODUCT_LINK_SELECTOR);
    for (const link of links) {
      const root = findCardRoot(link);
      if (!root || !root.isConnected) continue;
      const quick = quickFingerprint(root);
      const existing = this.processed.get(root);
      if (existing) {
        if (existing.quick !== quick) {
          // Virtualized lists reuse a root element for a different product.
          this.processed.set(root, {
            status: 'failed',
            attempts: 0,
            lastAttemptAt: Date.now(),
            signature: '',
            retryScheduled: false,
            quick,
          });
          this.queue.push({ root, sourceUrl: url, isUpdate: false });
          continue;
        }
        this.maybeQueueRetry(root, existing, url);
        continue;
      }
      this.processed.set(root, {
        status: 'failed',
        attempts: 0,
        lastAttemptAt: Date.now(),
        signature: '',
        retryScheduled: false,
        quick,
      });
      this.queue.push({ root, sourceUrl: url, isUpdate: false });
    }
  }

  private maybeQueueRetry(root: HTMLElement, state: ProcessedState, sourceUrl: string): void {
    if (state.status === 'success') return;
    if (state.retryScheduled) return;
    if (state.attempts >= 1 + LIMITS.maxExtractionRetries) return;
    const delay = LIMITS.scanRetryDelaysMs[Math.min(state.attempts - 1, LIMITS.scanRetryDelaysMs.length - 1)];
    if (Date.now() - state.lastAttemptAt < (delay ?? 4000)) return;
    state.retryScheduled = true;
    this.retryQueue.push({ root, sourceUrl, attempt: state.attempts });
    this.scheduleRetryFlush(150);
  }

  private scheduleRetryFlush(delay: number): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.enabled) return;
      const retries = this.retryQueue.splice(0);
      for (const item of retries) {
        if (!item.root.isConnected) continue;
        const state = this.processed.get(item.root);
        if (state) state.retryScheduled = false;
        this.queue.push({ root: item.root, sourceUrl: item.sourceUrl, isUpdate: true });
      }
      this.scheduleIdleRun();
    }, delay);
  }

  private processQueue(deadline?: IdleDeadline): void {
    const started = Date.now();
    let processed = 0;
    while (this.queue.length > 0 && processed < 12) {
      if (deadline && deadline.timeRemaining() < 2 && processed > 0) break;
      if (!deadline && Date.now() - started > 12) break;
      const item = this.queue.shift();
      if (!item) break;
      if (!item.root.isConnected) continue;
      processed += 1;
      this.processItem(item);
    }
    if (this.queue.length > 0) this.scheduleIdleRun();
  }

  private processItem(item: QueueItem): void {
    const sessionId = this.options.getSessionId();
    if (!this.enabled || !sessionId) return;
    const state = this.processed.get(item.root);
    if (!state) return;
    const now = this.options.now?.() ?? new Date();
    const card = extractCard(item.root, {
      sourceUrl: item.sourceUrl,
      searchQuery: extractSearchQuery(item.sourceUrl),
      collectedAt: now.toISOString(),
      jsonLdIndex: this.jsonLd,
      version: EXTRACTION_VERSION,
      isUpdate: item.isUpdate,
    });
    const signature = cardSignature(card);
    const changed = signature !== state.signature;
    state.attempts += 1;
    state.lastAttemptAt = Date.now();
    state.status = card.extraction.status;
    state.signature = signature;
    state.quick = quickFingerprint(item.root);

    if (changed && (item.isUpdate || !this.emitted.has(signature))) {
      this.emitted.add(signature);
      this.options.onCard(card);
    }
    if (state.status !== 'success' && state.attempts <= LIMITS.maxExtractionRetries) {
      state.retryScheduled = true;
      this.scheduleRetryFlush(LIMITS.scanRetryDelaysMs[Math.min(state.attempts - 1, LIMITS.scanRetryDelaysMs.length - 1)] ?? 2500);
      this.retryQueue.push({ root: item.root, sourceUrl: item.sourceUrl, attempt: state.attempts });
    }
  }
}
