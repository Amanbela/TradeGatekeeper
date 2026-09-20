import moment from 'moment-timezone';
import { RMSCheckResult } from '../types';
import { isDailyTradeLocked, isKillSwitchActive } from '../config/redis';
import { getCandleManager } from '../engine/candleManager';

export class RMSService {
  // Pre-configured RBI Policy & Key Event dates (YYYY-MM-DD in IST)
  private static eventBlacklistDates: Set<string> = new Set([
    '2026-02-06', // RBI Policy
    '2026-04-08', // RBI Policy
    '2026-06-05', // RBI Policy
    '2026-08-07', // RBI Policy
    '2026-10-09', // RBI Policy
    '2026-12-04', // RBI Policy
  ]);

  /**
   * Adds an event date (e.g., results day or macroeconomic event) to the blacklist.
   */
  public static addBlacklistEventDate(dateStr: string): void {
    this.eventBlacklistDates.add(dateStr);
  }

  /**
   * Evaluates all RMS rules before executing a trade.
   */
  public static async evaluateRMS(symbol: string): Promise<RMSCheckResult> {
    // 0a. Emergency Manual Kill Switch Check
    const manualKillSwitch = await isKillSwitchActive();
    if (manualKillSwitch) {
      return {
        allowed: false,
        reason: 'MANUAL_KILL_SWITCH_ACTIVE: Emergency manual kill switch is ON',
      };
    }

    // 0b. WebSocket Stale Data Kill Switch Check (>30 seconds without ticks)
    const candleMgr = getCandleManager(symbol);
    if (!candleMgr.isTickFeedFresh(30000)) {
      const lastTick = candleMgr.getLastTickTimestamp();
      const elapsedSec = lastTick > 0 ? ((Date.now() - lastTick) / 1000).toFixed(1) : 'infinity';
      return {
        allowed: false,
        reason: `STALE_DATA_KILL_SWITCH: No WebSocket ticks received for ${elapsedSec} seconds`,
      };
    }

    const nowIST = moment().tz('Asia/Kolkata');
    const dateStr = nowIST.format('YYYY-MM-DD');

    // Rule 1: Event-Day Blacklist Check
    if (this.eventBlacklistDates.has(dateStr)) {
      return {
        allowed: false,
        reason: `EVENT_DAY_BLACKLISTED: Scheduled event/RBI policy on ${dateStr}`,
      };
    }

    // Rule 2: Momentum Windows (09:30 AM - 11:15 AM IST and 01:30 PM - 02:45 PM IST)
    const currentMinutes = nowIST.hours() * 60 + nowIST.minutes();

    const morningStart = 9 * 60 + 30; // 09:30 AM = 570 mins
    const morningEnd = 11 * 60 + 15; // 11:15 AM = 675 mins
    const afternoonStart = 13 * 60 + 30; // 01:30 PM = 810 mins
    const afternoonEnd = 14 * 60 + 45; // 02:45 PM = 885 mins

    const isInMorningWindow = currentMinutes >= morningStart && currentMinutes <= morningEnd;
    const isInAfternoonWindow = currentMinutes >= afternoonStart && currentMinutes <= afternoonEnd;

    if (!isInMorningWindow && !isInAfternoonWindow) {
      if (process.env.FORCE_RMS_BYPASS !== 'true') {
        return {
          allowed: false,
          reason: `OUTSIDE_MOMENTUM_WINDOW: Current time ${nowIST.format('HH:mm')} IST is outside active trading windows`,
        };
      }
    }

    // Rule 3: Strict Capital Protection (1 Trade Per Day IST)
    const alreadyTradedToday = await isDailyTradeLocked();
    if (alreadyTradedToday) {
      if (process.env.FORCE_RMS_BYPASS !== 'true') {
        return {
          allowed: false,
          reason: 'DAILY_LIMIT_EXCEEDED: Exactly one trade per day allowed',
        };
      }
    }

    return { allowed: true };
  }
}
