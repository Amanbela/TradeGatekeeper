import Redis from 'ioredis';
import moment from 'moment-timezone';

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

export const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  maxRetriesPerRequest: null,
});

redis.on('connect', () => {
  console.log('[Redis] Client connected.');
});

redis.on('error', (err) => {
  console.error('[Redis] Error:', err);
});

export function getTodayISTDateString(): string {
  return moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
}

/**
 * Attempts to acquire an atomic daily lock for registering a trade.
 * Key format: trade_lock:YYYY-MM-DD (TTL = 24 hours)
 */
export async function acquireDailyTradeLock(symbol: string): Promise<boolean> {
  const dateStr = getTodayISTDateString();
  const lockKey = `trade_lock:${dateStr}`;
  // SET NX with TTL of 86400 seconds (24 hours)
  const result = await redis.set(lockKey, symbol, 'EX', 86400, 'NX');
  return result === 'OK';
}

/**
 * Checks if a trade has already been registered today.
 */
export async function isDailyTradeLocked(): Promise<boolean> {
  const dateStr = getTodayISTDateString();
  const lockKey = `trade_lock:${dateStr}`;
  const exists = await redis.exists(lockKey);
  return exists === 1;
}

/**
 * Anti-whipsaw cooldown: Stores the exit timestamp of the last trade in Redis.
 * Key format: last_exit_time:<symbol>
 */
export async function setLastExitTimestamp(symbol: string, timestampMs: number): Promise<void> {
  const key = `last_exit_time:${symbol}`;
  await redis.set(key, timestampMs.toString(), 'EX', 86400);
}

export async function getLastExitTimestamp(symbol: string): Promise<number | null> {
  const key = `last_exit_time:${symbol}`;
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : null;
}

/**
 * Emergency Manual Kill Switch toggle in Redis
 * Key format: KILL_SWITCH_ACTIVE ('true' | 'false')
 */
export async function setKillSwitchState(active: boolean): Promise<void> {
  await redis.set('KILL_SWITCH_ACTIVE', active ? 'true' : 'false');
  console.log(`[Redis] Emergency Kill Switch set to ${active ? 'ACTIVE (TRUE)' : 'INACTIVE (FALSE)'}`);
}

export async function isKillSwitchActive(): Promise<boolean> {
  const val = await redis.get('KILL_SWITCH_ACTIVE');
  return val === 'true';
}
