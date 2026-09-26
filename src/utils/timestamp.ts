import { randomBytes } from "node:crypto";

/**
 * Generate a unique timestamp string with local time, milliseconds, and random suffix.
 * Format: YYYY-MM-DDTHH-MM-SS-mmm-rrrr
 * Where:
 *   - YYYY-MM-DD: local date
 *   - HH-MM-SS: local time
 *   - mmm: milliseconds (3 digits)
 *   - rrrr: 4 random hex characters
 * 
 * This ensures unique names even for back-to-back operations.
 */
export function makeUniqueTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const random = randomBytes(2).toString("hex"); // 4 hex chars
  return `${year}-${month}-${day}T${hour}-${minute}-${second}-${ms}-${random}`;
}
