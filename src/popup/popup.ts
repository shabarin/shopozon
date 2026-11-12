import type { ExportFormat, ExportResult, SessionSummary, Stats } from '../shared/types.ts';
import { MSG } from '../shared/constants.ts';
import { extractSearchQuery, isOzonListingUrl, isOzonUrl } from '../parser/url.ts';
import { ext, queryTabs, runtimeSendMessage } from '../adapters/browser.ts';

interface StatsResponse {
  ok: boolean;
  stats?: Stats;
  version?: string;
  parser_version?: string;
  browser?: 'firefox' | 'chrome';
  error?: string;
}

interface ActionPayload {
  ok: boolean;
  stats?: Stats;
  error?: string;
}

const elements = {
  version: byId('version'),
  browser: byId('browser'),
  status: byId('status'),
  statusText: byId('status-text'),
  warning: byId('warning'),
  cards: byId('stat-cards'),
  unique: byId('stat-unique'),
  total: byId('stat-total'),
  errors: byId('stat-errors'),
  currentUrl: byId('current-url'),
  startedAt: byId('started-at'),
  lastExtraction: byId('last-extraction'),
  start: byId('start') as HTMLButtonElement,
  stop: byId('stop') as HTMLButtonElement,
  scope: byId('scope') as HTMLSelectElement,
  exportProducts: byId('export-products') as HTMLButtonElement,
  exportObservations: byId('export-observations') as HTMLButtonElement,
  exportJson: byId('export-json') as HTMLButtonElement,
  clear: byId('clear') as HTMLButtonElement,
  footerStats: byId('footer-stats'),
  parserVersion: byId('parser-version'),
  message: byId('message'),
};

let stats: Stats | null = null;
let activeTabUrl: string | null = null;
let refreshInFlight = false;
let busy = false;
let toastTimer: number | null = null;

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element #${id}`);
  return element;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortUrl(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    const url = new URL(value);
    const text = `${url.hostname}${url.pathname}${url.search}`;
    return text.length > 54 ? `${text.slice(0, 51)}…` : text;
  } catch {
    return value.length > 54 ? `${value.slice(0, 51)}…` : value;
  }
}

function showMessage(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  elements.message.textContent = text;
  elements.message.className = `message ${kind === 'info' ? '' : kind}`;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  if (text) {
    toastTimer = window.setTimeout(() => {
      elements.message.textContent = '';
      elements.message.className = 'message';
      toastTimer = null;
    }, 5000);
  }
}

function setBusy(next: boolean): void {
  busy = next;
  applyButtonState();
}

function currentSession(): SessionSummary | null {
  return stats?.active_session ?? stats?.last_session ?? null;
}

function applyButtonState(): void {
  if (!stats) {
    elements.start.disabled = true;
    elements.stop.disabled = true;
    elements.clear.disabled = true;
    for (const button of [elements.exportProducts, elements.exportObservations, elements.exportJson]) {
      button.disabled = true;
    }
    return;
  }
  elements.start.disabled = busy || stats.enabled;
  elements.stop.disabled = busy || !stats.enabled;
  const hasData = stats.total_products > 0 || stats.sessions.length > 0;
  elements.clear.disabled = busy || !hasData;
  for (const button of [elements.exportProducts, elements.exportObservations, elements.exportJson]) {
    button.disabled = busy || !hasData;
  }
}

function scopeFingerprint(): string {
  return `${stats?.active_session?.session_id ?? '-'}|${(stats?.sessions ?? [])
    .map((item) => item.session_id)
    .join(',')}`;
}

let previousScopeFingerprint = '';

function rebuildScopeOptions(): void {
  const fingerprint = scopeFingerprint();
  if (fingerprint === previousScopeFingerprint) return;
  previousScopeFingerprint = fingerprint;
  const previous = elements.scope.value || 'all';
  elements.scope.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'Все данные';
  elements.scope.appendChild(allOption);

  const activeSession = stats?.active_session;
  if (activeSession) {
    const option = document.createElement('option');
    option.value = 'active';
    option.textContent = `Текущая сессия · ${formatDate(activeSession.started_at)}`;
    elements.scope.appendChild(option);
  }

  const sessions = [...(stats?.sessions ?? [])].sort((a, b) => {
    return Date.parse(b.started_at) - Date.parse(a.started_at);
  });
  for (const session of sessions) {
    if (activeSession && session.session_id === activeSession.session_id) continue;
    const option = document.createElement('option');
    option.value = session.session_id;
    const query = session.search_query ? ` · ${session.search_query.slice(0, 28)}` : '';
    option.textContent = `${formatDate(session.started_at)}${query} · ${session.unique_products} тов.`;
    elements.scope.appendChild(option);
  }

  const values = new Set(Array.from(elements.scope.options).map((option) => option.value));
  elements.scope.value = values.has(previous) ? previous : 'all';
}

function applyStats(next: Stats): void {
  stats = next;
  const session = currentSession();
  elements.cards.textContent = String(session?.cards_discovered ?? 0);
  elements.unique.textContent = String(session?.unique_products ?? 0);
  elements.total.textContent = String(next.total_products);
  elements.errors.textContent = String(session?.errors ?? 0);

  const enabled = next.enabled;
  elements.status.className = `status ${enabled ? 'status-on' : 'status-off'}`;
  elements.statusText.textContent = enabled ? 'Сбор включён' : 'Сбор выключен';

  if (next.warning) {
    elements.warning.hidden = false;
    elements.warning.textContent = next.warning;
  } else {
    elements.warning.hidden = true;
    elements.warning.textContent = '';
  }

  const source = activeTabUrl && isOzonUrl(activeTabUrl) ? activeTabUrl : next.last_source_url;
  elements.currentUrl.textContent = source ? shortUrl(source) : 'Откройте поиск Ozon';
  elements.currentUrl.title = source ?? '';
  elements.startedAt.textContent = formatDate(session?.started_at ?? next.started_at);
  elements.lastExtraction.textContent = formatDate(next.last_extraction_at);
  elements.footerStats.textContent = `Сессий: ${next.sessions.length} · частичных: ${session?.partial ?? 0}`;
  elements.parserVersion.textContent = `Парсер ${next.parser_version}`;
  rebuildScopeOptions();
  applyButtonState();
}

function applyActionPayload(payload: ActionPayload): void {
  if (payload.stats) applyStats(payload.stats);
  if (payload.ok === false && payload.error) showMessage(payload.error, 'error');
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    activeTabUrl = tabs[0]?.url ?? null;
    const payload = await runtimeSendMessage<StatsResponse>({ type: MSG.stateGet });
    if (payload && payload.ok && payload.stats) {
      elements.version.textContent = payload.version ?? '';
      elements.browser.textContent = payload.browser === 'firefox' ? 'Firefox' : 'Chrome';
      applyStats(payload.stats);
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    refreshInFlight = false;
  }
}

async function startCollection(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const url = tabs[0]?.url ?? null;
    const initialUrl = url && isOzonListingUrl(url) ? url : null;
    const payload = await runtimeSendMessage<StatsResponse>({
      type: MSG.collectorStart,
      initialUrl,
      searchQuery: extractSearchQuery(initialUrl),
    });
    if (payload?.ok && payload.stats) {
      applyStats(payload.stats);
      if (initialUrl) showMessage('Сбор запущен. Просматривайте выдачу Ozon обычным образом.', 'success');
      else showMessage('Сбор запущен, но текущая вкладка не является страницей поиска Ozon.', 'info');
    } else {
      showMessage(payload?.error ?? 'Не удалось запустить сбор.', 'error');
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function stopCollection(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const payload = await runtimeSendMessage<StatsResponse>({
      type: MSG.collectorStop,
    });
    if (payload?.ok && payload.stats) {
      applyStats(payload.stats);
      showMessage('Сбор остановлен. Данные сохранены.', 'success');
    } else {
      showMessage(payload?.error ?? 'Не удалось остановить сбор.', 'error');
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setBusy(false);
  }
}

function resolveScope(): { scope: 'all' | 'session'; sessionId: string | null } {
  const value = elements.scope.value || 'all';
  if (value === 'all') return { scope: 'all', sessionId: null };
  if (value === 'active') {
    return {
      scope: 'session',
      sessionId: stats?.active_session?.session_id ?? stats?.last_session?.session_id ?? null,
    };
  }
  return { scope: 'session', sessionId: value };
}

function download(result: ExportResult): void {
  if (!result.ok || !result.content || !result.filename) {
    showMessage(result.error ?? 'Не удалось сформировать файл.', 'error');
    return;
  }
  const blob = new Blob([result.content], { type: result.mime ?? 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  showMessage(`Скачивание: ${result.filename}`, 'success');
}

async function exportData(format: ExportFormat): Promise<void> {
  if (busy) return;
  const scope = resolveScope();
  if (scope.scope === 'session' && !scope.sessionId) {
    showMessage('Не выбрана сессия сбора.', 'error');
    return;
  }
  setBusy(true);
  showMessage('Формирование файла…');
  try {
    const result = await runtimeSendMessage<ExportResult>({
      type: MSG.dataExport,
      payload: {
        scope: scope.scope,
        session_id: scope.sessionId,
        format,
      },
    });
    download(result);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function clearData(): Promise<void> {
  if (busy) return;
  const confirmed = window.confirm(
    'Удалить все товары, наблюдения и сессии? Это действие необратимо. Сбор будет остановлен.',
  );
  if (!confirmed) return;
  setBusy(true);
  try {
    const payload = await runtimeSendMessage<StatsResponse>({
      type: MSG.dataClear,
    });
    if (payload?.ok && payload.stats) {
      applyStats(payload.stats);
      showMessage('Накопленные данные удалены.', 'success');
    } else {
      showMessage(payload?.error ?? 'Не удалось очистить данные.', 'error');
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setBusy(false);
  }
}

function bind(): void {
  elements.start.addEventListener('click', () => void startCollection());
  elements.stop.addEventListener('click', () => void stopCollection());
  elements.exportProducts.addEventListener('click', () => void exportData('products-csv'));
  elements.exportObservations.addEventListener('click', () => void exportData('observations-csv'));
  elements.exportJson.addEventListener('click', () => void exportData('json'));
  elements.clear.addEventListener('click', () => void clearData());
  elements.scope.addEventListener('change', () => applyButtonState());
}

function init(): void {
  bind();
  void refresh();
  window.setInterval(() => void refresh(), 1500);
  ext.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.state || changes.meta || changes.session_index) {
      window.setTimeout(() => void refresh(), 250);
    }
  });
  window.addEventListener('beforeunload', () => {
    if (toastTimer !== null) window.clearTimeout(toastTimer);
  });
}

init();
