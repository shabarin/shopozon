export const EXTENSION_VERSION = '1.0.0';
export const PARSER_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

export const STORAGE_KEYS = {
  state: 'state',
  meta: 'meta',
  sessionIndex: 'session_index',
  productPrefix: 'p:',
  productIndexPrefix: 'pidx:',
  sessionPrefix: 'session:',
  observationPrefix: 'obs:',
} as const;

export const LIMITS = {
  productIndexChunkSize: 100,
  observationChunkSize: 100,
  maxSessionIdsPerProduct: 20,
  maxSourceUrlsPerProduct: 10,
  maxCardsPerMessage: 100,
  ingestBatchSize: 25,
  ingestFlushDelayMs: 2500,
  scanDebounceMs: 500,
  scanRetryDelaysMs: [1500, 4000],
  maxExtractionRetries: 2,
  maxMessageBytes: 4 * 1024 * 1024,
} as const;

/** Ozon listing pages on which collection is allowed. */
export const OZON_HOST_SUFFIX = '.ozon.ru';
export const OZON_MATCH_PATTERNS = ['https://*.ozon.ru/*', 'https://ozon.ru/*'];

export const MSG = {
  stateGet: 'state:get',
  collectorStart: 'collector:start',
  collectorStop: 'collector:stop',
  collectorChanged: 'collector:changed',
  collectorFlush: 'collector:flush',
  collectorCleared: 'collector:cleared',
  ingestCards: 'cards:ingest',
  dataClear: 'data:clear',
  dataExport: 'data:export',
  pageInfo: 'page:info',
} as const;

export const DEFAULT_STATE = {
  schema_version: SCHEMA_VERSION,
  enabled: false,
  active_session_id: null,
  last_session_id: null,
  started_at: null,
  last_extraction_at: null,
  last_source_url: null,
  warning: null,
  warning_at: null,
  parser_version: PARSER_VERSION,
} as const;

export const DEFAULT_META = {
  schema_version: SCHEMA_VERSION,
  product_count: 0,
  product_index_chunks: 0,
  product_index_last_size: 0,
} as const;
