import { FIELD_NAMES, type CardExtraction, type FieldName, type FieldState } from '../src/shared/types.ts';
import { MemoryStore } from '../src/storage/memory.ts';
import { CollectorRepository } from '../src/storage/repository.ts';
import { buildObservationsCsv, buildProductsCsv } from '../src/export/index.ts';

const SOURCE = 'https://www.ozon.ru/search/?text=bench';
const TOTAL = Number(process.env.BENCH_PRODUCTS ?? 5000);
const BATCH = 100;

function states(): Record<FieldName, FieldState> {
  const result = {} as Record<FieldName, FieldState>;
  for (const field of FIELD_NAMES) result[field] = 'absent';
  for (const field of ['product_id', 'url', 'title', 'price', 'currency'] as FieldName[]) {
    result[field] = 'extracted';
  }
  return result;
}

function card(id: number): CardExtraction {
  const productId = String(1_000_000 + id);
  return {
    product_id: productId,
    url: `https://www.ozon.ru/product/bench-${productId}/`,
    title: `Товар ${productId}, 100 мл`,
    price: 100 + (id % 900),
    currency: 'RUB',
    original_price: 150 + (id % 900),
    discount: 20,
    discount_text: '-20%',
    volume: 100,
    volume_unit: 'ml',
    quantity: 1,
    seller: `Продавец ${id % 50}`,
    rating: 4.5,
    review_count: id % 5000,
    availability: 'in_stock',
    availability_text: 'В наличии',
    price_type: 'regular',
    price_conditions: null,
    prices: {
      main: {
        type: 'main',
        amount: 100 + (id % 900),
        currency: 'RUB',
        raw_text: `${100 + (id % 900)} ₽`,
        conditions: null,
      },
      original: null,
      ozon_card: null,
      subscription: null,
      other: [],
    },
    collected_at: new Date(Date.now() - id * 1000).toISOString(),
    source_url: SOURCE,
    search_query: 'bench',
    field_states: states(),
    extraction: {
      status: 'success',
      extracted_fields: ['product_id', 'url', 'title', 'price', 'currency'],
      missing_fields: [],
      failed_fields: [],
      errors: [],
      fallback_fields: [],
      extraction_version: 'bench-1',
    },
  };
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  const repository = new CollectorRepository({
    store,
    now: () => new Date(),
    createId: (() => {
      let value = 0;
      return () => `bench-${++value}`;
    })(),
  });
  await repository.ensureInitialized();
  const session = await repository.startSession(SOURCE, 'bench');

  const ingestStarted = performance.now();
  for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const batch: CardExtraction[] = [];
    for (let index = offset; index < Math.min(offset + BATCH, TOTAL); index += 1) {
      batch.push(card(index));
    }
    const result = await repository.ingestBatch(session.session_id, batch, SOURCE, 'bench');
    if (!result.ok) throw new Error(`Импорт не удался: ${result.code ?? 'unknown'}`);
  }
  const ingestMs = performance.now() - ingestStarted;

  const exportStarted = performance.now();
  const bundle = await repository.getExportBundle('all', null);
  const productsCsv = buildProductsCsv(bundle.products);
  const observationsCsv = buildObservationsCsv(bundle.observations);
  const json = JSON.stringify(bundle);
  const exportMs = performance.now() - exportStarted;

  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  console.log('Нагрузочный тест локального хранилища');
  console.log(`Товаров: ${bundle.products.length}`);
  console.log(`Наблюдений: ${bundle.observations.length}`);
  console.log(`Ключей в MemoryStore: ${store.size()}`);
  console.log(`Импорт: ${ingestMs.toFixed(0)} мс (${(TOTAL / (ingestMs / 1000)).toFixed(0)} карточек/с)`);
  console.log(`Экспорт (bundle + CSV + JSON): ${exportMs.toFixed(0)} мс`);
  console.log(`CSV товары: ${(bytes(productsCsv) / 1024).toFixed(0)} KiB`);
  console.log(`CSV наблюдения: ${(bytes(observationsCsv) / 1024).toFixed(0)} KiB`);
  console.log(`JSON: ${(bytes(json) / 1024).toFixed(0)} KiB`);

  if (bundle.products.length !== TOTAL) {
    throw new Error(`Ожидалось ${TOTAL} товаров, получено ${bundle.products.length}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
