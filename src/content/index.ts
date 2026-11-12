import type { CardExtraction, CollectorState, IngestResult } from '../shared/types.ts';
import { LIMITS, MSG, STORAGE_KEYS } from '../shared/constants.ts';
import { extractSearchQuery, isListingPage, isOzonHost } from '../parser/url.ts';
import { BrowserStorage, ext, runtimeSendMessage } from '../adapters/browser.ts';
import { CardScanner } from './scanner.ts';

const storage = new BrowserStorage();

interface PendingCard {
  card: CardExtraction;
  sessionId: string;
  attempts: number;
}

let collectorState: CollectorState | null = null;
let scanner: CardScanner | null = null;
let pending: PendingCard[] = [];
let flushTimer: number | null = null;
let inFlight = false;
let currentUrl = location.href;
let alive = true;

function parseState(raw: unknown): CollectorState | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  return {
    schema_version: typeof source.schema_version === 'number' ? source.schema_version : 1,
    enabled: source.enabled === true,
    active_session_id: typeof source.active_session_id === 'string' ? source.active_session_id : null,
    last_session_id: typeof source.last_session_id === 'string' ? source.last_session_id : null,
    started_at: typeof source.started_at === 'string' ? source.started_at : null,
    last_extraction_at:
      typeof source.last_extraction_at === 'string' ? source.last_extraction_at : null,
    last_source_url: typeof source.last_source_url === 'string' ? source.last_source_url : null,
    warning: typeof source.warning === 'string' ? source.warning : null,
    warning_at: typeof source.warning_at === 'string' ? source.warning_at : null,
    parser_version: typeof source.parser_version === 'string' ? source.parser_version : 'unknown',
  };
}

function isCollecting(): boolean {
  return Boolean(
    alive &&
      collectorState?.enabled &&
      collectorState.active_session_id &&
      isListingPage(location.href),
  );
}

function sessionId(): string | null {
  return collectorState?.active_session_id ?? null;
}

function scheduleFlush(delay: number): void {
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

function handleCard(card: CardExtraction): void {
  const currentSession = sessionId();
  if (!currentSession || !alive) return;
  pending.push({ card, sessionId: currentSession, attempts: 0 });
  scheduleFlush(pending.length >= LIMITS.ingestBatchSize ? 100 : LIMITS.ingestFlushDelayMs);
}

async function flush(): Promise<void> {
  if (!alive || inFlight || pending.length === 0) return;
  const targetSession = pending[0]?.sessionId;
  if (!targetSession) return;
  const batch: PendingCard[] = [];
  while (pending.length > 0 && pending[0]?.sessionId === targetSession && batch.length < LIMITS.ingestBatchSize) {
    const item = pending.shift();
    if (item) batch.push(item);
  }
  if (batch.length === 0) return;

  inFlight = true;
  const last = batch[batch.length - 1];
  const sourceUrl = last?.card.source_url || location.href;
  const searchQuery =
    last?.card.search_query ?? extractSearchQuery(sourceUrl) ?? null;
  try {
    const response = await runtimeSendMessage<IngestResult>({
      type: MSG.ingestCards,
      payload: {
        sessionId: targetSession,
        sourceUrl,
        searchQuery,
        cards: batch.map((item) => item.card),
      },
    });
    const fatal =
      !response ||
      response.code === 'session_not_found' ||
      response.code === 'invalid_payload' ||
      response.code === 'quality_rejected';
    if (fatal) {
      // session_not_found means the user cleared data or started another session.
      // quality_rejected is already counted by the background.
      if (response?.code === 'session_not_found') void refreshState();
    } else if (!response.ok) {
      requeue(batch);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/context invalidated|extension context/i.test(message)) {
      alive = false;
      scanner?.stop();
      pending = [];
      return;
    }
    requeue(batch);
  } finally {
    inFlight = false;
    if (pending.length > 0) scheduleFlush(120);
  }
}

function requeue(batch: PendingCard[]): void {
  const retryable = batch
    .map((item) => ({ ...item, attempts: item.attempts + 1 }))
    .filter((item) => item.attempts <= 3);
  if (retryable.length === 0) {
    console.warn('[Ozon Collector] Пакет карточек не сохранён после нескольких попыток.');
    return;
  }
  pending = [...retryable, ...pending];
  scheduleFlush(4000);
}

async function refreshState(): Promise<void> {
  const loaded = await storage.get([STORAGE_KEYS.state]);
  applyState(parseState(loaded[STORAGE_KEYS.state]));
}

function applyState(next: CollectorState | null): void {
  const previousSession = collectorState?.active_session_id ?? null;
  const wasEnabled = collectorState?.enabled === true;
  collectorState = next;
  const nextSession = next?.active_session_id ?? null;

  if (previousSession && previousSession !== nextSession) {
    void flush();
    if (nextSession && scanner?.isRunning()) {
      // A new session starts: count every card currently on the page again.
      scanner.resetPage(true);
    }
  }
  if (wasEnabled && next?.enabled !== true) {
    void flush();
  }

  syncScanner();
}

function syncScanner(): void {
  if (!alive) {
    scanner?.stop();
    return;
  }
  if (!document.body) return;
  if (!scanner) {
    scanner = new CardScanner(document, {
      onCard: handleCard,
      isEnabled: isCollecting,
      getSessionId: sessionId,
      getSourceUrl: () => location.href,
    });
  }
  if (isCollecting()) {
    if (!scanner.isRunning()) scanner.start();
  } else {
    scanner.stop();
  }
}

function checkUrlChange(): void {
  const nextUrl = location.href;
  if (nextUrl === currentUrl) return;
  const previousUrl = currentUrl;
  currentUrl = nextUrl;
  void flush();
  if (previousUrl !== nextUrl) {
    // Ignore hash-only changes for scanner state, but still allow a rescan.
    if (scanner?.isRunning()) {
      scanner.resetPage(isListingPage(nextUrl));
    }
  }
  syncScanner();
}

function onUrlEvent(): void {
  window.setTimeout(checkUrlChange, 0);
}

async function init(): Promise<void> {
  if (!isOzonHost(location.hostname)) return;
  if (!document.body) {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }
  try {
    await refreshState();
  } catch (error) {
    console.warn('[Ozon Collector] Не удалось прочитать состояние сбора.', error);
  }
  currentUrl = location.href;
  syncScanner();

  // Low-frequency URL fallback for SPA navigation; DOM work itself is mutation-driven.
  window.setInterval(checkUrlChange, 2000);
  window.addEventListener('popstate', onUrlEvent);
  window.addEventListener('hashchange', onUrlEvent);
  const navigation = (window as unknown as { navigation?: { addEventListener?: (type: string, cb: () => void) => void } })
    .navigation;
  navigation?.addEventListener?.('navigate', onUrlEvent);

  ext.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEYS.state];
    if (!change) return;
    applyState(parseState(change.newValue));
  });

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id && ext.runtime.id && sender.id !== ext.runtime.id) return;
    const type = (message as { type?: string } | null)?.type;
    if (type === MSG.collectorFlush) {
      void flush();
      sendResponse({ ok: true });
    } else if (type === MSG.collectorCleared) {
      pending = [];
      scanner?.stop();
      scanner?.resetPage(false);
      sendResponse({ ok: true });
    } else if (type === MSG.collectorChanged) {
      void refreshState();
      sendResponse({ ok: true });
    }
  });

  window.addEventListener('beforeunload', () => {
    void flush();
  });

  if (location.href !== currentUrl) checkUrlChange();
}

void init();
