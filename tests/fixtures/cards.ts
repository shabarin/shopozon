import type { Availability, VolumeUnit } from '../../src/shared/types.ts';
import { normalizeText } from '../../src/shared/util.ts';

export interface ExpectedCard {
  product_id: string | null;
  url: string | null;
  title: string | null;
  price: number | null;
  original_price: number | null;
  discount: number | null;
  volume: number | null;
  volume_unit: VolumeUnit | null;
  quantity: number | null;
  seller: string | null;
  rating: number | null;
  review_count: number | null;
  availability: Availability;
  price_type: string;
  ozon_card_price: number | null;
  subscription_price: number | null;
}

export interface CardFixture {
  id: string;
  category: string;
  html: string;
  expected: Partial<ExpectedCard>;
  nullFields?: (keyof ExpectedCard)[];
  jsonLd?: string;
}

interface CardOptions {
  id: string;
  productId?: string | null;
  slug?: string;
  title: string;
  titleHtml?: string;
  imgAlt?: string;
  priceHtml?: string;
  original?: number;
  originalText?: string;
  discountLabel?: string;
  rating?: number | null;
  ratingText?: string;
  reviews?: number | string | null;
  reviewText?: string;
  seller?: string | null;
  sellerHtml?: string;
  availabilityHtml?: string;
  extraHtml?: string;
  noTitleLink?: boolean;
  href?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function priceText(amount: number): string {
  return `${amount.toLocaleString('ru-RU').replace(/\u00A0/g, ' ')} ₽`;
}

function makeCard(options: CardOptions): string {
  const slug = options.slug ?? `fixture-${options.productId ?? options.id}`;
  const href = options.href ?? `/product/${slug}/`;
  const title = escapeHtml(options.title);
  const titleHtml =
    options.titleHtml ??
    `<span class="tsBody500Medium">${title}</span>`;
  const priceHtml =
    options.priceHtml ??
    (options.priceHtml === ''
      ? ''
      : `<span class="tsHeadline500Medium price" style="font-size:22px">${priceText(350)}</span>`);
  const originalHtml =
    options.original !== undefined
      ? `<span class="old-price" style="text-decoration: line-through">${
          options.originalText ?? priceText(options.original)
        }</span>`
      : '';
  const discountHtml = options.discountLabel
    ? `<span class="discount-badge">${escapeHtml(options.discountLabel)}</span>`
    : '';
  const ratingHtml =
    options.rating === undefined
      ? ''
      : `<div class="rating">${escapeHtml(
          options.ratingText ?? String(options.rating).replace('.', ','),
        )}</div>`;
  const reviewsHtml =
    options.reviews === undefined || options.reviews === null
      ? ''
      : `<a class="reviews" href="${href}reviews/">${escapeHtml(
          options.reviewText ??
            `${Number(options.reviews).toLocaleString('ru-RU').replace(/\u00A0/g, ' ')} отзыва`,
        )}</a>`;
  const sellerHtml =
    options.sellerHtml ??
    (options.seller ? `<a class="seller-link" href="/seller/shop">${escapeHtml(options.seller)}</a>` : '');
  const availabilityHtml = options.availabilityHtml
    ? `<span class="availability">${escapeHtml(options.availabilityHtml)}</span>`
    : '';
  const titleLink = options.noTitleLink
    ? ''
    : `<a class="tile-title-link" href="${href}">${titleHtml}</a>`;

  return `
    <div class="tile-root" data-fixture="${options.id}">
      <a class="tile-image-link" href="${href}" aria-label="${title}"><img src="x.jpg" alt="${escapeHtml(
        options.imgAlt ?? options.title,
      )}" /></a>
      <div class="tile-body">
        ${titleLink}
        <div class="price-block">${priceHtml}${originalHtml}${discountHtml}</div>
        ${ratingHtml}
        ${reviewsHtml}
        ${sellerHtml}
        ${availabilityHtml}
        ${options.extraHtml ?? ''}
      </div>
    </div>`;
}

const price350 = `<span class="tsHeadline500Medium price" style="font-size:22px">350 ₽</span>`;

export const CARD_FIXTURES: CardFixture[] = [
  {
    id: 'c01',
    category: 'обычный товар',
    html: makeCard({
      id: 'c01',
      productId: '900001',
      title: 'Elmex, зубная паста, 75 мл',
      priceHtml: price350,
      rating: 4.8,
      reviews: 123,
      seller: 'ООО Ромашка',
      availabilityHtml: 'В наличии',
    }),
    expected: {
      product_id: '900001',
      title: 'Elmex, зубная паста, 75 мл',
      price: 350,
      volume: 75,
      volume_unit: 'ml',
      quantity: 1,
      seller: 'ООО Ромашка',
      rating: 4.8,
      review_count: 123,
      availability: 'in_stock',
    },
  },
  {
    id: 'c02',
    category: 'товар со скидкой и зачёркнутой ценой',
    html: makeCard({
      id: 'c02',
      productId: '900002',
      title: 'Крем для рук, 100 мл',
      priceHtml: `<span class="tsHeadline500Medium price" style="font-size:24px">1 234 ₽</span>`,
      original: 2000,
      discountLabel: '-38%',
      rating: 4.5,
      reviews: 1234,
    }),
    expected: {
      price: 1234,
      original_price: 2000,
      discount: 38,
      volume: 100,
      volume_unit: 'ml',
      quantity: 1,
      rating: 4.5,
      review_count: 1234,
    },
  },
  {
    id: 'c03',
    category: 'цена по Ozon Карте',
    html: makeCard({
      id: 'c03',
      productId: '900003',
      title: 'Наушники беспроводные, 1 шт.',
      priceHtml:
        '<span class="price" style="font-size:24px">1 199 ₽ с Ozon Картой</span>' +
        '<span class="price" style="font-size:13px">1 499 ₽ без Ozon Карты</span>',
    }),
    expected: {
      price: 1199,
      price_type: 'ozon_card',
      ozon_card_price: 1199,
      quantity: 1,
    },
  },
  {
    id: 'c04',
    category: 'цена по подписке',
    html: makeCard({
      id: 'c04',
      productId: '900004',
      title: 'Средство для стирки, 1,5 л',
      priceHtml:
        '<span class="tsHeadline500Medium price" style="font-size:24px">1 299 ₽</span>' +
        '<span class="price" style="font-size:12px">999 ₽ по подписке Ozon Premium</span>',
    }),
    expected: {
      price: 1299,
      price_type: 'regular',
      subscription_price: 999,
      volume: 1.5,
      volume_unit: 'l',
      quantity: 1,
    },
  },
  {
    id: 'c05',
    category: 'набор 2 × 75 мл',
    html: makeCard({
      id: 'c05',
      productId: '900005',
      title: 'Elmex, 2 × 75 мл',
      priceHtml: price350,
    }),
    expected: { price: 350, volume: 75, volume_unit: 'ml', quantity: 2 },
  },
  {
    id: 'c06',
    category: 'набор из 3 штук',
    html: makeCard({
      id: 'c06',
      productId: '900006',
      title: 'Гель для душа, набор из 3 штук',
      priceHtml: price350,
    }),
    expected: { price: 350, volume: null, volume_unit: null, quantity: 3 },
  },
  {
    id: 'c07',
    category: 'объём 1 литр',
    html: makeCard({
      id: 'c07',
      productId: '900007',
      title: 'Шампунь, 1 л',
      priceHtml: price350,
    }),
    expected: { price: 350, volume: 1, volume_unit: 'l', quantity: 1 },
  },
  {
    id: 'c08',
    category: 'карточка без рейтинга',
    html: makeCard({
      id: 'c08',
      productId: '900008',
      title: 'Крем без рейтинга, 50 мл',
      priceHtml: price350,
      seller: 'Продавец Без Рейтинга',
    }),
    expected: { price: 350, volume: 50, volume_unit: 'ml', quantity: 1, seller: 'Продавец Без Рейтинга' },
    nullFields: ['rating', 'review_count'],
  },
  {
    id: 'c09',
    category: 'карточка без продавца',
    html: makeCard({
      id: 'c09',
      productId: '900009',
      title: 'Товар без продавца, 30 мл',
      priceHtml: price350,
      seller: null,
      rating: 4.9,
      reviews: 8,
    }),
    expected: { price: 350, rating: 4.9, review_count: 8, volume: 30, volume_unit: 'ml' },
    nullFields: ['seller'],
  },
  {
    id: 'c10',
    category: 'длинное название',
    html: makeCard({
      id: 'c10',
      productId: '900010',
      title: `${'Очень длинное название товара для проверки переноса и сохранения полного текста '.repeat(4)}100 мл`,
      priceHtml: price350,
    }),
    expected: {
      price: 350,
      volume: 100,
      volume_unit: 'ml',
      quantity: 1,
      title: normalizeText(
        `${'Очень длинное название товара для проверки переноса и сохранения полного текста '.repeat(4)}100 мл`,
      ),
    },
  },
  {
    id: 'c11',
    category: 'карточка без цены',
    html: makeCard({
      id: 'c11',
      productId: '900011',
      title: 'Товар без цены, 10 мл',
      priceHtml: '',
      rating: 4.1,
      reviews: 3,
    }),
    expected: { title: 'Товар без цены, 10 мл', rating: 4.1, review_count: 3, volume: 10, volume_unit: 'ml' },
    nullFields: ['price', 'original_price', 'discount'],
  },
  {
    id: 'c12',
    category: 'нет в наличии',
    html: makeCard({
      id: 'c12',
      productId: '900012',
      title: 'Товар закончился, 20 мл',
      priceHtml: price350,
      availabilityHtml: 'Нет в наличии',
    }),
    expected: { price: 350, availability: 'out_of_stock' },
  },
  {
    id: 'c13',
    category: 'цена с копейками',
    html: makeCard({
      id: 'c13',
      productId: '900013',
      title: 'Товар с копейками, 10 мл',
      priceHtml: `<span class="price">1 234,50 ₽</span>`,
    }),
    expected: { price: 1234.5 },
  },
  {
    id: 'c14',
    category: 'неразрывные пробелы в цене',
    html: makeCard({
      id: 'c14',
      productId: '900014',
      title: 'Товар с NBSP, 10 мл',
      priceHtml: `<span class="price">1\u00A0234\u00A0₽</span>`,
    }),
    expected: { price: 1234 },
  },
  {
    id: 'c15',
    category: 'количество 3 шт',
    html: makeCard({
      id: 'c15',
      productId: '900015',
      title: 'Салфетки, 3 шт.',
      priceHtml: price350,
    }),
    expected: { volume: null, volume_unit: null, quantity: 3 },
  },
  {
    id: 'c16',
    category: 'вес 500 г',
    html: makeCard({
      id: 'c16',
      productId: '900016',
      title: 'Сахар, 500 г',
      priceHtml: price350,
    }),
    expected: { volume: 500, volume_unit: 'g', quantity: 1 },
  },
  {
    id: 'c17',
    category: 'неоднозначный объём',
    html: makeCard({
      id: 'c17',
      productId: '900017',
      title: 'Крем, 100-200 мл',
      priceHtml: price350,
    }),
    expected: { volume: null, volume_unit: null, quantity: null },
  },
  {
    id: 'c18',
    category: 'дробный объём 0,75 л',
    html: makeCard({
      id: 'c18',
      productId: '900018',
      title: 'Молоко, 0,75 л',
      priceHtml: price350,
    }),
    expected: { volume: 0.75, volume_unit: 'l', quantity: 1 },
  },
  {
    id: 'c19',
    category: 'ссылка без числового id',
    html: makeCard({
      id: 'c19',
      productId: null,
      slug: 'no-digits',
      title: 'Товар без числового идентификатора, 5 мл',
      priceHtml: price350,
    }),
    expected: {
      product_id: null,
      url: 'https://www.ozon.ru/product/no-digits/',
      price: 350,
      volume: 5,
      volume_unit: 'ml',
    },
  },
  {
    id: 'c20',
    category: 'несколько ссылок на товар',
    html: makeCard({
      id: 'c20',
      productId: '900020',
      title: 'Товар с несколькими ссылками, 25 мл',
      priceHtml: price350,
      extraHtml: '<a href="/product/fixture-900020/?at=tracking"><span>Купить</span></a>',
    }),
    expected: { title: 'Товар с несколькими ссылками, 25 мл', price: 350 },
  },
  {
    id: 'c21',
    category: 'бейдж внутри ссылки на название',
    html: makeCard({
      id: 'c21',
      productId: '900021',
      title: 'Товар с бейджем, 15 мл',
      titleHtml:
        '<span class="badge">Хит</span><span class="tsBody500Medium">Товар с бейджем, 15 мл</span>',
      priceHtml: price350,
    }),
    expected: { title: 'Товар с бейджем, 15 мл', price: 350 },
  },
  {
    id: 'c22',
    category: 'много отзывов',
    html: makeCard({
      id: 'c22',
      productId: '900022',
      title: 'Популярный товар, 40 мл',
      priceHtml: price350,
      rating: 4.7,
      reviews: 1234,
    }),
    expected: { rating: 4.7, review_count: 1234 },
  },
  {
    id: 'c23',
    category: 'рейтинг 5.0',
    html: makeCard({
      id: 'c23',
      productId: '900023',
      title: 'Товар с рейтингом 5, 10 мл',
      priceHtml: price350,
      rating: 5,
      ratingText: '5.0',
      reviews: 2,
    }),
    expected: { rating: 5, review_count: 2 },
  },
  {
    id: 'c24',
    category: 'скидка словом',
    html: makeCard({
      id: 'c24',
      productId: '900024',
      title: 'Товар со скидкой, 60 мл',
      priceHtml: price350,
      discountLabel: 'Скидка 20%',
    }),
    expected: { discount: 20 },
  },
  {
    id: 'c25',
    category: 'процент в названии не является скидкой',
    html: makeCard({
      id: 'c25',
      productId: '900025',
      title: 'Масло 10%, 100 мл',
      priceHtml: price350,
      discountLabel: '-20%',
    }),
    expected: { title: 'Масло 10%, 100 мл', discount: 20, volume: 100, volume_unit: 'ml' },
  },
  {
    id: 'c26',
    category: 'набор с объёмом',
    html: makeCard({
      id: 'c26',
      productId: '900026',
      title: 'Набор из 3 шт. по 75 мл',
      priceHtml: price350,
    }),
    expected: { volume: 75, volume_unit: 'ml', quantity: 3 },
  },
  {
    id: 'c27',
    category: 'МЕ не объём',
    html: makeCard({
      id: 'c27',
      productId: '900027',
      title: 'Витамин D3, 1000 МЕ',
      priceHtml: price350,
    }),
    expected: { volume: null, volume_unit: null, quantity: null },
  },
  {
    id: 'c28',
    category: 'платёж в месяц игнорируется',
    html: makeCard({
      id: 'c28',
      productId: '900028',
      title: 'Товар с рассрочкой, 30 мл',
      priceHtml:
        '<span class="price" style="font-size:24px">1 500 ₽</span>' +
        '<span class="price" style="font-size:11px">123 ₽/мес</span>',
    }),
    expected: { price: 1500 },
  },
  {
    id: 'c29',
    category: 'цена по карте Ozon',
    html: makeCard({
      id: 'c29',
      productId: '900029',
      title: 'Товар по карте, 20 мл',
      priceHtml: '<span class="price" style="font-size:24px">1 000 ₽ по карте Ozon</span>',
    }),
    expected: { price: 1000, price_type: 'ozon_card', ozon_card_price: 1000 },
  },
  {
    id: 'c30',
    category: 'продавец с подписью',
    html: makeCard({
      id: 'c30',
      productId: '900030',
      title: 'Товар с продавцом, 10 мл',
      priceHtml: price350,
      sellerHtml: '<span class="seller">Продавец: ИП Иванов</span>',
    }),
    expected: { seller: 'ИП Иванов' },
  },
  {
    id: 'c31',
    category: 'название из alt изображения',
    html: makeCard({
      id: 'c31',
      productId: '900031',
      title: 'Товар только с alt, 10 мл',
      noTitleLink: true,
      imgAlt: 'Товар только с alt, 10 мл',
      priceHtml: price350,
    }),
    expected: { title: 'Товар только с alt, 10 мл', price: 350 },
  },
  {
    id: 'c32',
    category: 'карточка без названия',
    html: makeCard({
      id: 'c32',
      productId: '900032',
      title: 'Невидимое название, 10 мл',
      titleHtml: '<span class="tsBody500Medium"></span>',
      imgAlt: '',
      priceHtml: price350,
    }),
    expected: { price: 350 },
    nullFields: ['title'],
  },
  {
    id: 'c33',
    category: 'цена присутствует, но не парсится',
    html: makeCard({
      id: 'c33',
      productId: '900033',
      title: 'Товар с ценой по запросу, 10 мл',
      priceHtml: '<span class="price">Цена по запросу ₽</span>',
    }),
    expected: { title: 'Товар с ценой по запросу, 10 мл' },
    nullFields: ['price', 'original_price'],
  },
  {
    id: 'c34',
    category: 'процент скидки и зачёркнутая цена',
    html: makeCard({
      id: 'c34',
      productId: '900034',
      title: 'Товар со старой ценой, 100 мл',
      priceHtml: `<span class="price" style="font-size:24px">1 300 ₽</span>`,
      original: 2000,
      discountLabel: '-35%',
    }),
    expected: { price: 1300, original_price: 2000, discount: 35 },
  },
  {
    id: 'c35',
    category: 'осталось мало',
    html: makeCard({
      id: 'c35',
      productId: '900035',
      title: 'Товар с остатком, 10 мл',
      priceHtml: price350,
      availabilityHtml: 'Осталось 2 шт',
    }),
    expected: { availability: 'in_stock', volume: 10, volume_unit: 'ml', quantity: 1 },
  },
  {
    id: 'c36',
    category: 'JSON-LD fallback',
    html: makeCard({
      id: 'c36',
      productId: '900036',
      title: 'Товар с JSON-LD, 10 мл',
      priceHtml: '',
    }),
    expected: {
      title: 'Товар с JSON-LD, 10 мл',
      price: 777,
      rating: 4.2,
      review_count: 55,
    },
    jsonLd: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Товар с JSON-LD, 10 мл',
      url: 'https://www.ozon.ru/product/fixture-900036/',
      sku: '900036',
      offers: { '@type': 'Offer', price: '777.00', priceCurrency: 'RUB' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.2', reviewCount: '55' },
    }),
  },
];

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function expectedTitleOf(fixture: CardFixture): string | null {
  const titleMatch = /<span class="tsBody500Medium">([\s\S]*?)<\/span>/u.exec(fixture.html);
  if (titleMatch) {
    const title = normalizeText(decodeEntities(titleMatch[1] ?? ''));
    return title || null;
  }
  const altMatch = /<img[^>]*alt="([^"]*)"/u.exec(fixture.html);
  if (altMatch) {
    const alt = normalizeText(decodeEntities(altMatch[1] ?? ''));
    return alt || null;
  }
  return null;
}

// Fill in the mechanical expectations shared by all generated fixture cards.
for (const fixture of CARD_FIXTURES) {
  const number = Number(fixture.id.slice(1));
  const productId = fixture.id === 'c19' ? null : String(900000 + number);
  if (fixture.expected.product_id === undefined) fixture.expected.product_id = productId;
  if (fixture.expected.url === undefined) {
    fixture.expected.url = productId
      ? `https://www.ozon.ru/product/fixture-${productId}/`
      : 'https://www.ozon.ru/product/no-digits/';
  }
  if (fixture.expected.price === undefined) {
    if (fixture.nullFields?.includes('price')) fixture.expected.price = null;
    else if (!['c11', 'c33', 'c36'].includes(fixture.id)) fixture.expected.price = 350;
  }
  if (fixture.expected.title === undefined) {
    fixture.expected.title = expectedTitleOf(fixture);
  }
}


