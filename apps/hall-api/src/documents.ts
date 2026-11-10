// Brazilian tax ids: CPF (11 digits) and CNPJ (14 characters; from July 2026 the first 12 may be
// letters or digits, the last two are check digits). Both check digits are mod 11 over the
// characters' values (digit value; a letter's ASCII code minus 48), as the Receita Federal defines.

export type DocumentType = 'cpf' | 'cnpj';

/** Upper case, without punctuation (. / - and spaces). */
export const normalizeDocument = (s: string) => s.toUpperCase().replace(/[.\-/\s]/g, '');

const value = (c: string) => c.charCodeAt(0) - 48;

function checkDigit(chars: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < chars.length; i++) sum += value(chars[i]!) * weights[i]!;
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

export function isValidCpf(s: string): boolean {
  if (!/^\d{11}$/.test(s) || /^(\d)\1{10}$/.test(s)) return false;
  const d1 = checkDigit(s.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigit(s.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(s[9]) && d2 === Number(s[10]);
}

export function isValidCnpj(s: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(s) || /^(\d)\1{13}$/.test(s)) return false;
  const d1 = checkDigit(s.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigit(s.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(s[12]) && d2 === Number(s[13]);
}

/** The type of a normalized document, when it is a valid CPF or CNPJ. */
export function documentTypeOf(normalized: string): DocumentType | undefined {
  if (normalized.length === 11 && isValidCpf(normalized)) return 'cpf';
  if (normalized.length === 14 && isValidCnpj(normalized)) return 'cnpj';
  return undefined;
}
