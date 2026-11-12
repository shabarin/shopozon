import type { Availability } from '../shared/types.ts';

export interface ParsedAvailability {
  availability: Availability;
  text: string | null;
}

const OUT_OF_STOCK = [
  /нет\s+в\s+наличии/iu,
  /товар\s+закончился/iu,
  /закончился/iu,
  /распродано/iu,
  /нет\s+в\s+продаже/iu,
  /товар\s+недоступен/iu,
  /недоступен\s+для\s+заказа/iu,
];

const IN_STOCK = [
  /осталось\s+(?:мало|\d+)/iu,
  /в\s+наличии/iu,
  /можно\s+купить/iu,
  /готов[а-яё]*\s+к\s+отправке/iu,
];

export function parseAvailability(cardText: string | null | undefined): ParsedAvailability {
  const source = String(cardText ?? '');
  for (const pattern of OUT_OF_STOCK) {
    const match = pattern.exec(source);
    if (match) return { availability: 'out_of_stock', text: match[0].trim() };
  }
  for (const pattern of IN_STOCK) {
    const match = pattern.exec(source);
    if (match) return { availability: 'in_stock', text: match[0].trim() };
  }
  return { availability: null, text: null };
}
