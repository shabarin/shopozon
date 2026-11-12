# Форматы экспорта CSV и JSON

Экспорт выполняется полностью в браузере. Файлы скачиваются через `Blob` + `<a download>`,
без обращения к внешним серверам.

## Общие правила

- Кодировка CSV: UTF-8 с BOM (`\uFEFF`), перевод строки CRLF (`\r\n`).
- Одна строка CSV = один товар (products) или одно наблюдение (observations).
- Значения `null` экспортируются пустой строкой; это не то же самое, что `0` или `""`.
  Для точного различения используйте JSON, где `null` сохраняется явно.
- Массивы в CSV склеиваются через `;` (`sess-1;sess-2`, `url;title;price`).
- `other_prices` в CSV — компактный JSON-массив, при необходимости экранированный кавычками.
- Цены — числа с точкой в качестве десятичного разделителя, без символов валюты.
- URL — полный, без сокращения.
- Имена файлов:
  - `ozon-products-YYYY-MM-DD.csv`
  - `ozon-observations-YYYY-MM-DD.csv`
  - `ozon-data-YYYY-MM-DD.json`
  - для одной сессии: `ozon-session-...`

Область экспорта: `all` (все данные) или `session` (одна сессия, выбранная в popup).

## CSV товаров

Заголовки (фиксированный порядок):

| Колонка | Тип | Описание |
| --- | --- | --- |
| `product_id` | строка / пусто | Числовой id Ozon |
| `url` | URL / пусто | Прямая ссылка на товар |
| `title` | строка / пусто | Полное название |
| `price` | число / пусто | Основная цена |
| `currency` | строка / пусто | `RUB`, `KZT`, `BYN`, `USD`, `EUR` |
| `original_price` | число / пусто | Зачёркнутая цена |
| `discount` | число / пусто | Скидка в процентах, только если показана явно |
| `discount_text` | строка / пусто | Исходная надпись скидки (`-38%`, `Скидка 20%`) |
| `volume` | число / пусто | Объём или вес |
| `volume_unit` | `ml`/`l`/`g`/`kg` / пусто | Единица объёма |
| `quantity` | число / пусто | Количество единиц в упаковке |
| `seller` | строка / пусто | Продавец |
| `rating` | число 0–5 / пусто | Рейтинг |
| `review_count` | целое / пусто | Число отзывов или оценок |
| `availability` | `in_stock`/`out_of_stock` / пусто | Наличие |
| `availability_text` | строка / пусто | Исходная надпись о наличии |
| `price_type` | `regular`/`ozon_card`/`subscription`/`unknown` | Тип основной цены |
| `price_conditions` | строка / пусто | Условия основной цены |
| `ozon_card_price` | число / пусто | Цена с Ozon Картой |
| `subscription_price` | число / пусто | Цена по подписке |
| `other_prices` | JSON / пусто | Прочие цены: `[{"type","amount","currency","conditions"}]` |
| `first_seen_at` | ISO 8601 | Первое обнаружение товара |
| `last_seen_at` | ISO 8601 | Время последней записи товара в хранилище |
| `collected_at` | ISO 8601 | Время последнего обнаружения карточки, данные которого попали в запись |
| `source_url` | URL | Страница выдачи, где товар увидели последний раз |
| `search_query` | строка / пусто | Поисковый запрос из URL, если определён |
| `observation_count` | целое | Сколько раз товар наблюдался |
| `session_ids` | список через `;` | Сессии, в которых встречался товар |
| `extraction_status` | `success`/`partial`/`failed` | Качество последнего извлечения |
| `extracted_fields` | список через `;` | Успешно извлечённые поля |
| `missing_fields` | список через `;` | Поля, отсутствующие на карточке |
| `failed_fields` | список через `;` | Поля есть, но не распознаны |
| `fallback_fields` | список через `;` | Поля, взятые из JSON-LD |
| `extraction_errors` | список через `;` | Диагностические сообщения |
| `extraction_version` | строка | Версия логики извлечения |

Пример строки (упрощённо):

```csv
123456,https://www.ozon.ru/product/krem-123456/,Крем "Увлажняющий" 100 мл,1234.5,RUB,2000,38,-38%,100,ml,1,ООО Ромашка,4.8,1234,in_stock,В наличии,regular,,1199,,,2026-01-01T00:00:00.000Z,...
```

## CSV наблюдений

Заголовки:

```text
observation_id,session_id,product_key,product_id,url,title,price,currency,original_price,discount,
discount_text,volume,volume_unit,quantity,seller,rating,review_count,availability,availability_text,
price_type,price_conditions,ozon_card_price,subscription_price,other_prices,collected_at,source_url,
search_query,extraction_status,extracted_fields,missing_fields,failed_fields,fallback_fields,
extraction_errors,extraction_version
```

(В файле это одна строка без переносов; здесь разбито для читаемости.)

Каждое обнаружение карточки создаёт отдельную строку. Если товар встретился в трёх сессиях,
в CSV товаров будет одна строка с `observation_count = 3`, а в CSV наблюдений — три строки.
Наблюдение хранит снимок на момент обнаружения, включая `null`. Это позволяет анализировать
изменение цен и появление/исчезновение полей.

- `product_key` — внутренний ключ записи (`p:<hash>`); стабилен в пределах браузера и служит
  связью между CSV товаров и наблюдений.
- `observation_id` — уникальный id наблюдения.
- Остальные поля совпадают по смыслу с CSV товаров.

## JSON

JSON — полный bundle без потери типов. Верхний уровень:

```json
{
  "schema_version": 1,
  "exported_at": "2026-11-11T12:00:00.000Z",
  "scope": "all",
  "session": null,
  "sessions": [],
  "products": [],
  "observations": [],
  "stats": {
    "products": 0,
    "observations": 0,
    "sessions": 0,
    "total_products_in_store": 0
  }
}
```

- `scope = "session"` → `session` содержит полную запись выбранной сессии, `sessions` — массив
  из одного summary, `products` — только товары этой сессии, `observations` — только её
  наблюдения.
- `scope = "all"` → `session = null`, `sessions` — все сессии (новые первыми), `products` —
  все товары, `observations` — все наблюдения.
- `stats.total_products_in_store` — фактическое число товаров в локальной базе (может быть
  больше, чем товаров в выбранной сессии).

### Product

```json
{
  "key": "p:1a2b3c4d5e6f7890",
  "dedupe_key": "id:123456",
  "product_id": "123456",
  "url": "https://www.ozon.ru/product/krem-123456/",
  "title": "Крем «Увлажняющий», 100 мл",
  "price": 1234.5,
  "currency": "RUB",
  "original_price": 2000,
  "discount": 38,
  "discount_text": "-38%",
  "volume": 100,
  "volume_unit": "ml",
  "quantity": 1,
  "seller": "ООО Ромашка",
  "rating": 4.8,
  "review_count": 1234,
  "availability": "in_stock",
  "availability_text": "В наличии",
  "price_type": "regular",
  "price_conditions": null,
  "prices": {
    "main": {"type": "main", "amount": 1234.5, "currency": "RUB", "raw_text": "1 234,50 ₽", "conditions": null},
    "original": {"type": "original", "amount": 2000, "currency": "RUB", "raw_text": "2 000 ₽", "conditions": null},
    "ozon_card": {"type": "ozon_card", "amount": 1199, "currency": "RUB", "raw_text": "1 199 ₽", "conditions": "Ozon Карта"},
    "subscription": null,
    "other": []
  },
  "first_seen_at": "2026-11-11T12:00:00.000Z",
  "last_seen_at": "2026-11-11T12:00:05.000Z",
  "collected_at": "2026-11-11T12:00:05.000Z",
  "observation_count": 1,
  "session_ids": ["sess-..."],
  "source_url": "https://www.ozon.ru/search/?text=крем",
  "source_urls": ["https://www.ozon.ru/search/?text=крем"],
  "search_query": "крем",
  "extraction": {
    "status": "success",
    "extracted_fields": ["product_id", "url", "title", "price"],
    "missing_fields": ["seller"],
    "failed_fields": [],
    "errors": [],
    "fallback_fields": [],
    "extraction_version": "1.0.0-dom.1"
  },
  "field_states": {
    "product_id": "extracted",
    "url": "extracted",
    "title": "extracted",
    "price": "extracted",
    "currency": "extracted",
    "original_price": "absent",
    "discount": "absent",
    "volume": "extracted",
    "quantity": "extracted",
    "seller": "absent",
    "rating": "absent",
    "review_count": "absent",
    "availability": "absent"
  }
}
```

Политика обновления: новое непустое значение заменяет старое; `null` никогда не стирает уже
известное значение. `observation_count` увеличивается при каждом обнаружении. `first_seen_at`
не меняется, `last_seen_at` отражает последнюю запись, а `collected_at` — время обнаружения карточки,
на основе которого собрано текущее состояние.

### Observation

Содержит `observation_id`, `session_id`, `product_key`, все поля товара на момент обнаружения,
`collected_at`, `source_url`, `search_query`, `extraction`, `field_states` и `prices`.
Отличия от Product: нет `first_seen_at`, `last_seen_at`, `observation_count`, `session_ids`,
`source_urls`; значения могут быть `null`, если на момент наблюдения поле отсутствовало.

### Session

```json
{
  "session_id": "sess-...",
  "started_at": "2026-11-11T12:00:00.000Z",
  "finished_at": "2026-11-11T12:10:00.000Z",
  "initial_url": "https://www.ozon.ru/search/?text=крем",
  "search_query": "крем",
  "cards_discovered": 120,
  "unique_products": 98,
  "errors": 2,
  "partial": 5,
  "success": 115,
  "observation_count": 120,
  "status": "stopped",
  "extraction_versions": ["1.0.0-dom.1"],
  "product_keys": ["p:..."],
  "observation_chunks": 2,
  "note": null
}
```

`status`:

- `active` — сбор идёт;
- `stopped` — пользователь остановил сбор;
- `interrupted` — браузер был перезапущен; сбор не возобновлялся автоматически.

`cards_discovered` учитывает только новые обнаружения, а не повторные проверки/обновления
(`is_update`), поэтому счётчик не растёт от повторного сканирования тех же DOM-узлов.

## Семантика качества

- `success` — есть URL, название и цена.
- `partial` — есть URL и хотя бы одно из названия/цены.
- `failed` — нет даже пары «URL + (название или цена)».

Состояния полей:

- `extracted` — значение получено и сохранено;
- `absent` — поля нет на карточке;
- `failed` — поле видно, но разобрать не удалось (например, «Цена по запросу»).

JSON-LD используется только для полей, отсутствующих на видимой карточке; такие поля попадают
в `fallback_fields` и `extraction_errors` (`price:from_jsonld_fallback`).

## Совместимость

`schema_version = 1`. При изменении структуры записей увеличьте `SCHEMA_VERSION` в
`src/shared/constants.ts` и опишите миграцию. Имена полей и CSV-заголовков английские и
стабильные; пользовательские подписи в popup — русские.

## Проверка CSV в Excel

CSV содержит BOM и CRLF, поэтому Excel корректно открывает кириллицу двойным щелчком.
Если Excel всё же использует неверную кодировку: «Данные → Из текста/CSV» → UTF-8.
