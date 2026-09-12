/**
 * Server-owned timestamps for a record created on the public plane — a CRUD
 * POST, a signup, an OAuth first login. Spread last, so nothing a client sent
 * for them survives. The `_admin` plane never calls this.
 */
export function newTimestamps(): { createdAt: string; updatedAt: string } {
  const now = new Date().toISOString();
  return { createdAt: now, updatedAt: now };
}
