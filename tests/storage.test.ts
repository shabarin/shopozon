import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_NAMES, type CardExtraction, type FieldName, type FieldState } from '../src/shared/types.ts';
import { MemoryStore } from '../src/storage/memory.ts';
import { CollectorRepository } from '../src/storage/repository.ts';

const SOURCE = 'https://www.ozon.ru/search/?text=test';

function makeClock(start = '2026-01-01T00:00:00.000Z') {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1000);
}

function makeIds(prefix = 'id') {
  let counter = 0;
  return () => `${prefix}-${String(++counter).padStart(5, '0')}`;
}

function states(extracted: FieldName[]): Record<FieldName, FieldState> {
  const result = {} as Record<FieldName, FieldState>;
  for (const field of FIELD_NAMES) {
    result[field] = extracted.includes(field) ? 'extracted' : 'absent';
  }
  return result;
}

function makeCard(
  productId: string | null,
  overrides: Partial<CardExtraction> = {},
  collectedAt = '2026-01-01T00:00:00.000Z',
): CardExtraction {
  const url =
    productId === null
      ? 'https://www.ozon.ru/product/no-digits/'
      : `https://www.ozon.ru/product/item-${productId}/`;
  const price = overrides.price ?? (overrides.price === null ? null : 100);
  const extracted: FieldName[] = ['product_id', 'url', 'title'];
  if (url) extracted.push('url');
  if (price !== null) {
    extracted.push('price', 'currency');
  }
  return {
    product_id: productId,
    url,
    title: `Товар ${productId ?? 'без-id'}`,
    price,
    currency: price === null ? null : 'RUB',
    original_price: null,
    discount: null,
    discount_text: null,
    volume: null,
    volume_unit: null,
    quantity: 1,
    seller: null,
    rating: null,
    review_count: null,
    availability: null,
    availability_text: null,
    price_type: 'regular',
    price_conditions: null,
    prices: {
      main:
        price === null
          ? null
          : { type: 'main', amount: price, currency: 'RUB', raw_text: `${price} ₽`, conditions: null },
      original: null,
      ozon_card: null,
      subscription: null,
      other: [],
    },
    collected_at: collectedAt,
    source_url: SOURCE,
    search_query: 'test',
    field_states: states(extracted),
    extraction: {
      status: price === null ? 'partial' : 'success',
      extracted_fields: extracted,
      missing_fields: [],
      failed_fields: [],
      errors: [],
      fallback_fields: [],
      extraction_version: 'test-1',
    },
    ...overrides,
  };
}

function makeRepository(store = new MemoryStore()) {
  return new CollectorRepository({
    store,
    now: makeClock(),
    createId: makeIds(),
    parserVersion: 'test-1',
  });
}

test('session lifecycle: start, collect, stop', async () => {
  const repo = makeRepository();
  await repo.ensureInitialized();

  const session = await repo.startSession(SOURCE, 'test');
  assert.equal(session.status, 'active');
  assert.equal(session.search_query, 'test');

  let state = await repo.getState();
  assert.equal(state.enabled, true);
  assert.equal(state.active_session_id, session.session_id);

  const first = await repo.ingestBatch(
    session.session_id,
    [makeCard('100001'), makeCard('100002')],
    SOURCE,
    'test',
  );
  assert.equal(first.ok, true);
  assert.equal(first.accepted, 2);
  assert.equal(first.cards_discovered, 2);
  assert.equal(first.unique_in_session, 2);
  assert.equal(first.total_products, 2);

  let stats = await repo.getStats();
  assert.equal(stats.total_products, 2);
  assert.equal(stats.active_session?.cards_discovered, 2);
  assert.equal(stats.active_session?.unique_products, 2);
  assert.equal(stats.active_session?.observation_count, 2);
  assert.ok(stats.last_extraction_at);

  const update = new Date(Date.parse('2026-01-02T00:00:00.000Z')).toISOString();
  const retry = await repo.ingestBatch(
    session.session_id,
    [
      makeCard('100001', { is_update: true, price: 120 }, update),
      makeCard('100002', { is_update: true }, update),
    ],
    SOURCE,
    'test',
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.accepted, 2);
  assert.equal(retry.duplicates, 2);
  // Retries must not inflate the "card discovered" counter.
  assert.equal(retry.cards_discovered, 0);

  stats = await repo.getStats();
  assert.equal(stats.active_session?.cards_discovered, 2);
  assert.equal(stats.active_session?.observation_count, 4);
  assert.equal(stats.total_products, 2);

  const stopped = await repo.stopSession(session.session_id, 'stopped');
  assert.equal(stopped?.status, 'stopped');
  assert.ok(stopped?.finished_at);
  state = await repo.getState();
  assert.equal(state.enabled, false);
  assert.equal(state.active_session_id, null);
  assert.equal(state.last_session_id, session.session_id);
});

test('deduplication by product id and by normalized URL fallback', async () => {
  const repo = makeRepository();
  await repo.ensureInitialized();
  const session = await repo.startSession(SOURCE, 'test');

  const byId = await repo.ingestBatch(
    session.session_id,
    [
      makeCard('200001'),
      makeCard('200001', { url: 'https://www.ozon.ru/product/other-slug-200001/?at=tracking' }),
    ],
    SOURCE,
    'test',
  );
  assert.equal(byId.accepted, 1);
  assert.equal(byId.total_products, 1);

  const byUrl = await repo.ingestBatch(
    session.session_id,
    [
      makeCard(null, { url: 'https://www.ozon.ru/product/same-slug/?at=a' }),
      makeCard(null, { url: 'https://www.ozon.ru/product/same-slug/?at=b' }),
    ],
    SOURCE,
    'test',
  );
  assert.equal(byUrl.accepted, 1);
  assert.equal(byUrl.total_products, 2);

  const stats = await repo.getStats();
  assert.equal(stats.total_products, 2);
  assert.equal(stats.active_session?.unique_products, 2);
  // Two cards were seen for each dedupe key, but only one product row exists.
  assert.equal(stats.active_session?.cards_discovered, 4);
});

test('null values never erase previously known product fields', async () => {
  const repo = makeRepository();
  await repo.ensureInitialized();
  const session = await repo.startSession(SOURCE, 'test');

  await repo.ingestBatch(
    session.session_id,
    [
      makeCard('300001', {
        title: 'Известное название',
        seller: 'ООО Ромашка',
        rating: 4.7,
        review_count: 42,
        original_price: 200,
        discount: 50,
        volume: 75,
        volume_unit: 'ml',
        prices: {
          main: { type: 'main', amount: 100, currency: 'RUB', raw_text: '100 ₽', conditions: null },
          original: { type: 'original', amount: 200, currency: 'RUB', raw_text: '200 ₽', conditions: null },
          ozon_card: { type: 'ozon_card', amount: 95, currency: 'RUB', raw_text: '95 ₽', conditions: 'Ozon Карта' },
          subscription: null,
          other: [],
        },
      }),
    ],
    SOURCE,
    'test',
  );

  await repo.ingestBatch(
    session.session_id,
    [
      makeCard('300001', {
        title: null,
        price: null,
        currency: null,
        seller: null,
        rating: null,
        review_count: null,
        original_price: null,
        discount: null,
        volume: null,
        volume_unit: null,
        prices: { main: null, original: null, ozon_card: null, subscription: null, other: [] },
      }),
    ],
    SOURCE,
    'test',
  );

  const bundle = await repo.getExportBundle('session', session.session_id);
  const product = bundle.products[0];
  assert.ok(product);
  assert.equal(product.title, 'Известное название');
  assert.equal(product.price, 100);
  assert.equal(product.seller, 'ООО Ромашка');
  assert.equal(product.rating, 4.7);
  assert.equal(product.review_count, 42);
  assert.equal(product.original_price, 200);
  assert.equal(product.discount, 50);
  assert.equal(product.volume, 75);
  assert.equal(product.volume_unit, 'ml');
  assert.equal(product.prices.ozon_card?.amount, 95);
  assert.equal(product.observation_count, 2);

  // The observation keeps the per-detection snapshot, including nulls.
  assert.equal(bundle.observations.length, 2);
  assert.equal(bundle.observations[1]?.price, null);
  assert.equal(bundle.observations[1]?.title, null);
});

test('quality guard rejects mass bad extraction and warns asynchronously', async () => {
  const repo = makeRepository();
  await repo.ensureInitialized();
  const session = await repo.startSession(SOURCE, 'test');

  const bad = Array.from({ length: 5 }, () =>
    makeCard(null, { url: null, product_id: null, title: null }),
  );
  const result = await repo.ingestBatch(session.session_id, bad, SOURCE, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quality_rejected');
  assert.equal(result.accepted, 0);
  assert.equal(result.cards_discovered, 5);
  assert.ok(result.warning);
  assert.equal(result.total_products, 0);

  const stats = await repo.getStats();
  assert.equal(stats.total_products, 0);
  assert.ok(stats.warning);
  assert.equal(stats.active_session?.errors, 5);
  assert.equal(stats.active_session?.cards_discovered, 5);
});

test('a low-price-quality batch is stored with a warning', async () => {
  const repo = makeRepository();
  await repo.ensureInitialized();
  const session = await repo.startSession(SOURCE, 'test');

  const cards = Array.from({ length: 5 }, (_, index) =>
    makeCard(String(400000 + index), { price: null, currency: null }),
  );
  const result = await repo.ingestBatch(session.session_id, cards, SOURCE, 'test');
  assert.equal(result.ok, true);
  assert.equal(result.accepted, 5);
  assert.ok(result.warning);
  assert.match(result.warning ?? '', /цен/i);

  const stats = await repo.getStats();
  assert.equal(stats.total_products, 5);
  assert.ok(stats.warning);
});

test('export scopes, JSON bundle metadata and self-healing product index', async () => {
  const store = new MemoryStore();
  const repo = makeRepository(store);
  await repo.ensureInitialized();

  const first = await repo.startSession(SOURCE, 'first');
  await repo.ingestBatch(first.session_id, [makeCard('500001')], SOURCE, 'first');
  await repo.stopSession(first.session_id, 'stopped');

  const second = await repo.startSession(SOURCE, 'second');
  await repo.ingestBatch(
    second.session_id,
    [makeCard('500001'), makeCard('500002')],
    SOURCE,
    'second',
  );

  const all = await repo.getExportBundle('all', null);
  assert.equal(all.scope, 'all');
  assert.equal(all.products.length, 2);
  assert.equal(all.observations.length, 3);
  assert.equal(all.sessions.length, 2);
  assert.equal(all.stats.products, 2);
  assert.equal(all.stats.observations, 3);
  assert.equal(all.stats.sessions, 2);

  const one = await repo.getExportBundle('session', first.session_id);
  assert.equal(one.scope, 'session');
  assert.equal(one.session?.session_id, first.session_id);
  assert.equal(one.products.length, 1);
  assert.equal(one.observations.length, 1);

  await assert.rejects(() => repo.getExportBundle('session', 'sess-missing'));

  // Simulate a partial/corrupt product index write: export must recover.
  await store.remove('pidx:0');
  const healed = await repo.getExportBundle('all', null);
  assert.equal(healed.products.length, 2);
});

test('clear removes products, sessions and observations', async () => {
  const repo = makeRepository();
  await repo.ensureInitialized();
  const session = await repo.startSession(SOURCE, 'test');
  await repo.ingestBatch(session.session_id, [makeCard('600001')], SOURCE, 'test');

  await repo.clearAll();
  const stats = await repo.getStats();
  assert.equal(stats.enabled, false);
  assert.equal(stats.total_products, 0);
  assert.equal(stats.sessions.length, 0);
  assert.equal(stats.active_session, null);
  assert.equal(stats.last_session, null);

  const bundle = await repo.getExportBundle('all', null);
  assert.equal(bundle.products.length, 0);
  assert.equal(bundle.observations.length, 0);
});

test('browser restart interrupts an active session instead of resuming silently', async () => {
  const store = new MemoryStore();
  const firstRepo = makeRepository(store);
  await firstRepo.ensureInitialized();
  const session = await firstRepo.startSession(SOURCE, 'test');
  await firstRepo.ingestBatch(session.session_id, [makeCard('700001')], SOURCE, 'test');

  const nextRepo = new CollectorRepository({
    store,
    now: makeClock('2026-02-01T00:00:00.000Z'),
    createId: makeIds('second'),
    parserVersion: 'test-1',
  });
  await nextRepo.ensureInitialized();
  await nextRepo.recoverOnStartup();

  const state = await nextRepo.getState();
  assert.equal(state.enabled, false);
  assert.equal(state.active_session_id, null);
  const stored = await nextRepo.getSession(session.session_id);
  assert.equal(stored?.status, 'interrupted');
  assert.ok(stored?.finished_at);
  assert.ok(state.warning);

  // Data survives the restart.
  const stats = await nextRepo.getStats();
  assert.equal(stats.total_products, 1);
});

test('1000 products are stored and exported through chunked indexes', async () => {
  const store = new MemoryStore();
  const repo = makeRepository(store);
  await repo.ensureInitialized();
  const session = await repo.startSession(SOURCE, 'load');

  const started = Date.now();
  let inserted = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const cards: CardExtraction[] = [];
    for (let index = 0; index < 100; index += 1) {
      inserted += 1;
      cards.push(makeCard(String(800000 + inserted), {}, '2026-03-01T00:00:00.000Z'));
    }
    const result = await repo.ingestBatch(session.session_id, cards, SOURCE, 'load');
    assert.equal(result.ok, true);
    assert.equal(result.accepted, 100);
  }
  const elapsed = Date.now() - started;

  const stats = await repo.getStats();
  assert.equal(stats.total_products, 1000);

  const bundle = await repo.getExportBundle('all', null);
  assert.equal(bundle.products.length, 1000);
  assert.equal(bundle.observations.length, 1000);
  assert.equal(bundle.sessions[0]?.unique_products, 1000);
  assert.equal(bundle.sessions[0]?.cards_discovered, 1000);

  // 10 chunks of 100 are expected.
  const rawMeta = await store.get(['meta', 'pidx:0', 'pidx:9']);
  assert.deepEqual(
    {
      chunks: (rawMeta.meta as { product_index_chunks: number }).product_index_chunks,
      first: (rawMeta['pidx:0'] as string[]).length,
      last: (rawMeta['pidx:9'] as string[]).length,
    },
    { chunks: 10, first: 100, last: 100 },
  );

  // The load benchmark is informational; keep a generous regression guard.
  assert.ok(elapsed < 60_000, `load test took ${elapsed}ms`);
});
