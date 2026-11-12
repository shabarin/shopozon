import {
  DEFAULT_META,
  DEFAULT_STATE,
  LIMITS,
  PARSER_VERSION,
  SCHEMA_VERSION,
  STORAGE_KEYS,
} from '../shared/constants.ts';
import { FIELD_NAMES } from '../shared/types.ts';
import type {
  CardExtraction,
  CollectorState,
  DbMeta,
  ExportBundle,
  ExportScope,
  FieldName,
  FieldState,
  IngestResult,
  ObservationRecord,
  PriceSet,
  ProductRecord,
  SessionRecord,
  SessionSummary,
  Stats,
  VolumeUnit,
} from '../shared/types.ts';
import {
  chunkArray,
  fnv1a64,
  normalizeText,
  randomId,
  toFiniteNumber,
  uniqueAppend,
} from '../shared/util.ts';
import { extractSearchQuery, isOzonUrl, parseProductLink } from '../parser/url.ts';
import type { KeyValueStore } from './backend.ts';

export interface RepositoryOptions {
  store: KeyValueStore;
  now?: () => Date;
  createId?: () => string;
  parserVersion?: string;
}

interface PreparedCard {
  card: CardExtraction;
  dedupe_key: string;
  product_url: string | null;
  product_id: string | null;
}

interface ResolvedCard {
  prepared: PreparedCard;
  key: string;
  existing: ProductRecord | null;
}

interface BatchQuality {
  total: number;
  validIdentity: number;
  title: number;
  price: number;
  success: number;
  partial: number;
  failed: number;
  reject: boolean;
  warning: string | null;
}

const VOLUME_UNITS: VolumeUnit[] = ['ml', 'l', 'g', 'kg'];

export function productStorageKey(dedupeKey: string): string {
  return `${STORAGE_KEYS.productPrefix}${fnv1a64(dedupeKey)}`;
}

export function observationStorageKey(sessionId: string, chunk: number): string {
  return `${STORAGE_KEYS.observationPrefix}${sessionId}:${chunk}`;
}

export function sessionStorageKey(sessionId: string): string {
  return `${STORAGE_KEYS.sessionPrefix}${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProductRecord(value: unknown): value is ProductRecord {
  return isRecord(value) && typeof value.dedupe_key === 'string' && typeof value.key === 'string';
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value) && typeof value.session_id === 'string' && Array.isArray(value.product_keys);
}

function finite(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER, integer = false): number | null {
  const number = toFiniteNumber(value);
  if (number === null || number < min || number > max) return null;
  return integer ? Math.round(number) : number;
}

function sanitizePriceSet(value: unknown): PriceSet {
  const source = isRecord(value) ? value : {};
  const cleanVariant = (candidate: unknown): PriceSet['main'] => {
    if (!isRecord(candidate)) return null;
    const amount = finite(candidate.amount, 0);
    if (amount === null) return null;
    const type = candidate.type;
    if (
      type !== 'main' &&
      type !== 'original' &&
      type !== 'ozon_card' &&
      type !== 'subscription' &&
      type !== 'other'
    ) {
      return null;
    }
    return {
      type,
      amount,
      currency: typeof candidate.currency === 'string' ? candidate.currency.slice(0, 8) : null,
      raw_text: typeof candidate.raw_text === 'string' ? candidate.raw_text.slice(0, 200) : '',
      conditions: typeof candidate.conditions === 'string' ? candidate.conditions.slice(0, 200) : null,
    };
  };
  return {
    main: cleanVariant(source.main),
    original: cleanVariant(source.original),
    ozon_card: cleanVariant(source.ozon_card),
    subscription: cleanVariant(source.subscription),
    other: Array.isArray(source.other)
      ? source.other.map(cleanVariant).filter((item): item is NonNullable<typeof item> => item !== null)
      : [],
  };
}

function sanitizeFieldStates(value: unknown): Record<FieldName, FieldState> {
  const source = isRecord(value) ? value : {};
  const result = {} as Record<FieldName, FieldState>;
  for (const field of FIELD_NAMES) {
    const state = source[field];
    result[field] =
      state === 'extracted' || state === 'failed' || state === 'absent' ? state : 'absent';
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
}

function deriveStatus(states: Record<FieldName, FieldState>): 'success' | 'partial' | 'failed' {
  const hasUrl = states.url === 'extracted';
  const hasTitle = states.title === 'extracted';
  const hasPrice = states.price === 'extracted';
  if (hasUrl && hasTitle && hasPrice) return 'success';
  if (hasUrl && (hasTitle || hasPrice)) return 'partial';
  return 'failed';
}

function normalizeCard(
  raw: CardExtraction,
  defaultSourceUrl: string,
  defaultSearchQuery: string | null,
  nowIso: string,
  parserVersion: string,
): PreparedCard | null {
  if (!isRecord(raw)) return null;

  const parsed = parseProductLink(typeof raw.url === 'string' ? raw.url : null, defaultSourceUrl);
  const rawProductId = typeof raw.product_id === 'string' && /^\d{5,}$/u.test(raw.product_id) ? raw.product_id : null;
  const productId = parsed?.product_id ?? rawProductId;
  const productUrl = parsed?.url ?? (isOzonUrl(raw.url) ? raw.url : null);
  const normalizedUrl = parsed?.normalized_url ?? null;
  const dedupeKey = productId ? `id:${productId}` : normalizedUrl ? `url:${normalizedUrl}` : null;
  if (!dedupeKey) return null;

  const title = normalizeText(typeof raw.title === 'string' ? raw.title : '').slice(0, 2000) || null;
  const seller = normalizeText(typeof raw.seller === 'string' ? raw.seller : '').slice(0, 300) || null;
  const sourceUrl =
    (isOzonUrl(defaultSourceUrl) ? defaultSourceUrl : null) ??
    (isOzonUrl(raw.source_url) ? raw.source_url : null) ??
    '';
  const collectedAt =
    typeof raw.collected_at === 'string' && !Number.isNaN(Date.parse(raw.collected_at))
      ? raw.collected_at
      : nowIso;

  const prices = sanitizePriceSet(raw.prices);
  const fieldStates = sanitizeFieldStates(raw.field_states);
  const numeric: Record<string, number | null> = {
    price: finite(raw.price, 0),
    original_price: finite(raw.original_price, 0),
    discount: finite(raw.discount, 0.01, 100),
    volume: finite(raw.volume, 0),
    quantity: finite(raw.quantity, 0, 100000, true),
    rating: finite(raw.rating, 0, 5),
    review_count: finite(raw.review_count, 0, Number.MAX_SAFE_INTEGER, true),
  };

  const values: Record<string, unknown> = {
    product_id: productId,
    url: productUrl,
    title,
    price: numeric.price,
    currency:
      (typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim().slice(0, 8) : null) ??
      prices.main?.currency ??
      prices.original?.currency ??
      null,
    original_price: numeric.original_price,
    discount: numeric.discount,
    discount_text:
      typeof raw.discount_text === 'string' ? normalizeText(raw.discount_text).slice(0, 100) || null : null,
    volume: numeric.volume,
    volume_unit: VOLUME_UNITS.includes(raw.volume_unit as VolumeUnit) ? (raw.volume_unit as VolumeUnit) : null,
    quantity: numeric.quantity,
    seller,
    rating: numeric.rating,
    review_count: numeric.review_count,
    availability:
      raw.availability === 'in_stock' || raw.availability === 'out_of_stock' ? raw.availability : null,
    availability_text:
      typeof raw.availability_text === 'string'
        ? normalizeText(raw.availability_text).slice(0, 200) || null
        : null,
  };

  // A field cannot be marked "extracted" while its value is missing.
  for (const field of FIELD_NAMES) {
    if (fieldStates[field] === 'extracted' && (values[field] === null || values[field] === undefined)) {
      fieldStates[field] = 'absent';
    }
  }

  const extractedFields = FIELD_NAMES.filter((field) => fieldStates[field] === 'extracted');
  const missingFields = FIELD_NAMES.filter((field) => fieldStates[field] === 'absent');
  const failedFields = FIELD_NAMES.filter((field) => fieldStates[field] === 'failed');
  const status = deriveStatus(fieldStates);

  const extraction = {
    status,
    extracted_fields: extractedFields,
    missing_fields: missingFields,
    failed_fields: failedFields,
    errors: stringArray(raw.extraction?.errors),
    fallback_fields: stringArray(raw.extraction?.fallback_fields),
    extraction_version:
      typeof raw.extraction?.extraction_version === 'string' && raw.extraction.extraction_version
        ? raw.extraction.extraction_version.slice(0, 40)
        : parserVersion,
  };

  const card: CardExtraction = {
    product_id: productId,
    url: productUrl,
    title,
    price: numeric.price ?? null,
    currency: values.currency as string | null,
    original_price: numeric.original_price ?? null,
    discount: numeric.discount ?? null,
    discount_text: values.discount_text as string | null,
    volume: numeric.volume ?? null,
    volume_unit: values.volume_unit as VolumeUnit | null,
    quantity: numeric.quantity ?? null,
    seller,
    rating: numeric.rating ?? null,
    review_count: numeric.review_count ?? null,
    availability: values.availability as CardExtraction['availability'],
    availability_text: values.availability_text as string | null,
    price_type:
      raw.price_type === 'regular' ||
      raw.price_type === 'ozon_card' ||
      raw.price_type === 'subscription' ||
      raw.price_type === 'unknown'
        ? raw.price_type
        : 'unknown',
    price_conditions:
      typeof raw.price_conditions === 'string' ? normalizeText(raw.price_conditions).slice(0, 200) || null : null,
    prices,
    collected_at: collectedAt,
    source_url: sourceUrl,
    search_query:
      normalizeText(defaultSearchQuery ?? raw.search_query ?? '').slice(0, 300) || null,
    field_states: fieldStates,
    extraction,
    is_update: raw.is_update === true,
  };

  return { card, dedupe_key: dedupeKey, product_url: productUrl, product_id: productId };
}

function analyzeBatch(rawCards: CardExtraction[], prepared: PreparedCard[]): BatchQuality {
  const total = rawCards.length;
  const validIdentity = prepared.length;
  const title = prepared.filter((item) => item.card.title !== null).length;
  const price = prepared.filter((item) => item.card.price !== null).length;
  const success = prepared.filter((item) => item.card.extraction.status === 'success').length;
  const partial = prepared.filter((item) => item.card.extraction.status === 'partial').length;
  const failed = prepared.filter((item) => item.card.extraction.status === 'failed').length;
  const reject = total >= 5 && (validIdentity / total < 0.8 || title / total < 0.6);

  let warning: string | null = null;
  if (reject) {
    warning =
      `Низкое качество извлечения: распознано ${validIdentity}/${total} ссылок и ${title}/${total} названий. ` +
      'Пакет не сохранён — вероятно, Ozon изменил разметку. Проверьте селекторы.';
  } else if (total >= 5 && (price / total < 0.5 || success / total < 0.5)) {
    warning =
      `Предупреждение о качестве: цена найдена у ${price}/${total} карточек, полное извлечение — ${success}/${total}. ` +
      'Проверьте, не изменилась ли разметка Ozon.';
  }

  return { total, validIdentity, title, price, success, partial, failed, reject, warning };
}

export class CollectorRepository {
  private readonly store: KeyValueStore;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly parserVersion: string;

  constructor(options: RepositoryOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomId;
    this.parserVersion = options.parserVersion ?? PARSER_VERSION;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  async ensureInitialized(): Promise<void> {
    const loaded = await this.store.get([STORAGE_KEYS.state, STORAGE_KEYS.meta, STORAGE_KEYS.sessionIndex]);
    const writes: Record<string, unknown> = {};
    if (!isRecord(loaded[STORAGE_KEYS.state])) {
      writes[STORAGE_KEYS.state] = { ...DEFAULT_STATE, parser_version: this.parserVersion };
    }
    if (!isRecord(loaded[STORAGE_KEYS.meta])) writes[STORAGE_KEYS.meta] = { ...DEFAULT_META };
    if (!Array.isArray(loaded[STORAGE_KEYS.sessionIndex])) writes[STORAGE_KEYS.sessionIndex] = [];
    if (Object.keys(writes).length > 0) await this.store.set(writes);
  }

  async getState(): Promise<CollectorState> {
    const loaded = await this.store.get([STORAGE_KEYS.state]);
    const raw = loaded[STORAGE_KEYS.state];
    const source = isRecord(raw) ? raw : {};
    return {
      schema_version: SCHEMA_VERSION,
      enabled: source.enabled === true,
      active_session_id:
        typeof source.active_session_id === 'string' ? source.active_session_id : null,
      last_session_id: typeof source.last_session_id === 'string' ? source.last_session_id : null,
      started_at: typeof source.started_at === 'string' ? source.started_at : null,
      last_extraction_at:
        typeof source.last_extraction_at === 'string' ? source.last_extraction_at : null,
      last_source_url: typeof source.last_source_url === 'string' ? source.last_source_url : null,
      warning: typeof source.warning === 'string' ? source.warning : null,
      warning_at: typeof source.warning_at === 'string' ? source.warning_at : null,
      parser_version:
        typeof source.parser_version === 'string' ? source.parser_version : this.parserVersion,
    };
  }

  async setWarning(warning: string | null): Promise<void> {
    const state = await this.getState();
    await this.store.set({
      [STORAGE_KEYS.state]: {
        ...state,
        warning,
        warning_at: warning ? this.nowIso() : null,
      },
    });
  }

  private async getMeta(): Promise<DbMeta> {
    const loaded = await this.store.get([STORAGE_KEYS.meta]);
    const raw = loaded[STORAGE_KEYS.meta];
    const source = isRecord(raw) ? raw : {};
    return {
      schema_version: SCHEMA_VERSION,
      product_count: finite(source.product_count, 0, Number.MAX_SAFE_INTEGER, true) ?? 0,
      product_index_chunks: finite(source.product_index_chunks, 0, Number.MAX_SAFE_INTEGER, true) ?? 0,
      product_index_last_size:
        finite(source.product_index_last_size, 0, Number.MAX_SAFE_INTEGER, true) ?? 0,
    };
  }

  private async getSessionIndex(): Promise<SessionSummary[]> {
    const loaded = await this.store.get([STORAGE_KEYS.sessionIndex]);
    const raw = loaded[STORAGE_KEYS.sessionIndex];
    return Array.isArray(raw) ? (raw.filter(isRecord) as unknown as SessionSummary[]) : [];
  }

  private summaryOf(session: SessionRecord): SessionSummary {
    const {
      session_id,
      started_at,
      finished_at,
      initial_url,
      search_query,
      cards_discovered,
      unique_products,
      errors,
      partial,
      success,
      observation_count,
      status,
      extraction_versions,
    } = session;
    return {
      session_id,
      started_at,
      finished_at,
      initial_url,
      search_query,
      cards_discovered,
      unique_products,
      errors,
      partial,
      success,
      observation_count,
      status,
      extraction_versions,
    };
  }

  private upsertSummary(index: SessionSummary[], summary: SessionSummary): SessionSummary[] {
    const result = index.slice();
    const position = result.findIndex((item) => item.session_id === summary.session_id);
    if (position >= 0) result[position] = summary;
    else result.push(summary);
    return result;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const loaded = await this.store.get([sessionStorageKey(sessionId)]);
    const raw = loaded[sessionStorageKey(sessionId)];
    return isSessionRecord(raw) ? raw : null;
  }

  async startSession(initialUrl: string | null, searchQuery: string | null): Promise<SessionRecord> {
    const [state, index] = await Promise.all([this.getState(), this.getSessionIndex()]);
    if (state.active_session_id) {
      const existing = await this.getSession(state.active_session_id);
      if (existing && existing.status === 'active') return existing;
    }

    const nowIso = this.nowIso();
    const cleanUrl = isOzonUrl(initialUrl) ? (initialUrl as string) : null;
    const session: SessionRecord = {
      session_id: `sess-${this.createId()}`,
      started_at: nowIso,
      finished_at: null,
      initial_url: cleanUrl,
      search_query: normalizeText(searchQuery ?? extractSearchQuery(cleanUrl) ?? '') || null,
      cards_discovered: 0,
      unique_products: 0,
      errors: 0,
      partial: 0,
      success: 0,
      observation_count: 0,
      status: 'active',
      extraction_versions: [],
      product_keys: [],
      observation_chunks: 0,
      note: null,
    };
    const newState: CollectorState = {
      ...state,
      enabled: true,
      active_session_id: session.session_id,
      last_session_id: session.session_id,
      started_at: nowIso,
      last_extraction_at: null,
      last_source_url: cleanUrl,
      warning: null,
      warning_at: null,
      parser_version: this.parserVersion,
    };
    await this.store.set({
      [sessionStorageKey(session.session_id)]: session,
      [STORAGE_KEYS.sessionIndex]: this.upsertSummary(index, this.summaryOf(session)),
      [STORAGE_KEYS.state]: newState,
    });
    return session;
  }

  async stopSession(
    sessionId: string | null,
    status: 'stopped' | 'interrupted' = 'stopped',
    note: string | null = null,
  ): Promise<SessionRecord | null> {
    const [state, index] = await Promise.all([this.getState(), this.getSessionIndex()]);
    const targetId = sessionId ?? state.active_session_id ?? state.last_session_id;
    if (!targetId) {
      if (state.enabled) {
        await this.store.set({
          [STORAGE_KEYS.state]: { ...state, enabled: false, active_session_id: null },
        });
      }
      return null;
    }
    const session = await this.getSession(targetId);
    if (!session) {
      await this.store.set({
        [STORAGE_KEYS.state]: {
          ...state,
          enabled: false,
          active_session_id: state.active_session_id === targetId ? null : state.active_session_id,
          warning: 'Состояние восстановлено: активная сессия не найдена.',
          warning_at: this.nowIso(),
        },
      });
      return null;
    }

    const nowIso = this.nowIso();
    const updated: SessionRecord = {
      ...session,
      finished_at: session.finished_at ?? nowIso,
      status: session.status === 'stopped' ? 'stopped' : status,
      note: note ?? session.note,
      unique_products: session.product_keys.length,
    };
    const newState: CollectorState = {
      ...state,
      enabled: false,
      active_session_id: state.active_session_id === targetId ? null : state.active_session_id,
      last_session_id: targetId,
      warning: note ? note : state.warning,
      warning_at: note ? nowIso : state.warning_at,
    };
    await this.store.set({
      [sessionStorageKey(targetId)]: updated,
      [STORAGE_KEYS.sessionIndex]: this.upsertSummary(index, this.summaryOf(updated)),
      [STORAGE_KEYS.state]: newState,
    });
    return updated;
  }

  /** Called once per browser startup to avoid silently collecting without consent. */
  async recoverOnStartup(): Promise<void> {
    const state = await this.getState();
    if (!state.enabled && !state.active_session_id) return;
    await this.stopSession(
      state.active_session_id,
      'interrupted',
      'Браузер был перезапущен. Сбор остановлен; данные сохранены. Запустите новую сессию.',
    );
  }

  async ingestBatch(
    sessionId: string,
    cards: CardExtraction[],
    sourceUrl: string | null,
    searchQuery: string | null,
  ): Promise<IngestResult> {
    const state = await this.getState();
    const session = await this.getSession(sessionId);
    if (!session) {
      return {
        ok: false,
        code: 'session_not_found',
        accepted: 0,
        duplicates: 0,
        cards_discovered: 0,
        errors: 0,
        unique_in_session: 0,
        total_products: (await this.getMeta()).product_count,
        warning: state.warning,
        message: 'Сессия сбора не найдена.',
      };
    }

    const nowIso = this.nowIso();
    const safeSourceUrl =
      (isOzonUrl(sourceUrl) ? sourceUrl : null) ??
      (isOzonUrl(session.initial_url) ? session.initial_url : null) ??
      '';
    const safeSearchQuery = normalizeText(searchQuery ?? extractSearchQuery(safeSourceUrl) ?? '') || null;
    const rawCards = cards.slice(0, LIMITS.maxCardsPerMessage);
    const detectionCards = rawCards.filter((card) => card.is_update !== true);
    const detectionCount = detectionCards.length;
    const prepared = rawCards
      .map((card) => normalizeCard(card, safeSourceUrl, safeSearchQuery, nowIso, this.parserVersion))
      .filter((card): card is PreparedCard => card !== null);
    const quality = analyzeBatch(rawCards, prepared);

    const [index, meta] = await Promise.all([this.getSessionIndex(), this.getMeta()]);
    const writes: Record<string, unknown> = {};
    const sessionSet = new Set(session.product_keys);

    if (quality.reject) {
      const rejectedSession: SessionRecord = {
        ...session,
        cards_discovered: session.cards_discovered + detectionCount,
        errors: session.errors + detectionCount,
        unique_products: session.product_keys.length,
      };
      const warningAt = this.nowIso();
      writes[sessionStorageKey(sessionId)] = rejectedSession;
      writes[STORAGE_KEYS.sessionIndex] = this.upsertSummary(index, this.summaryOf(rejectedSession));
      writes[STORAGE_KEYS.state] = {
        ...state,
        last_source_url: safeSourceUrl || state.last_source_url,
        warning: quality.warning,
        warning_at: warningAt,
        active_session_id: state.active_session_id ?? sessionId,
      };
      await this.store.set(writes);
      return {
        ok: false,
        code: 'quality_rejected',
        accepted: 0,
        duplicates: 0,
        cards_discovered: detectionCount,
        errors: detectionCount,
        unique_in_session: session.product_keys.length,
        total_products: meta.product_count,
        warning: quality.warning,
        message: quality.warning ?? undefined,
      };
    }

    // Coalesce repeated cards inside one batch; each unique product gets one observation.
    const byIdentity = new Map<string, PreparedCard>();
    for (const item of prepared) byIdentity.set(item.dedupe_key, item);
    const uniqueCards = [...byIdentity.values()];

    // Resolve storage keys, including the extremely unlikely hash collision.
    const primaryKeys = uniqueCards.map((item) => productStorageKey(item.dedupe_key));
    const loadedPrimary = await this.store.get(primaryKeys);
    const resolved: ResolvedCard[] = [];
    const usedKeys = new Set<string>();
    for (const item of uniqueCards) {
      const primary = productStorageKey(item.dedupe_key);
      let key = primary;
      let existingRaw = loadedPrimary[key];
      let existing = isProductRecord(existingRaw) ? existingRaw : null;
      let suffix = 0;
      while (
        (existing && existing.dedupe_key !== item.dedupe_key) ||
        (usedKeys.has(key) && existing?.dedupe_key !== item.dedupe_key)
      ) {
        suffix += 1;
        key = `${primary}~${suffix}`;
        const extra = await this.store.get([key]);
        existingRaw = extra[key];
        existing = isProductRecord(existingRaw) ? existingRaw : null;
        if (suffix > 20) break;
      }
      usedKeys.add(key);
      resolved.push({ prepared: item, key, existing });
    }

    const newProducts = resolved.filter((item) => item.existing === null);

    // Maintain a chunked product index without rewriting the entire index.
    if (newProducts.length > 0) {
      let chunks = meta.product_index_chunks;
      let lastSize = meta.product_index_last_size;
      let lastKey = chunks > 0 ? `${STORAGE_KEYS.productIndexPrefix}${chunks - 1}` : null;
      let lastChunk: string[] = [];
      if (lastKey) {
        const loadedChunk = await this.store.get([lastKey]);
        const candidate = loadedChunk[lastKey];
        if (Array.isArray(candidate)) {
          lastChunk = candidate.filter((value): value is string => typeof value === 'string');
        }
      }
      for (const item of newProducts) {
        if (!lastKey || lastChunk.length >= LIMITS.productIndexChunkSize) {
          chunks += 1;
          lastKey = `${STORAGE_KEYS.productIndexPrefix}${chunks - 1}`;
          lastChunk = [];
        }
        lastChunk.push(item.key);
        lastSize = lastChunk.length;
        writes[lastKey] = lastChunk.slice();
      }
      writes[STORAGE_KEYS.meta] = {
        schema_version: SCHEMA_VERSION,
        product_count: meta.product_count + newProducts.length,
        product_index_chunks: chunks,
        product_index_last_size: lastSize,
      };
    }

    // Observations are stored in per-session chunks.
    let observationChunks = session.observation_chunks ?? 0;
    let currentChunk: ObservationRecord[] = [];
    let currentChunkIndex = -1;
    if (observationChunks > 0) {
      currentChunkIndex = observationChunks - 1;
      const key = observationStorageKey(sessionId, currentChunkIndex);
      const loadedChunk = await this.store.get([key]);
      const candidate = loadedChunk[key];
      if (Array.isArray(candidate)) {
        currentChunk = candidate.filter(isRecord) as unknown as ObservationRecord[];
      }
    }
    const observations: ObservationRecord[] = [];
    for (const item of resolved) {
      const card = item.prepared.card;
      const observation: ObservationRecord = {
        observation_id: `obs-${this.createId()}`,
        session_id: sessionId,
        product_key: item.key,
        product_id: card.product_id,
        url: card.url,
        title: card.title,
        price: card.price,
        currency: card.currency,
        original_price: card.original_price,
        discount: card.discount,
        discount_text: card.discount_text,
        volume: card.volume,
        volume_unit: card.volume_unit,
        quantity: card.quantity,
        seller: card.seller,
        rating: card.rating,
        review_count: card.review_count,
        availability: card.availability,
        availability_text: card.availability_text,
        price_type: card.price_type,
        price_conditions: card.price_conditions,
        prices: card.prices,
        collected_at: card.collected_at,
        source_url: card.source_url,
        search_query: card.search_query,
        extraction: card.extraction,
        field_states: card.field_states,
      };
      observations.push(observation);

      if (observationChunks === 0) {
        observationChunks = 1;
        currentChunkIndex = 0;
        currentChunk = [];
      } else if (currentChunk.length >= LIMITS.observationChunkSize) {
        observationChunks += 1;
        currentChunkIndex = observationChunks - 1;
        currentChunk = [];
      }
      currentChunk.push(observation);
      writes[observationStorageKey(sessionId, currentChunkIndex)] = currentChunk.slice();
    }

    for (const item of resolved) {
      const card = item.prepared.card;
      const existing = item.existing;
      const sourceUrls = uniqueAppend(
        existing?.source_urls ?? [],
        card.source_url ? [card.source_url] : [],
        LIMITS.maxSourceUrlsPerProduct,
      );
      const sessionIds = uniqueAppend(
        existing?.session_ids ?? [],
        [sessionId],
        LIMITS.maxSessionIdsPerProduct,
      );
      const hasNewPrices =
        card.prices.main !== null ||
        card.prices.original !== null ||
        card.prices.ozon_card !== null ||
        card.prices.subscription !== null ||
        card.prices.other.length > 0;

      const record: ProductRecord = {
        key: item.key,
        dedupe_key: item.prepared.dedupe_key,
        product_id: card.product_id ?? existing?.product_id ?? null,
        url: card.url ?? existing?.url ?? null,
        title: card.title ?? existing?.title ?? null,
        price: card.price ?? existing?.price ?? null,
        currency: card.currency ?? existing?.currency ?? null,
        original_price: card.original_price ?? existing?.original_price ?? null,
        discount: card.discount ?? existing?.discount ?? null,
        discount_text: card.discount_text ?? existing?.discount_text ?? null,
        volume: card.volume ?? existing?.volume ?? null,
        volume_unit: card.volume_unit ?? existing?.volume_unit ?? null,
        quantity: card.quantity ?? existing?.quantity ?? null,
        seller: card.seller ?? existing?.seller ?? null,
        rating: card.rating ?? existing?.rating ?? null,
        review_count: card.review_count ?? existing?.review_count ?? null,
        availability: card.availability ?? existing?.availability ?? null,
        availability_text: card.availability_text ?? existing?.availability_text ?? null,
        price_type:
          card.price !== null ? card.price_type : (existing?.price_type ?? 'unknown'),
        price_conditions:
          card.price !== null ? card.price_conditions : (existing?.price_conditions ?? null),
        prices: hasNewPrices ? card.prices : (existing?.prices ?? card.prices),
        first_seen_at: existing?.first_seen_at ?? card.collected_at,
        last_seen_at: nowIso,
        collected_at: card.collected_at,
        observation_count: (existing?.observation_count ?? 0) + 1,
        session_ids: sessionIds,
        source_url: card.source_url || existing?.source_url || safeSourceUrl,
        source_urls: sourceUrls,
        search_query: card.search_query ?? existing?.search_query ?? null,
        extraction: card.extraction,
        field_states: card.field_states,
      };
      writes[item.key] = record;
      if (!sessionSet.has(item.key)) sessionSet.add(item.key);
    }

    const preparedDetection = prepared.filter((item) => item.card.is_update !== true);
    const successCount = preparedDetection.filter(
      (item) => item.card.extraction.status === 'success',
    ).length;
    const partialCount = preparedDetection.filter(
      (item) => item.card.extraction.status === 'partial',
    ).length;
    const failedCount =
      preparedDetection.filter((item) => item.card.extraction.status === 'failed').length +
      (detectionCount - preparedDetection.length);
    const extractionVersions = uniqueAppend(
      session.extraction_versions,
      prepared.map((item) => item.card.extraction.extraction_version).filter(Boolean),
      20,
    );
    const updatedSession: SessionRecord = {
      ...session,
      cards_discovered: session.cards_discovered + detectionCount,
      unique_products: sessionSet.size,
      errors: session.errors + failedCount,
      partial: session.partial + partialCount,
      success: session.success + successCount,
      observation_count: session.observation_count + observations.length,
      observation_chunks: observationChunks,
      extraction_versions: extractionVersions,
      product_keys: [...sessionSet],
      finished_at: session.status === 'active' ? null : session.finished_at,
    };
    writes[sessionStorageKey(sessionId)] = updatedSession;
    writes[STORAGE_KEYS.sessionIndex] = this.upsertSummary(index, this.summaryOf(updatedSession));
    writes[STORAGE_KEYS.state] = {
      ...state,
      active_session_id: state.active_session_id ?? sessionId,
      last_session_id: sessionId,
      last_extraction_at: prepared.length > 0 ? nowIso : state.last_extraction_at,
      last_source_url: safeSourceUrl || state.last_source_url,
      warning: quality.warning,
      warning_at: quality.warning ? this.nowIso() : null,
    };

    await this.store.set(writes);

    const totalProducts = meta.product_count + newProducts.length;
    return {
      ok: true,
      accepted: resolved.length,
      duplicates: resolved.length - newProducts.length,
      cards_discovered: detectionCount,
      errors: failedCount,
      unique_in_session: sessionSet.size,
      total_products: totalProducts,
      warning: quality.warning,
    };
  }

  async getStats(): Promise<Stats> {
    const [state, meta, index] = await Promise.all([
      this.getState(),
      this.getMeta(),
      this.getSessionIndex(),
    ]);
    const sessions = index.slice().sort((a, b) => {
      const left = Date.parse(a.started_at) || 0;
      const right = Date.parse(b.started_at) || 0;
      return right - left;
    });
    const active =
      sessions.find((item) => item.session_id === state.active_session_id) ?? null;
    const last =
      sessions.find((item) => item.session_id === state.last_session_id) ??
      sessions[0] ??
      null;
    return {
      enabled: state.enabled,
      active_session: active,
      last_session: last,
      total_products: meta.product_count,
      warning: state.warning,
      warning_at: state.warning_at,
      started_at: state.started_at,
      last_extraction_at: state.last_extraction_at,
      last_source_url: state.last_source_url,
      parser_version: state.parser_version,
      sessions,
    };
  }

  private async getProductsByKeys(keys: string[]): Promise<ProductRecord[]> {
    const result: ProductRecord[] = [];
    for (const part of chunkArray(keys, 100)) {
      if (part.length === 0) continue;
      const loaded = await this.store.get(part);
      for (const key of part) {
        const value = loaded[key];
        if (isProductRecord(value)) result.push(value);
      }
    }
    return result;
  }

  private async getAllProducts(): Promise<ProductRecord[]> {
    const meta = await this.getMeta();
    const keys: string[] = [];
    if (meta.product_index_chunks > 0) {
      const indexKeys = Array.from(
        { length: meta.product_index_chunks },
        (_, index) => `${STORAGE_KEYS.productIndexPrefix}${index}`,
      );
      for (const part of chunkArray(indexKeys, 20)) {
        const loaded = await this.store.get(part);
        for (const key of part) {
          const chunk = loaded[key];
          if (Array.isArray(chunk)) {
            for (const value of chunk) if (typeof value === 'string') keys.push(value);
          }
        }
      }
    }

    // Self-healing fallback for an interrupted/corrupt index write.
    if (keys.length < meta.product_count) {
      const all = await this.store.get(null);
      const recovered = Object.keys(all).filter((key) => key.startsWith(STORAGE_KEYS.productPrefix));
      const known = new Set(keys);
      for (const key of recovered) {
        if (!known.has(key)) {
          keys.push(key);
          known.add(key);
        }
      }
    }

    return this.getProductsByKeys(keys);
  }

  private async readObservations(session: SessionRecord): Promise<ObservationRecord[]> {
    const chunks = session.observation_chunks ?? 0;
    const observations: ObservationRecord[] = [];
    for (let index = 0; index < chunks; index += 1) {
      const key = observationStorageKey(session.session_id, index);
      const loaded = await this.store.get([key]);
      const chunk = loaded[key];
      if (Array.isArray(chunk)) {
        for (const value of chunk) {
          if (isRecord(value)) observations.push(value as unknown as ObservationRecord);
        }
      }
    }
    return observations.sort((a, b) => Date.parse(a.collected_at) - Date.parse(b.collected_at));
  }

  async getExportBundle(scope: ExportScope, sessionId: string | null): Promise<ExportBundle> {
    const [state, meta, index] = await Promise.all([
      this.getState(),
      this.getMeta(),
      this.getSessionIndex(),
    ]);
    const sortedSessions = index.slice().sort((a, b) => {
      const left = Date.parse(a.started_at) || 0;
      const right = Date.parse(b.started_at) || 0;
      return right - left;
    });

    let targetId = sessionId;
    if (scope === 'session' && !targetId) {
      targetId = state.active_session_id ?? state.last_session_id ?? sortedSessions[0]?.session_id ?? null;
    }

    if (scope === 'session' && targetId) {
      const session = await this.getSession(targetId);
      if (!session) throw new Error('Сессия не найдена');
      const products = (await this.getProductsByKeys(session.product_keys)).sort((a, b) =>
        a.first_seen_at.localeCompare(b.first_seen_at),
      );
      const observations = await this.readObservations(session);
      return {
        schema_version: SCHEMA_VERSION,
        exported_at: this.nowIso(),
        scope,
        session,
        sessions: [this.summaryOf(session)],
        products,
        observations,
        stats: {
          products: products.length,
          observations: observations.length,
          sessions: 1,
          total_products_in_store: meta.product_count,
        },
      };
    }

    const products = (await this.getAllProducts()).sort((a, b) =>
      a.first_seen_at.localeCompare(b.first_seen_at),
    );
    const fullSessions: SessionRecord[] = [];
    const sessionKeys = sortedSessions.map((item) => sessionStorageKey(item.session_id));
    for (const part of chunkArray(sessionKeys, 20)) {
      if (part.length === 0) continue;
      const loaded = await this.store.get(part);
      for (const key of part) {
        const value = loaded[key];
        if (isSessionRecord(value)) fullSessions.push(value);
      }
    }
    const observationGroups = await Promise.all(fullSessions.map((session) => this.readObservations(session)));
    const observations = observationGroups
      .flat()
      .sort((a, b) => Date.parse(a.collected_at) - Date.parse(b.collected_at));

    return {
      schema_version: SCHEMA_VERSION,
      exported_at: this.nowIso(),
      scope: 'all',
      session: null,
      sessions: sortedSessions,
      products,
      observations,
      stats: {
        products: products.length,
        observations: observations.length,
        sessions: sortedSessions.length,
        total_products_in_store: meta.product_count,
      },
    };
  }

  async clearAll(): Promise<void> {
    await this.store.clear();
    await this.store.set({
      [STORAGE_KEYS.state]: { ...DEFAULT_STATE, parser_version: this.parserVersion },
      [STORAGE_KEYS.meta]: { ...DEFAULT_META },
      [STORAGE_KEYS.sessionIndex]: [],
    });
  }
}
