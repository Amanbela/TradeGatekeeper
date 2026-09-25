import axios from 'axios';
import moment from 'moment-timezone';
import { OHLCV } from '../types';
import { getCachedSession, loginSmartApi } from '../config/smartApi';
import { CandleManager } from '../engine/candleManager';

/**
 * Generate synthetic fallback OHLCV candles when SmartAPI is offline or in mock/dev mode.
 */
function generateMockCandles(symbol: string, daysBack = 5): OHLCV[] {
  console.log(`[HistoryBootstrap] Generating synthetic 5M OHLCV historical candles for ${symbol}...`);
  const candles: OHLCV[] = [];
  let basePrice = 24500;
  const now = Date.now();
  const fiveDaysMs = daysBack * 24 * 60 * 60 * 1000;
  const startTime = Math.floor((now - fiveDaysMs) / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const fiveMinMs = 5 * 60 * 1000;

  let currentTs = startTime;
  while (currentTs < now) {
    const timeIST = moment(currentTs).tz('Asia/Kolkata');
    const hours = timeIST.hours();
    const minutes = timeIST.minutes();
    const timeInMins = hours * 60 + minutes;

    // Only generate during NSE market hours: 09:15 to 15:30 IST, skipping weekends
    const dayOfWeek = timeIST.day();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && timeInMins >= 9 * 60 + 15 && timeInMins <= 15 * 60 + 30) {
      const changePercent = (Math.random() - 0.49) * 0.003;
      const open = basePrice;
      const close = basePrice * (1 + changePercent);
      const high = Math.max(open, close) + Math.random() * 8.0;
      const low = Math.min(open, close) - Math.random() * 8.0;
      const volume = Math.floor(Math.random() * 5000) + 1000;

      candles.push({
        timestamp: currentTs,
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume,
      });

      basePrice = close;
    }
    currentTs += fiveMinMs;
  }

  return candles;
}

/**
 * Historical Data Bootstrap Service
 * Warmup historical 5-minute OHLCV data directly from Angel One SmartAPI REST on startup.
 */
export async function bootstrapHistoricalCandles(
  symbol: string = 'NIFTY',
  token: string = '26000'
): Promise<OHLCV[]> {
  console.log(`[HistoryBootstrap] Bootstrapping historical OHLCV data for ${symbol} (Token: ${token})...`);

  let session = getCachedSession();
  if (!session) {
    try {
      session = await loginSmartApi();
    } catch (err: any) {
      console.error('[HistoryBootstrap] Unable to authenticate SmartAPI session:', err.message);
    }
  }

  // Use fallback generator if session is mock/fallback or unavailable
  if (!session || session.jwtToken.startsWith('mock') || session.jwtToken.startsWith('fallback')) {
    console.log('[HistoryBootstrap] Using mock historical candles generator for testing/dev environment.');
    const mockCandles = generateMockCandles(symbol, 5);
    CandleManager.loadHistoricalCandles(symbol, mockCandles);
    console.log(`[HistoryBootstrap] Successfully seeded ${mockCandles.length} mock 5M candles for ${symbol}.`);
    return mockCandles;
  }

  const apiKey = process.env.SMARTAPI_API_KEY || '';
  const toDate = moment().tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm');
  const fromDate = moment().tz('Asia/Kolkata').subtract(5, 'days').format('YYYY-MM-DD 09:15');

  try {
    // Nifty 50 Spot uses 26000 on WebSocket, but 99926000 on SmartAPI Historical REST API
    const restToken = (token === '26000' || symbol.toUpperCase() === 'NIFTY') ? '99926000' : token;

    const url = 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData';
    const requestBody = {
      exchange: 'NSE',
      symboltoken: restToken,
      interval: 'FIVE_MINUTE',
      fromdate: fromDate,
      todate: toDate,
    };

    console.log(`[HistoryBootstrap] Fetching REST candles from SmartAPI: ${fromDate} to ${toDate}`);

    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${session.jwtToken}`,
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'MAC_ADDRESS',
        'X-PrivateKey': apiKey,
      },
      timeout: 10000,
    });

    if (
      response.data &&
      response.data.status &&
      Array.isArray(response.data.data) &&
      response.data.data.length > 0
    ) {
      const parsedCandles: OHLCV[] = response.data.data.map((row: any[]) => {
        const timestampStr = row[0];
        const timestamp = new Date(timestampStr).getTime() || moment(timestampStr).valueOf();
        return {
          timestamp,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] || 0),
        };
      });

      console.log(`[HistoryBootstrap] Received ${parsedCandles.length} candles from Angel One REST API.`);
      CandleManager.loadHistoricalCandles(symbol, parsedCandles);
      return parsedCandles;
    } else {
      console.warn(`[HistoryBootstrap] SmartAPI REST returned empty candle array. Status: ${response.data?.status}, Message: ${response.data?.message}`);
      const mockCandles = generateMockCandles(symbol, 5);
      CandleManager.loadHistoricalCandles(symbol, mockCandles);
      return mockCandles;
    }
  } catch (error: any) {
    console.error('[HistoryBootstrap] Exception during historical candle fetch:', error.response?.data || error.message);
    console.log('[HistoryBootstrap] Falling back to synthetic candles so quantitative engine remains online.');
    const mockCandles = generateMockCandles(symbol, 5);
    CandleManager.loadHistoricalCandles(symbol, mockCandles);
    return mockCandles;
  }
}
