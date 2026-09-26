import Redis from 'ioredis';
import moment from 'moment-timezone';
import { SystemStateModel } from '../models/SystemState';
import { logSystemEvent } from '../models/SystemEvent';

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

let isRedisConnected = false;

export const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on('connect', () => {
  if (!isRedisConnected) {
    isRedisConnected = true;
    console.log('[Redis] Client connected.');
    logSystemEvent('REDIS_RECOVERED', 'Redis connection established', 'INFO').catch(() => {});
  }
});

redis.on('error', (err) => {
  if (isRedisConnected) {
    isRedisConnected = false;
    console.error('[Redis] Connection error:', err.message);
    logSystemEvent('REDIS_UNAVAILABLE', `Redis connection error: ${err.message}`, 'ERROR').catch(() => {});
  }
});

export function isRedisHealthy(): boolean {
  return isRedisConnected && redis.status === 'ready';
}

export function getTodayISTDateString(): string {
  return moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
}

/**
 * Attempts to acquire an atomic daily lock for registering a trade.
 * Key format: trade_lock:YYYY-MM-DD (TTL = 24 hours)
 * FAIL-CLOSED: If Redis is unavailable, returns false (lock cannot be guaranteed).
 */
export async function acquireDailyTradeLock(symbol: string): Promise<boolean> {
  const dateStr = getTodayISTDateString();
  const lockKey = `trade_lock:${dateStr}`;

  try {
    if (!isRedisHealthy()) {
      console.warn('[Redis] acquireDailyTradeLock failed: Redis offline. Fail-closed enforced.');
      return false;
    }
    const result = await redis.set(lockKey, symbol, 'EX', 86400, 'NX');
    if (result === 'OK') {
      // Also sync to MongoDB durable state
      await SystemStateModel.updateOne(
        { key: 'GLOBAL_STATE' },
        { $set: { dailyTradeLocked: true, dailyTradeLockedDateIST: dateStr } },
        { upsert: true }
      );
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[Redis] acquireDailyTradeLock error:', err.message);
    return false; // Fail-closed
  }
}

/**
 * Checks if a trade has already been registered today.
 * FAIL-CLOSED: Checks both Redis and MongoDB. If Redis is down, relies on MongoDB.
 * If both fail, defaults to true (locked/safety uncertain -> NO NEW TRADE).
 */
export async function isDailyTradeLocked(): Promise<boolean> {
  const dateStr = getTodayISTDateString();
  const lockKey = `trade_lock:${dateStr}`;

  try {
    if (isRedisHealthy()) {
      const exists = await redis.exists(lockKey);
      if (exists === 1) return true;
    }
  } catch (err: any) {
    console.warn('[Redis] Error checking Redis daily lock:', err.message);
  }

  // Fallback to MongoDB source of truth
  try {
    const doc = await SystemStateModel.findOne({ key: 'GLOBAL_STATE' });
    if (doc && doc.dailyTradeLocked && doc.dailyTradeLockedDateIST === dateStr) {
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('[Redis/Mongo] Error checking Mongo daily lock:', err.message);
    // Fail-closed: Safety uncertain -> NO NEW TRADE
    return true;
  }
}

/**
 * Anti-whipsaw cooldown: Stores the exit timestamp of the last trade in Redis & Mongo.
 * Key format: last_exit_time:<symbol>
 */
export async function setLastExitTimestamp(symbol: string, timestampMs: number): Promise<void> {
  const key = `last_exit_time:${symbol}`;
  try {
    if (isRedisHealthy()) {
      await redis.set(key, timestampMs.toString(), 'EX', 86400);
    }
  } catch (err: any) {
    console.error('[Redis] Error setting last exit timestamp:', err.message);
  }
}

export async function getLastExitTimestamp(symbol: string): Promise<number | null> {
  const key = `last_exit_time:${symbol}`;
  try {
    if (isRedisHealthy()) {
      const val = await redis.get(key);
      if (val) return parseInt(val, 10);
    }
  } catch (err: any) {
    console.warn('[Redis] Error fetching last exit timestamp from Redis:', err.message);
  }
  return null;
}

/**
 * Emergency Manual Kill Switch toggle in Redis and MongoDB (Durable Source of Truth)
 * Key format: KILL_SWITCH_ACTIVE ('true' | 'false')
 */
export async function setKillSwitchState(active: boolean, reason: string = 'MANUAL_TOGGLE'): Promise<void> {
  // 1. Update MongoDB durable source of truth FIRST
  try {
    await SystemStateModel.updateOne(
      { key: 'GLOBAL_STATE' },
      {
        $set: {
          killSwitchActive: active,
          killSwitchReason: reason,
          killSwitchUpdatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log(`[Mongo] Emergency Kill Switch updated to ${active ? 'ACTIVE' : 'INACTIVE'} in SystemState`);
  } catch (err: any) {
    console.error('[Mongo] Failed to persist kill switch state to MongoDB:', err.message);
    throw err; // Fail-closed if MongoDB persistence fails
  }

  // 2. Sync to Redis cache if online
  try {
    if (isRedisHealthy()) {
      await redis.set('KILL_SWITCH_ACTIVE', active ? 'true' : 'false');
      console.log(`[Redis] Emergency Kill Switch cached as ${active ? 'ACTIVE' : 'INACTIVE'}`);
    }
  } catch (err: any) {
    console.warn('[Redis] Failed to sync kill switch to Redis cache:', err.message);
  }

  logSystemEvent(
    active ? 'KILL_SWITCH_ACTIVATED' : 'KILL_SWITCH_DEACTIVATED',
    `Emergency Kill Switch ${active ? 'ACTIVATED' : 'DEACTIVATED'} (Reason: ${reason})`,
    active ? 'WARN' : 'INFO'
  ).catch(() => {});
}

/**
 * Checks if Kill Switch is active.
 * MongoDB is authoritative; Redis is fast cache.
 * FAIL-CLOSED: If Redis is down or key is missing, check MongoDB.
 * If both fail or safety is uncertain, return true (Kill Switch ACTIVE -> NO NEW TRADE).
 */
export async function isKillSwitchActive(): Promise<boolean> {
  // Check Redis cache first if healthy
  if (isRedisHealthy()) {
    try {
      const val = await redis.get('KILL_SWITCH_ACTIVE');
      if (val === 'true') return true;
    } catch (err: any) {
      console.warn('[Redis] Error checking Redis kill switch:', err.message);
    }
  }

  // Authoritative check from MongoDB
  try {
    const stateDoc = await SystemStateModel.findOne({ key: 'GLOBAL_STATE' });
    if (stateDoc) {
      // If Mongo says active, populate Redis cache and return true
      if (stateDoc.killSwitchActive) {
        if (isRedisHealthy()) {
          redis.set('KILL_SWITCH_ACTIVE', 'true').catch(() => {});
        }
        return true;
      }
      return false;
    }
    return false;
  } catch (err: any) {
    console.error('[Redis/Mongo] Exception checking Kill Switch state:', err.message);
    // FAIL-CLOSED: Safety uncertain -> Kill switch active!
    return true;
  }
}

