import type {
  CardExtraction,
  ExportFormat,
  ExportRequest,
  ExportScope,
  IngestResult,
  Stats,
} from '../shared/types.ts';
import {
  DEFAULT_STATE,
  EXTENSION_VERSION,
  MSG,
  OZON_MATCH_PATTERNS,
  PARSER_VERSION,
  STORAGE_KEYS,
} from '../shared/constants.ts';
import { sleep } from '../shared/util.ts';
import { extractSearchQuery, isOzonUrl } from '../parser/url.ts';
import { buildExport } from '../export/index.ts';
import { CollectorRepository } from '../storage/repository.ts';
import {
  BrowserStorage,
  ext,
  isFirefox,
  queryTabs,
  sendTabMessage,
  setBadge,
} from '../adapters/browser.ts';

const repository = new CollectorRepository({ store: new BrowserStorage() });

let serialChain: Promise<void> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = serialChain.then(task, task);
  serialChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const initialized = repository.ensureInitialized();

async function retry<T>(task: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

async function broadcast(message: unknown): Promise<void> {
  const tabs = await queryTabs({ url: [...OZON_MATCH_PATTERNS] });
  const seen = new Set<number>();
  const tasks: Promise<boolean>[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tasks.push(sendTabMessage(tab.id, message));
  }
  await Promise.all(tasks);
}

async function updateBadge(): Promise<void> {
  try {
    const stats = await repository.getStats();
    if (!stats.enabled) {
      await setBadge('');
      return;
    }
    const count = stats.active_session?.unique_products ?? 0;
    await setBadge(count > 999 ? '999+' : String(count));
  } catch {
    await setBadge('');
  }
}

async function getStatsPayload(): Promise<{
  ok: true;
  stats: Stats;
  version: string;
  parser_version: string;
  browser: 'firefox' | 'chrome';
}> {
  await initialized;
  const stats = await repository.getStats();
  return {
    ok: true,
    stats,
    version: EXTENSION_VERSION,
    parser_version: PARSER_VERSION,
    browser: isFirefox ? 'firefox' : 'chrome',
  };
}

async function startCollection(initialUrl: string | null, searchQuery: string | null): Promise<unknown> {
  await initialized;
  const state = await repository.getState();
  if (!state.enabled && state.active_session_id) {
    await repository.stopSession(
      state.active_session_id,
      'interrupted',
      'Предыдущая незавершённая сессия остановлена перед началом новой.',
    );
  }
  if (state.enabled && state.active_session_id) {
    return getStatsPayload();
  }
  const safeUrl = isOzonUrl(initialUrl) ? initialUrl : null;
  await repository.startSession(safeUrl, searchQuery ?? extractSearchQuery(safeUrl));
  await broadcast({ type: MSG.collectorChanged });
  await updateBadge();
  return getStatsPayload();
}

async function stopCollection(): Promise<unknown> {
  await initialized;
  const state = await repository.getState();
  const target = state.active_session_id ?? state.last_session_id;
  if (target) {
    await repository.stopSession(target, 'stopped');
  } else if (state.enabled) {
    await repository.stopSession(null, 'stopped');
  }
  await broadcast({ type: MSG.collectorFlush });
  await broadcast({ type: MSG.collectorChanged });
  await updateBadge();
  return getStatsPayload();
}

function safeSenderUrl(sender: { url?: string }, payloadSourceUrl: unknown): string | null {
  const senderUrl = sender.url && isOzonUrl(sender.url) ? sender.url : null;
  if (senderUrl) return senderUrl;
  return typeof payloadSourceUrl === 'string' && isOzonUrl(payloadSourceUrl)
    ? payloadSourceUrl
    : null;
}

async function ingestCards(
  message: { payload?: unknown },
  sender: { id?: string; url?: string },
): Promise<IngestResult> {
  if (sender.id && ext.runtime.id && sender.id !== ext.runtime.id) {
    return {
      ok: false,
      code: 'invalid_payload',
      accepted: 0,
      duplicates: 0,
      cards_discovered: 0,
      errors: 0,
      unique_in_session: 0,
      total_products: 0,
      warning: null,
      message: 'Недопустимый источник сообщения.',
    };
  }
  const payload =
    message.payload && typeof message.payload === 'object'
      ? (message.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.sessionId !== 'string' || !Array.isArray(payload.cards)) {
    return {
      ok: false,
      code: 'invalid_payload',
      accepted: 0,
      duplicates: 0,
      cards_discovered: 0,
      errors: 0,
      unique_in_session: 0,
      total_products: 0,
      warning: null,
      message: 'Некорректный пакет карточек.',
    };
  }
  const sourceUrl = safeSenderUrl(sender, payload.sourceUrl);
  if (!sourceUrl) {
    return {
      ok: false,
      code: 'invalid_payload',
      accepted: 0,
      duplicates: 0,
      cards_discovered: 0,
      errors: 0,
      unique_in_session: 0,
      total_products: 0,
      warning: null,
      message: 'Сообщение пришло не со страницы Ozon.',
    };
  }

  await initialized;
  try {
    const result = await retry(
      () =>
        repository.ingestBatch(
          payload.sessionId as string,
          payload.cards as CardExtraction[],
          sourceUrl,
          typeof payload.searchQuery === 'string' ? payload.searchQuery : null,
        ),
      3,
      250,
    );
    await updateBadge();
    return result;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    try {
      await repository.setWarning(
        `Ошибка локальной записи: ${messageText}. Данные в памяти вкладки будут отправлены повторно.`,
      );
    } catch {
      // A warning write can fail for the same reason as the original write.
    }
    return {
      ok: false,
      code: 'storage_error',
      accepted: 0,
      duplicates: 0,
      cards_discovered: 0,
      errors: 0,
      unique_in_session: 0,
      total_products: 0,
      warning: null,
      message: messageText,
    };
  }
}

async function clearData(): Promise<unknown> {
  await initialized;
  const state = await repository.getState();
  if (state.active_session_id) {
    await repository.stopSession(state.active_session_id, 'stopped');
  }
  await repository.clearAll();
  await broadcast({ type: MSG.collectorCleared });
  await updateBadge();
  return getStatsPayload();
}

async function exportData(request: unknown): Promise<unknown> {
  await initialized;
  const raw = request && typeof request === 'object' ? (request as Partial<ExportRequest>) : {};
  const format: ExportFormat =
    raw.format === 'products-csv' || raw.format === 'observations-csv' || raw.format === 'json'
      ? raw.format
      : 'json';
  const scope: ExportScope = raw.scope === 'session' ? 'session' : 'all';
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : null;
  try {
    const bundle = await repository.getExportBundle(scope, sessionId);
    return buildExport(bundle, format, scope);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleMessage(
  message: unknown,
  sender: { id?: string; url?: string },
): Promise<unknown> {
  const type = (message as { type?: string } | null)?.type;
  switch (type) {
    case MSG.stateGet:
      return getStatsPayload();
    case MSG.collectorStart: {
      const payload = (message as { initialUrl?: unknown; searchQuery?: unknown }).initialUrl;
      const initialUrl = typeof payload === 'string' ? payload : null;
      const searchQuery = (message as { searchQuery?: unknown }).searchQuery;
      return serial(() =>
        startCollection(initialUrl, typeof searchQuery === 'string' ? searchQuery : null),
      );
    }
    case MSG.collectorStop:
      return serial(stopCollection);
    case MSG.ingestCards:
      return serial(() => ingestCards(message as { payload?: unknown }, sender));
    case MSG.dataClear:
      return serial(clearData);
    case MSG.dataExport:
      return serial(() => exportData((message as { payload?: unknown }).payload));
    default:
      return { ok: false, error: 'Неизвестный тип сообщения.' };
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

ext.runtime.onInstalled.addListener(() => {
  void serial(async () => {
    await initialized;
    await updateBadge();
  });
});

ext.runtime.onStartup.addListener(() => {
  void serial(async () => {
    await initialized;
    await repository.recoverOnStartup();
    await updateBadge();
  });
});

void serial(async () => {
  await initialized;
  const state = await repository.getState();
  if (!state.parser_version) {
    await ext.storage.local.set({
      [STORAGE_KEYS.state]: { ...DEFAULT_STATE, parser_version: PARSER_VERSION },
    });
  }
  await updateBadge();
});
