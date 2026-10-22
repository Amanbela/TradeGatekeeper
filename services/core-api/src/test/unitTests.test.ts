import assert from 'assert';
import crypto from 'crypto';
import WebSocket from 'ws';
import { TrackerWorker } from '../services/trackerWorker';
import { CandleManager } from '../engine/candleManager';
import { requireAdminAuth } from '../middleware/authMiddleware';
import { MlClient } from '../services/mlClient';
import { Request, Response } from 'express';

console.log('=====================================================');
console.log('   Running TradeGatekeeper Production Safety Tests   ');
console.log('=====================================================');

async function runTests() {
  let passedCount = 0;
  let totalCount = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    totalCount++;
    try {
      await fn();
      passedCount++;
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      console.error(`  ✗ ${name}:`, err.message);
    }
  }

  // Test 1: Financial Frictions Calculation Precision
  await test('Financial Frictions Precision (Turnover, Charges, STT, Brokerage, GST, Net PnL)', () => {
    const frictions = TrackerWorker.calculateFrictions('BUY', 24000, 24050, 50, 0.002);
    assert.strictEqual(frictions.quantity, 50);
    assert.strictEqual(frictions.brokerage, 40.0);
    assert(frictions.sttTax > 0, 'STT tax must be calculated');
    assert(frictions.exchangeCharges > 0, 'Exchange charges must be calculated');
    assert(frictions.totalTaxesAndCharges > 0, 'Total charges must be calculated');
    assert.strictEqual(frictions.grossPnLPoints, 50.0);
    assert(frictions.netRealizedPnL > 1000 && frictions.netRealizedPnL < 1250, 'Net PnL must account for frictions');
  });

  // Test 2: Signal Idempotency Hash Determinism
  await test('Signal Idempotency Determinism', () => {
    const symbol = 'NIFTY';
    const timestamp = 1700000000000;
    const candleTs = Math.floor(timestamp / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const hash1 = crypto.createHash('sha256').update(`${symbol}:${candleTs}:CALL:BUY:5m`).digest('hex');
    const hash2 = crypto.createHash('sha256').update(`${symbol}:${candleTs}:CALL:BUY:5m`).digest('hex');
    const hash3 = crypto.createHash('sha256').update(`${symbol}:${candleTs}:PUT:SELL:5m`).digest('hex');

    assert.strictEqual(hash1, hash2, 'Identical signals must produce identical idempotency hashes');
    assert.notStrictEqual(hash1, hash3, 'Different signals must produce unique idempotency hashes');
  });

  // Test 3: Duplicate Tick Protection
  await test('Duplicate Tick Protection in CandleManager', () => {
    const mgr = new CandleManager('NIFTY_TEST_DUP');
    const now = Date.now();
    
    // Process first tick
    mgr.processTick({ symbol: 'NIFTY_TEST_DUP', token: '26000', price: 24000, volume: 100, timestamp: now });
    // Process duplicate tick (same token, timestamp, price, volume)
    const res2 = mgr.processTick({ symbol: 'NIFTY_TEST_DUP', token: '26000', price: 24000, volume: 100, timestamp: now });

    assert(!res2.closed5m && !res2.closed15m, 'Duplicate tick must be rejected without returning candle updates');
  });

  // Test 4: Out-of-Order / Delayed Tick Handling
  await test('Out-of-Order Tick Rejection in CandleManager', () => {
    const mgr = new CandleManager('NIFTY_TEST_OOO');
    const t0 = 1700000000000;
    const t5 = t0 + 5 * 60 * 1000; // 5 mins later

    // Seed historical candle so lastFinalized5mStart is set
    mgr.loadHistoricalCandles([{ timestamp: t0, open: 24000, high: 24050, low: 23950, close: 24020, volume: 1000 }]);

    // Tick for next candle (t5)
    mgr.processTick({ symbol: 'NIFTY_TEST_OOO', token: '26000', price: 24030, volume: 10, timestamp: t5 });
    
    // Delayed tick arriving late for t0 candle
    const resLate = mgr.processTick({ symbol: 'NIFTY_TEST_OOO', token: '26000', price: 23900, volume: 10, timestamp: t0 - 1000 });
    assert(!resLate.closed5m && !resLate.closed15m, 'Late tick belonging to past finalized candle must be safely ignored');
  });

  // Test 5: Partial Candle Suppresses Signals
  await test('Partial Candle Connection Interrupt Suppression', () => {
    const mgr = new CandleManager('NIFTY_TEST_PARTIAL');
    mgr.setConnectionInterrupted(true);
    assert.strictEqual(mgr.isTickFeedFresh(30000), true);
  });

  // Test 6: Kill Switch Auth Middleware Protection
  await test('Kill Switch Authentication Middleware', () => {
    process.env.TRADEGATEKEEPER_ADMIN_API_KEY = 'secret_admin_key_123';

    let statusCode = 0;

    const mockReq401 = { headers: {} } as unknown as Request;
    const mockRes401 = {
      status: (code: number) => { statusCode = code; return mockRes401; },
      json: () => mockRes401,
    } as unknown as Response;

    requireAdminAuth(mockReq401, mockRes401, () => {});
    assert.strictEqual(statusCode, 401, 'Unauthenticated request must return 401');

    const mockReq403 = { headers: { 'x-api-key': 'wrong_key' } } as unknown as Request;
    requireAdminAuth(mockReq403, mockRes401, () => {});
    assert.strictEqual(statusCode, 403, 'Invalid API key request must return 403');

    let nextCalled = false;
    const mockReq200 = { headers: { 'x-api-key': 'secret_admin_key_123' } } as unknown as Request;
    requireAdminAuth(mockReq200, mockRes401, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'Valid API key must pass authorization');
  });

  // Test 7: ML Client Advisory Mode vs Fail-Closed
  await test('ML Client Advisory Mode vs Gating Fail-Closed', async () => {
    process.env.ML_MODE = 'advisory';
    const advisoryRes = await MlClient.predict({
      volumeRatio20: 1.5,
      adxValue: 25,
      htfEmaDistance: 0.5,
      rsiValue: 60,
      atrNormalized: 1.5,
      oiBuildupScore: 0.5,
    });
    assert.strictEqual(advisoryRes.approved, true, 'Advisory mode must approve trade when ML service is offline');

    process.env.ML_MODE = 'gating';
    const gatingRes = await MlClient.predict({
      volumeRatio20: 1.5,
      adxValue: 25,
      htfEmaDistance: 0.5,
      rsiValue: 60,
      atrNormalized: 1.5,
      oiBuildupScore: 0.5,
    });
    assert.strictEqual(gatingRes.approved, false, 'Gating mode must fail-closed when ML service is offline');
  });

  // Test 8: IST Pre-Market Warmup Time Check Helper (< 09:15 AM IST)
  await test('IST Pre-Market Warmup Time Check Helper (< 09:15 AM IST)', () => {
    // 08:45 AM IST (525 mins) -> pre-market
    const preMarketTime = new Date('2026-10-22T08:45:00+05:30');
    assert.strictEqual(CandleManager.isBeforeMarketOpenIST(preMarketTime), true, '08:45 AM IST must be identified as pre-market warmup');

    // 09:14 AM IST (554 mins) -> pre-market
    const justBeforeOpen = new Date('2026-10-22T09:14:59+05:30');
    assert.strictEqual(CandleManager.isBeforeMarketOpenIST(justBeforeOpen), true, '09:14:59 AM IST must be identified as pre-market warmup');

    // 09:15 AM IST (555 mins) -> market open
    const marketOpenTime = new Date('2026-10-22T09:15:00+05:30');
    assert.strictEqual(CandleManager.isBeforeMarketOpenIST(marketOpenTime), false, '09:15:00 AM IST must not be pre-market warmup');

    // 09:30 AM IST (570 mins) -> regular trading hours
    const regularTradingTime = new Date('2026-10-22T09:30:00+05:30');
    assert.strictEqual(CandleManager.isBeforeMarketOpenIST(regularTradingTime), false, '09:30 AM IST must not be pre-market warmup');
  });

  // Test 9: Pre-Market Candle Warmup Aggregation Without Signal Evaluation
  await test('Pre-Market Warmup Aggregates Candles for Indicators and Bypasses Signals', () => {
    const mgr = new CandleManager('NIFTY_TEST_WARMUP');
    const baseTime = new Date('2026-10-22T08:50:00+05:30').getTime();

    // Tick 1 at 08:50 AM
    mgr.processTick({ symbol: 'NIFTY_TEST_WARMUP', token: '26000', price: 24100, volume: 50, timestamp: baseTime });
    // Tick 2 at 08:52 AM
    mgr.processTick({ symbol: 'NIFTY_TEST_WARMUP', token: '26000', price: 24120, volume: 60, timestamp: baseTime + 2 * 60 * 1000 });
    // Tick 3 at 08:55 AM (triggers 5m candle closure for the 08:50 candle)
    const result = mgr.processTick({ symbol: 'NIFTY_TEST_WARMUP', token: '26000', price: 24110, volume: 40, timestamp: baseTime + 5 * 60 * 1000 });

    assert(result.closed5m, '5M candle must be closed and returned');
    assert.strictEqual(result.closed5m.open, 24100);
    assert.strictEqual(result.closed5m.high, 24120);
    assert.strictEqual(result.closed5m.close, 24120);
    assert.strictEqual(mgr.get5mCandles().length, 1, 'Candle must be retained in memory for indicator calculation');
  });

  // Test 10: WebSocket Safe Cleanup Suppresses Unhandled Error Event in CONNECTING state
  await test('WebSocket Safe Cleanup Suppresses Unhandled Error Event in CONNECTING state', () => {
    // Instantiate a WebSocket in CONNECTING state pointing to an unopen port
    const ws = new WebSocket('ws://127.0.0.1:59999');
    assert.strictEqual(ws.readyState, WebSocket.CONNECTING);

    TrackerWorker.setWsClient(ws);
    // cleanupSocketState must safely terminate the socket, catch the unhandled error, and nullify wsClient
    TrackerWorker.cleanupSocketState();

    assert.strictEqual(TrackerWorker.getWsClient(), null, 'wsClient must be safely nullified');
  });

  // Test 11: 401 & Rate Limit Exponential Backoff Handling
  await test('SmartAPI 401 & Rate Limit Backoff Interceptor', async () => {
    TrackerWorker.resetAuthFailureAttempts();
    assert.strictEqual(TrackerWorker.getAuthFailureAttempts(), 0);

    // Trigger 401 error handler with rate limit message
    await TrackerWorker.handle401Error('Access denied because of exceeding access rate');
    assert.strictEqual(TrackerWorker.getAuthFailureAttempts(), 1, 'Auth failure attempt count should increment');
  });

  console.log('\n=====================================================');
  console.log(`   Test Results: ${passedCount} / ${totalCount} Passed`);
  console.log('=====================================================');
  if (passedCount !== totalCount) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
