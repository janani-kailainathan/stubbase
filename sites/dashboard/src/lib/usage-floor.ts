import type { UsageResponse } from './api'

/**
 * The Usage panel's instant count for playground Sends.
 *
 * A request reaches the panel through two once-a-minute hops — the core
 * flushes its counters, then the panel polls — so a Send can take two minutes
 * to show. Rather than wait, the panel adds a counted Send the moment it
 * returns. Adding it once is not enough, though: a poll that lands before the
 * core's flush would bring back the old figure and the count would drop.
 *
 * So a Send raises a *floor* — what this tab knows has been sent — and every
 * fetch is shown as the larger of the server's figures and the floor. Once the
 * server has counted the Send its figures reach the floor and win, whatever
 * other traffic arrived meanwhile. A floor lapses after FLOOR_TTL_MS, so a
 * Send the core did not count after all can only ever overstate for a few
 * minutes, and a floor from last month never props up this month's figures.
 *
 * React-free so tests/playground.test.ts can import it.
 */

/** The core's flush and the panel's poll, a minute each, with margin. */
export const FLOOR_TTL_MS = 3 * 60_000

export interface UsageFloor {
  monthRequests: number
  monthBytes: number
  /** The account's pooled total — what the quota bar measures. */
  accountRequests: number
  /** UTC date of the Send, the day the core files it under. */
  day: string
  dayRequests: number
  dayBytes: number
  expiresAt: number
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)

/** A floor one counted request of `bytes` above what is on screen now. */
export function raiseFloor(shown: UsageResponse, bytes: number, now: number): UsageFloor {
  const day = utcDay(now)
  const today = shown.daily.find((d) => d.date === day)
  return {
    monthRequests: shown.month.requests + 1,
    monthBytes: shown.month.bytes + bytes,
    accountRequests: (shown.account?.requests ?? shown.month.requests) + 1,
    day,
    dayRequests: (today?.request_count ?? 0) + 1,
    dayBytes: (today?.bandwidth_bytes ?? 0) + bytes,
    expiresAt: now + FLOOR_TTL_MS,
  }
}

/** The server's figures, never shown below the floor while it holds. */
export function applyFloor(
  server: UsageResponse,
  floor: UsageFloor | undefined,
  now: number,
): UsageResponse {
  if (!floor || now >= floor.expiresAt) return server
  // The month turned since the Send: the server has started counting afresh.
  if (floor.day.slice(0, 7) !== utcDay(now).slice(0, 7)) return server

  const hasDay = server.daily.some((d) => d.date === floor.day)
  const daily = hasDay
    ? server.daily.map((d) =>
        d.date === floor.day
          ? {
              ...d,
              request_count: Math.max(d.request_count, floor.dayRequests),
              bandwidth_bytes: Math.max(d.bandwidth_bytes, floor.dayBytes),
            }
          : d,
      )
    : // Newest first, as the server orders them.
      [{ date: floor.day, request_count: floor.dayRequests, bandwidth_bytes: floor.dayBytes }, ...server.daily]

  return {
    ...server,
    month: {
      requests: Math.max(server.month.requests, floor.monthRequests),
      bytes: Math.max(server.month.bytes, floor.monthBytes),
    },
    account: { requests: Math.max(server.account?.requests ?? 0, floor.accountRequests) },
    daily,
  }
}
