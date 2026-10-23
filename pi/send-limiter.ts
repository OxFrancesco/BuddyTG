import { setTimeout } from "node:timers/promises"

export interface SendClock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const clock: SendClock = {
  now: () => performance.now(),
  sleep: async (ms, signal) => { await setTimeout(ms, undefined, { signal }) },
}

function positiveInteger(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = process.env[name]?.trim()
  if (value === undefined) return fallback
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum)
    throw new Error(`${name} must be a positive integer no greater than ${maximum}; 0 does not disable the limit. Nothing sent.`)
  return Number(value)
}

export function createSendLimiter(time: SendClock = clock) {
  let tail: Promise<unknown> = Promise.resolve()
  let attempts = 0
  let lastStart: number | undefined
  return function limitedSend<T>(send: () => Promise<T>, signal?: AbortSignal, validate?: () => Promise<void>): Promise<T> {
    const pending = tail.then(async () => {
      signal?.throwIfAborted()
      const cooldown = positiveInteger("BUDDYTG_SEND_COOLDOWN_MS", 3_000, 2_147_483_647)
      const cap = positiveInteger("BUDDYTG_SEND_SESSION_CAP", 30)
      if (attempts >= cap) throw new Error(`BuddyTG session send cap (${cap}) reached. Nothing sent.`)
      while (lastStart !== undefined) {
        const remaining = lastStart + cooldown - time.now()
        if (remaining <= 0) break
        await time.sleep(remaining, signal)
        signal?.throwIfAborted()
      }
      await validate?.()
      signal?.throwIfAborted()
      attempts++
      lastStart = time.now()
      return send()
    })
    tail = pending.catch(() => {})
    return pending
  }
}
