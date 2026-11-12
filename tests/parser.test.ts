import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findPriceMatches,
  parsePriceConditions,
  parsePriceNumber,
  parsePriceText,
} from '../src/parser/price.ts';
import { parseDiscountText } from '../src/parser/discount.ts';
import { parseQuantityVolume } from '../src/parser/volume.ts';
import {
  extractSearchQuery,
  isListingPage,
  isOzonListingUrl,
  parseProductId,
  parseProductLink,
} from '../src/parser/url.ts';
import {
  parseRatingFromText,
  parseRatingValue,
  parseReviewCountText,
} from '../src/parser/rating.ts';
import { parseAvailability } from '../src/parser/availability.ts';

test('price numbers follow Russian display formats', () => {
  assert.equal(parsePriceNumber('1 234'), 1234);
  assert.equal(parsePriceNumber('1\u00A0234,50'), 1234.5);
  assert.equal(parsePriceNumber('1.234,56'), 1234.56);
  assert.equal(parsePriceNumber('1,234.56'), 1234.56);
  assert.equal(parsePriceNumber('1.234'), 1234);
  assert.equal(parsePriceNumber('0,75'), 0.75);
  assert.equal(parsePriceNumber('12.99'), 12.99);
  assert.equal(parsePriceNumber('12.990'), 12990);
  assert.equal(parsePriceNumber(''), null);
  assert.equal(parsePriceNumber('—'), null);
});

test('prices are found together with their currency', () => {
  assert.deepEqual(
    findPriceMatches('1 199 ₽ с Ozon Картой').map((item) => [item.amount, item.currency]),
    [[1199, 'RUB']],
  );
  assert.deepEqual(
    findPriceMatches('от 350 руб.').map((item) => [item.amount, item.currency]),
    [[350, 'RUB']],
  );
  assert.equal(parsePriceText('Цена по запросу ₽'), null);
  assert.deepEqual(
    findPriceMatches('1 234,50 ₽').map((item) => item.amount),
    [1234.5],
  );
});

test('price conditions distinguish card, subscription, monthly and per-unit prices', () => {
  const card = parsePriceConditions('1 199 ₽ с Ozon Картой');
  assert.equal(card.ozon_card, true);
  assert.equal(card.no_card, false);

  const noCard = parsePriceConditions('1 499 ₽ без Ozon Карты');
  assert.equal(noCard.no_card, true);
  assert.equal(noCard.ozon_card, false);

  const cardReversed = parsePriceConditions('1 000 ₽ по карте Ozon');
  assert.equal(cardReversed.ozon_card, true);

  const subscription = parsePriceConditions('999 ₽ по подписке Ozon Premium');
  assert.equal(subscription.subscription, true);

  const monthly = parsePriceConditions('123 ₽/мес');
  assert.equal(monthly.monthly, true);

  const perUnit = parsePriceConditions('12 ₽/шт');
  assert.equal(perUnit.per_unit, true);
});

test('discounts are parsed only from explicit discount labels', () => {
  assert.equal(parseDiscountText('-35%')?.percent, 35);
  assert.equal(parseDiscountText('−20%')?.percent, 20);
  assert.equal(parseDiscountText('Скидка 20%')?.percent, 20);
  assert.equal(parseDiscountText('20% скидка')?.percent, 20);
  assert.equal(parseDiscountText('Скидка до 15%')?.percent, 15);
  assert.equal(parseDiscountText('Масло 10%'), null);
  assert.equal(parseDiscountText('Товар 100% хлопок'), null);
  assert.equal(parseDiscountText('100%'), null);
  assert.equal(parseDiscountText(''), null);
});

test('volume and quantity are extracted conservatively', () => {
  const paste = parseQuantityVolume('Elmex, зубная паста, 75 мл');
  assert.equal(paste.volume, 75);
  assert.equal(paste.volume_unit, 'ml');
  assert.equal(paste.quantity, 1);

  const set = parseQuantityVolume('Elmex, 2 × 75 мл');
  assert.equal(set.volume, 75);
  assert.equal(set.quantity, 2);

  const setBackward = parseQuantityVolume('Гель 75 мл x 3');
  assert.equal(setBackward.volume, 75);
  assert.equal(setBackward.quantity, 3);

  const pack = parseQuantityVolume('Гель для душа, набор из 3 штук');
  assert.equal(pack.volume, null);
  assert.equal(pack.quantity, 3);

  const weight = parseQuantityVolume('Сахар, 500 г');
  assert.equal(weight.volume, 500);
  assert.equal(weight.volume_unit, 'g');

  const range = parseQuantityVolume('Крем, 100-200 мл');
  assert.equal(range.volume, null);
  assert.equal(range.volume_state, 'failed');

  const me = parseQuantityVolume('Витамин D3, 1000 МЕ');
  assert.equal(me.volume, null);
  assert.equal(me.quantity, null);

  const liters = parseQuantityVolume('Молоко, 0,75 л');
  assert.equal(liters.volume, 0.75);
  assert.equal(liters.volume_unit, 'l');

  const empty = parseQuantityVolume(null);
  assert.equal(empty.volume, null);
  assert.equal(empty.quantity, null);
});

test('product links are canonicalized and product ids extracted', () => {
  assert.equal(parseProductId('krem-dlya-ruk-123456789'), '123456789');
  assert.equal(parseProductId('no-digits'), null);
  assert.equal(parseProductId('/product/foo-900123/?at=tracking'), '900123');

  const link = parseProductLink(
    'https://www.ozon.ru/product/krem-123456/?at=xyz&sh=abc#reviews',
  );
  assert.deepEqual(link, {
    url: 'https://www.ozon.ru/product/krem-123456/',
    normalized_url: 'https://www.ozon.ru/product/krem-123456',
    product_id: '123456',
  });
  assert.equal(parseProductLink('/product/slug-987654/reviews/'), null);
  assert.equal(parseProductLink('https://example.com/product/x-123456/'), null);
  assert.equal(parseProductLink('javascript:void(0)'), null);
});

test('search query and listing detection are strict', () => {
  assert.equal(
    extractSearchQuery('https://www.ozon.ru/search/?text=%D0%BA%D1%80%D0%B5%D0%BC&from=global'),
    'крем',
  );
  assert.equal(extractSearchQuery('https://www.ozon.ru/search/крем/'), 'крем');
  assert.equal(extractSearchQuery('https://www.ozon.ru/product/x-1/'), null);

  assert.equal(isListingPage('https://www.ozon.ru/search/?text=крем'), true);
  assert.equal(isListingPage('https://www.ozon.ru/category/kosmetika-123/'), true);
  assert.equal(isListingPage('https://www.ozon.ru/product/x-123/'), false);
  assert.equal(isListingPage('https://www.ozon.ru/cart/'), false);
  assert.equal(isListingPage('https://www.ozon.ru/my/orderlist/'), false);
  assert.equal(isOzonListingUrl('https://example.com/search/?text=x'), false);
  assert.equal(isOzonListingUrl('https://www.ozon.ru/search/?text=x'), true);
});

test('ratings and review counts come from card wording', () => {
  assert.equal(parseRatingValue('4,8'), 4.8);
  assert.equal(parseRatingValue('4.8'), 4.8);
  assert.equal(parseRatingValue('5.0'), 5);
  assert.equal(parseRatingValue('5'), 5);
  assert.equal(parseRatingValue('6,1'), null);
  assert.equal(parseRatingValue('рейтинг 4,6 из 5'), 4.6);
  assert.equal(parseRatingValue('4,8', false), 4.8);
  assert.equal(parseRatingValue('5', false), null);

  assert.equal(parseRatingFromText('4,8 · 123 отзыва'), 4.8);
  assert.equal(parseRatingFromText('рейтинг 4.6'), 4.6);

  assert.equal(parseReviewCountText('123 отзыва'), 123);
  assert.equal(parseReviewCountText('1 234 оценки'), 1234);
  assert.equal(parseReviewCountText('нет отзывов'), 0);
  assert.equal(parseReviewCountText('нет оценок'), 0);
  assert.equal(parseReviewCountText('Пока нет отзывов'), 0);
  assert.equal(parseReviewCountText('125'), 125);
  assert.equal(parseReviewCountText('продавец'), null);
});

test('availability wording is mapped to a nullable state', () => {
  assert.equal(parseAvailability('Нет в наличии').availability, 'out_of_stock');
  assert.equal(parseAvailability('Товар закончился').availability, 'out_of_stock');
  assert.equal(parseAvailability('Распродано').availability, 'out_of_stock');
  assert.equal(parseAvailability('Осталось 2 шт').availability, 'in_stock');
  assert.equal(parseAvailability('В наличии').availability, 'in_stock');
  assert.equal(parseAvailability('Доставим завтра').availability, null);
  assert.equal(parseAvailability('').availability, null);
  assert.equal(parseAvailability(null).availability, null);
});
