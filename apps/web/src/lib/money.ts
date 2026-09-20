/**
 * Money formatting from integer cents — display only, integer math all the
 * way (no floats, no toFixed).
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

/** Integer cents -> decimal-dollar string for form defaults (no floats). */
export function centsToDollarString(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const remainder = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${dollars}.${String(remainder).padStart(2, "0")}`;
}
