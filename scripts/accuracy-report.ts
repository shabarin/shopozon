import { JSDOM } from 'jsdom';
import { CARD_FIXTURES } from '../tests/fixtures/cards.ts';
import { extractCard } from '../src/content/card-extractor.ts';
import { readJsonLd } from '../src/content/jsonld.ts';
import type { CardExtraction } from '../src/shared/types.ts';

const SOURCE_URL = 'https://www.ozon.ru/search/?text=accuracy';
const COLLECTED_AT = '2026-11-11T12:00:00.000Z';

const FIELDS = [
  'product_id',
  'url',
  'title',
  'price',
  'original_price',
  'discount',
  'volume',
  'volume_unit',
  'quantity',
  'seller',
  'rating',
  'review_count',
  'availability',
  'price_type',
] as const;

type Field = (typeof FIELDS)[number];

function buildDocument(): Document {
  const cards = CARD_FIXTURES.map((fixture) => fixture.html).join('\n');
  const scripts = CARD_FIXTURES.filter((fixture) => fixture.jsonLd)
    .map((fixture) => `<script type="application/ld+json">${fixture.jsonLd}</script>`)
    .join('\n');
  return new JSDOM(
    `<!doctype html><html><head>${scripts}</head><body><div data-widget="searchResultsV2">${cards}</div></body></html>`,
    { url: SOURCE_URL, pretendToBeVisual: true },
  ).window.document;
}

function main(): void {
  const document = buildDocument();
  const jsonLd = readJsonLd(document);
  const cards: CardExtraction[] = CARD_FIXTURES.map((fixture) => {
    const root = document.querySelector<HTMLElement>(`[data-fixture="${fixture.id}"]`);
    if (!root) throw new Error(`Fixture ${fixture.id} not found`);
    return extractCard(root, {
      sourceUrl: SOURCE_URL,
      searchQuery: 'accuracy',
      collectedAt: COLLECTED_AT,
      jsonLdIndex: jsonLd,
    });
  });

  const rows: { field: Field; compared: number; correct: number; accuracy: number }[] = [];
  for (const field of FIELDS) {
    let compared = 0;
    let correct = 0;
    CARD_FIXTURES.forEach((fixture, index) => {
      if (!Object.prototype.hasOwnProperty.call(fixture.expected, field)) return;
      compared += 1;
      const actual = (cards[index] as unknown as Record<string, unknown>)[field];
      if (actual === (fixture.expected as Record<string, unknown>)[field]) correct += 1;
    });
    rows.push({ field, compared, correct, accuracy: compared === 0 ? 1 : correct / compared });
  }

  let nullCompared = 0;
  let nullCorrect = 0;
  for (const [index, fixture] of CARD_FIXTURES.entries()) {
    for (const field of fixture.nullFields ?? []) {
      nullCompared += 1;
      const actual = (cards[index] as unknown as Record<string, unknown>)[field];
      if (actual === null || actual === undefined) nullCorrect += 1;
    }
  }

  const statuses = { success: 0, partial: 0, failed: 0 };
  for (const card of cards) statuses[card.extraction.status] += 1;

  const lines: string[] = [];
  lines.push('# Отчёт о точности извлечения');
  lines.push('');
  lines.push(`Дата генерации: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(
    'Отчёт строится по синтетическому набору из 36 контрольных карточек, повторяющих разметку Ozon. ' +
      'Это регрессионный тест парсера, а не гарантия точности на живом сайте: перед публикацией ' +
      'выполните проверку на реальной выдаче (см. README, раздел «Проверка на живом Ozon»).',
  );
  lines.push('');
  lines.push('## Сводка');
  lines.push('');
  lines.push(`- Карточек: ${CARD_FIXTURES.length}`);
  lines.push(`- Успешно (ссылка + название + цена): ${statuses.success}`);
  lines.push(`- Частично: ${statuses.partial}`);
  lines.push(`- Неудачно: ${statuses.failed}`);
  lines.push(
    `- Корректных null-значений: ${nullCorrect}/${nullCompared} (${((nullCorrect / Math.max(nullCompared, 1)) * 100).toFixed(1)}%)`,
  );
  lines.push('');
  lines.push('## Точность по полям');
  lines.push('');
  lines.push('| Поле | Сравнений | Совпало | Точность |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of rows) {
    lines.push(
      `| ${row.field} | ${row.compared} | ${row.correct} | ${(row.accuracy * 100).toFixed(1)}% |`,
    );
  }
  lines.push('');
  lines.push('## Ограничения');
  lines.push('');
  lines.push('- Цены с условиями (Ozon Карта, подписка) зависят от региона и авторизации.');
  lines.push('- Объём/количество извлекаются из названия; диапазоны и неоднозначные случаи дают `null`.');
  lines.push('- JSON-LD используется только как резервный источник для отсутствующих на карточке полей.');
  lines.push('- Рейтинг и число отзывов могут отсутствовать у новых товаров — это не ошибка.');
  lines.push('');

  const report = `${lines.join('\n')}\n`;
  console.log(report);

  const failures = rows.filter(
    (row) =>
      (row.field === 'url' && row.accuracy < 1) ||
      ((row.field === 'title' || row.field === 'price') && row.accuracy < 0.98),
  );
  if (nullCorrect !== nullCompared || failures.length > 0) {
    console.error('Точность ниже порога.');
    process.exitCode = 1;
  }
}

main();
