export function normalizeEmail(email: string): string {
  // Normalize before validation/storage so compatibility characters cannot
  // produce visually identical but byte-distinct account identifiers.
  return email.normalize("NFKC").trim().toLowerCase();
}
