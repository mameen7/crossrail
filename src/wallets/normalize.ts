/**
 * Contact normalization applied before persisting, so the unique constraints
 * on `wallets.email` and `wallets.phone` compare canonical forms:
 * `Foo@Example.com` and `foo@example.com` are one wallet, as are
 * `+234 800-000-0000` and `+2348000000000`.
 *
 * Surrounding whitespace is already gone by the time values get here: the
 * request DTO trims before validation, and nothing else trims.
 */

export function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s-]/g, '');
}
