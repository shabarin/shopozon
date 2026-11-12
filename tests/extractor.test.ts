import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CARD_FIXTURES, expectedTitleOf, type CardFixture } from './fixtures/cards.ts';
import { extractCard, findCardRoot } from '../src/content/card-extractor.ts';
import { readJsonLd } from '../src/content/jsonld.ts';
import type { CardExtraction } from '../src/shared/types.ts';

const SOURCE_URL = 'https://www.ozon.ru/search/?text=test';
const COLLECTED_AT = '2026-11-11T12:00:00.000Z';

function buildDocument(fixtures: CardFixture[]): { dom: JSDOM; document: Document } {
  const cards = fixtures.map((fixture) => fixture.html).join('\n');
  const scripts = fixtures
    .filter((fixture) => fixture.jsonLd)
    .map((fixture) => `<script type="application/ld+json">${fixture.jsonLd}</script>`)
    .join('\n');
  const dom = new JSDOM(
    `<!doctype html><html><head>${scripts}</head><body><div data-widget="searchResultsV2">${cards}</div></body></html>`,
    { url: SOURCE_URL, pretendToBeVisual: true },
  );
  return { dom, document: dom.window.document };
}

function extractAll(): CardExtraction[] {
  const { document } = buildDocument(CARD_FIXTURES);
  const jsonLd = readJsonLd(document);
  return CARD_FIXTURES.map((fixture) => {
    const root = document.querySelector<HTMLElement>(`[data-fixture="${fixture.id}"]`);
    assert.ok(root, `fixture root ${fixture.id} not found`);
    return extractCard(root, {
      sourceUrl: SOURCE_URL,
      searchQuery: 'test',
      collectedAt: COLLECTED_AT,
      jsonLdIndex: jsonLd,
    });
  });
}

test('extraction matches all control fixtures', () => {
  const cards = extractAll();
  let urlMatches = 0;
  let titleMatches = 0;
  let priceMatches = 0;
  let falseNullValues = 0;

  CARD_FIXTURES.forEach((fixture, index) => {
    const card = cards[index];
    assert.ok(card);
    const expected = fixture.expected;

    if (card.url === expected.url) urlMatches += 1;
    else assert.fail(`${fixture.id}: url ${String(card.url)} != ${String(expected.url)}`);

    if (card.title === expected.title) titleMatches += 1;
    else assert.fail(`${fixture.id}: title ${JSON.stringify(card.title)} != ${JSON.stringify(expected.title)}`);

    if (card.price === expected.price) priceMatches += 1;
    else assert.fail(`${fixture.id}: price ${String(card.price)} != ${String(expected.price)}`);

    if (Object.prototype.hasOwnProperty.call(expected, 'product_id')) {
      assert.equal(card.product_id, expected.product_id, `${fixture.id}: product_id`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'original_price')) {
      assert.equal(card.original_price, expected.original_price, `${fixture.id}: original_price`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'discount')) {
      assert.equal(card.discount, expected.discount, `${fixture.id}: discount`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'volume')) {
      assert.equal(card.volume, expected.volume, `${fixture.id}: volume`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'volume_unit')) {
      assert.equal(card.volume_unit, expected.volume_unit, `${fixture.id}: volume_unit`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'quantity')) {
      assert.equal(card.quantity, expected.quantity, `${fixture.id}: quantity`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'seller')) {
      assert.equal(card.seller, expected.seller, `${fixture.id}: seller`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'rating')) {
      assert.equal(card.rating, expected.rating, `${fixture.id}: rating`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'review_count')) {
      assert.equal(card.review_count, expected.review_count, `${fixture.id}: review_count`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'availability')) {
      assert.equal(card.availability, expected.availability, `${fixture.id}: availability`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'price_type')) {
      assert.equal(card.price_type, expected.price_type, `${fixture.id}: price_type`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'ozon_card_price')) {
      assert.equal(card.prices.ozon_card?.amount ?? null, expected.ozon_card_price, `${fixture.id}: card price`);
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'subscription_price')) {
      assert.equal(
        card.prices.subscription?.amount ?? null,
        expected.subscription_price,
        `${fixture.id}: subscription price`,
      );
    }

    for (const field of fixture.nullFields ?? []) {
      const actual: unknown = (card as unknown as Record<string, unknown>)[field];
      if (actual === null || actual === undefined) falseNullValues += 1;
      else assert.fail(`${fixture.id}: expected null in ${field}, got ${String(actual)}`);
    }

    // The extracted field state must agree with the actual value.
    for (const [field, state] of Object.entries(card.field_states)) {
      if (state === 'extracted' && (card as unknown as Record<string, unknown>)[field] == null) {
        assert.fail(`${fixture.id}: ${field} marked extracted but is null`);
      }
    }
  });

  assert.equal(urlMatches, CARD_FIXTURES.length, 'URL accuracy must be 100%');
  assert.ok(titleMatches / CARD_FIXTURES.length >= 0.98, 'title accuracy must be >= 98%');
  assert.ok(priceMatches / CARD_FIXTURES.length >= 0.98, 'price accuracy must be >= 98%');
  assert.equal(falseNullValues, (CARD_FIXTURES.flatMap((fixture) => fixture.nullFields ?? [])).length);
});

test('JSON-LD fallback only fills absent fields', () => {
  const cards = extractAll();
  const fixture = CARD_FIXTURES.find((item) => item.id === 'c36');
  const card = cards[CARD_FIXTURES.indexOf(fixture!)];
  assert.ok(card);
  assert.equal(card.price, 777);
  assert.ok(card.extraction.fallback_fields.includes('price'));
  assert.ok(card.extraction.fallback_fields.includes('rating'));
  assert.ok(card.extraction.fallback_fields.includes('review_count'));
  assert.equal(card.extraction.status, 'success');

  const regular = cards[CARD_FIXTURES.findIndex((item) => item.id === 'c01')];
  assert.ok(regular);
  assert.deepEqual(regular.extraction.fallback_fields, []);
});

test('ambiguous and broken cards are not replaced with invented values', () => {
  const cards = extractAll();
  const byId = new Map(CARD_FIXTURES.map((fixture, index) => [fixture.id, cards[index]]));
  assert.equal(byId.get('c17')?.volume, null);
  assert.equal(byId.get('c17')?.field_states.volume, 'failed');
  assert.equal(byId.get('c27')?.volume, null);
  assert.equal(byId.get('c27')?.quantity, null);
  assert.equal(byId.get('c33')?.price, null);
  assert.equal(byId.get('c33')?.field_states.price, 'failed');
  assert.equal(byId.get('c25')?.discount, 20);
  assert.equal(byId.get('c25')?.title, 'Масло 10%, 100 мл');
  assert.equal(byId.get('c19')?.product_id, null);
  assert.equal(byId.get('c19')?.url, 'https://www.ozon.ru/product/no-digits/');
  assert.equal(expectedTitleOf(CARD_FIXTURES[10]!), 'Товар без цены, 10 мл');
});

test('card root detection does not swallow neighbouring tiles', () => {
  const { document } = buildDocument([CARD_FIXTURES[0]!, CARD_FIXTURES[1]!]);
  const links = document.querySelectorAll('a[href*="/product/"]');
  assert.ok(links.length >= 4);
  for (const link of links) {
    const root = findCardRoot(link);
    assert.ok(root, 'every product link must resolve to a card root');
    assert.match(root.getAttribute('data-fixture') ?? '', /^c0[12]$/);
    const inside = root.querySelectorAll('a[href*="/product/"]').length;
    assert.ok(inside >= 2 && inside <= 3, `unexpected link count ${inside}`);
  }
});
