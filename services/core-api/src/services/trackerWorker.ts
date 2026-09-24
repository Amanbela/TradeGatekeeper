import WebSocket from 'ws';
import moment from 'moment-timezone';
import { ActivePosition, FinancialFrictions, TickData, TradeAction } from '../types';
import { PaperTradeModel } from '../models/PaperTrade';
import { setLastExitTimestamp } from '../config/redis';
import { getCachedSession, invalidateSmartApiSession, loginSmartApi } from '../config/smartApi';
import { getCandleManager } from '../engine/candleManager';

export class TrackerWorker {
  private static activePositions: Map<string, ActivePosition> = new Map();
  private static wsClient: WebSocket | null = null;
  private static checkIntervalTimer: NodeJS.Timeout | null = null;

  // SmartStream v2 connection & heartbeat state
  private static pingInterval: NodeJS.Timeout | null = null;
  private static reconnectTimer: NodeJS.Timeout | null = null;
  private static reconnectAttempts = 0;
  private static readonly maxReconnectDelayMs = 30000;
  private static readonly baseReconnectDelayMs = 1000;
  private static isConnecting = false;

  // 401 Interceptor & Self-Healing Exponential Backoff state
  private static authFailureAttempts = 0;
  private static readonly maxAuthFailureAttempts = 5;
  private static isHandling401 = false;

  // Working-Days Market Session Lifecycle state (Asia/Kolkata timezone)
  private static isMarketSessionActive = false;
  private static lifecycleCheckTimer: NodeJS.Timeout | null = null;
  private static lastWarmupDate = '';
  private static lastShutdownDate = '';

  /**
   * Helper to compute realistic option trading frictions (slippage, STT, brokerage, exchange charges, GST)
   */
  public static calculateFrictions(
    action: TradeAction,
    grossEntryPrice: number,
    grossExitPrice: number,
    quantity: number = 50,
    slippagePercent: number = 0.002
  ): FinancialFrictions {
    // Delta proxy for index to option conversion (0.5 for ATM)
    const OPTION_DELTA = 0.5;

    // Spot point slippage should be ~1 to 2 spot points (which equals ~0.5 to 1.0 option pt)
    const spotSlippagePoints = 1.5;

    let netEntryPrice: number;
    let netExitPrice: number;

    if (action === 'BUY') {
      netEntryPrice = +(grossEntryPrice + spotSlippagePoints).toFixed(2);
      netExitPrice = +(grossExitPrice - spotSlippagePoints).toFixed(2);
    } else {
      netEntryPrice = +(grossEntryPrice - spotSlippagePoints).toFixed(2);
      netExitPrice = +(grossExitPrice + spotSlippagePoints).toFixed(2);
    }

    const estimatedPremium = Math.max(80, grossEntryPrice * 0.005);
    const optionLegTurnover = estimatedPremium * quantity; // e.g., 120 * 50 = ₹6,000
    const totalOptionTurnover = optionLegTurnover * 2;     // Round trip = ₹12,000

    const brokerage = 40.0; // ₹20 flat per order (round trip ₹40)
    const sttTax = +(optionLegTurnover * 0.001).toFixed(2); // 0.1% on sell turnover (~₹6)
    const stampDuty = +(optionLegTurnover * 0.00003).toFixed(2); // 0.003% on buy turnover (~₹0.18)
    const exchangeCharges = +(totalOptionTurnover * 0.0005).toFixed(2); // 0.05% of turnover (~₹6)
    const gst = +((brokerage + exchangeCharges) * 0.18).toFixed(2); // 18% on brokerage + exchange
    const totalTaxesAndCharges = +(brokerage + sttTax + stampDuty + exchangeCharges + gst).toFixed(2); // ~₹60

    const grossSpotPoints = action === 'BUY' ? grossExitPrice - grossEntryPrice : grossEntryPrice - grossExitPrice;
    const netSpotPoints = action === 'BUY' ? netExitPrice - netEntryPrice : netEntryPrice - netExitPrice;

    // Option points gained/lost = spot points * delta (0.5)
    const grossPnLAmount = +(grossSpotPoints * OPTION_DELTA * quantity).toFixed(2);
    const netPnLPoints = +(netSpotPoints * OPTION_DELTA).toFixed(2);
    const netRealizedPnL = +(netPnLPoints * quantity - totalTaxesAndCharges).toFixed(2);

    return {
      slippagePercent,
      grossEntryPrice,
      netEntryPrice,
      grossExitPrice,
      netExitPrice,
      quantity,
      grossPnLPoints: +grossSpotPoints.toFixed(2),
      grossPnLAmount,
      brokerage,
      sttTax,
      exchangeCharges,
      stampDuty,
      totalTaxesAndCharges,
      netRealizedPnL,
    };
  }

  /**
   * Initialize TrackerWorker and restore OPEN paper trades from MongoDB with exact elapsed durations
   */
  public static async init(): Promise<void> {
    console.log('[TrackerWorker] Initializing active trades tracker & state machine recovery...');
    try {
      const openTrades = await PaperTradeModel.find({
        $or: [{ status: 'OPEN' }, { state: { $in: ['POSITION_OPEN', 'ORDER_PLACED'] } }],
      });

      for (const trade of openTrades) {
        this.registerPosition({
          tradeId: trade.tradeId,
          symbol: trade.symbol,
          token: trade.token,
          action: trade.action,
          entryPrice: trade.entryPrice,
          grossEntryPrice: trade.grossEntryPrice || trade.entryPrice,
          targetPrice: trade.targetPrice,
          stopLossPrice: trade.stopLossPrice,
          entryTimestamp: trade.entryTimestamp.getTime(),
          maxHoldTimeMinutes: 35,
          featureVector: trade.features,
          quantity: trade.quantity || 50,
          selectedStrike: trade.selectedStrike || 'ATM',
        });
      }
      console.log(`[TrackerWorker] Restored ${openTrades.length} OPEN position(s) into RAM state machine.`);

      // Start periodic 35-minute Theta Decay Time-Stop checker (runs every 15 seconds)
      if (!this.checkIntervalTimer) {
        this.checkIntervalTimer = setInterval(() => {
          this.checkTimeStops();
        }, 15000);
      }
    } catch (err) {
      console.error('[TrackerWorker] Error initializing tracker:', err);
    }
  }

  /**
   * Registers a newly opened paper trade position in RAM
   */
  public static registerPosition(position: ActivePosition): void {
    this.activePositions.set(position.tradeId, position);
    console.log(
      `[TrackerWorker] Position Active [${position.selectedStrike}]: ${position.action} ${position.symbol} @ Gross: ${position.grossEntryPrice} (Net: ${position.entryPrice.toFixed(2)}) | TP1: ${position.targetPrice.toFixed(2)} | SL: ${position.stopLossPrice.toFixed(2)}`
    );
  }

  /**
   * Processes live tick updates against active paper positions and updates CandleManager tick timestamp
   */
  public static async onTick(tick: TickData): Promise<void> {
    // Update tick feed timestamp in CandleManager for stale data kill switch
    const candleMgr = getCandleManager(tick.symbol);
    candleMgr.processTick(tick);

    for (const [tradeId, pos] of this.activePositions.entries()) {
      if (pos.symbol === tick.symbol || pos.token === tick.token || (tick.token === '26000' && pos.symbol === 'NIFTY')) {
        const currentPrice = tick.price;

        if (pos.action === 'BUY') {
          // Target 1 Hit
          if (currentPrice >= pos.targetPrice) {
            await this.closePosition(tradeId, currentPrice, 'TARGET_HIT', 1);
            continue;
          }
          // Stop Loss Hit
          if (currentPrice <= pos.stopLossPrice) {
            await this.closePosition(tradeId, currentPrice, 'SL_HIT', 0);
            continue;
          }
        } else if (pos.action === 'SELL') {
          // Target 1 Hit
          if (currentPrice <= pos.targetPrice) {
            await this.closePosition(tradeId, currentPrice, 'TARGET_HIT', 1);
            continue;
          }
          // Stop Loss Hit
          if (currentPrice >= pos.stopLossPrice) {
            await this.closePosition(tradeId, currentPrice, 'SL_HIT', 0);
            continue;
          }
        }
      }
    }
  }

  /**
   * Periodic evaluation for Theta Decay Dynamic Time-Stop (35 Minutes Max Hold)
   */
  public static async checkTimeStops(): Promise<void> {
    const now = Date.now();
    const maxHoldMs = 35 * 60 * 1000; // 35 Minutes

    for (const [tradeId, pos] of this.activePositions.entries()) {
      const duration = now - pos.entryTimestamp;
      if (duration >= maxHoldMs) {
        console.log(`[TrackerWorker] Dynamic Time-Stop Triggered (35 mins elapsed) for trade ${tradeId}`);
        const exitPrice = pos.grossEntryPrice;
        await this.closePosition(tradeId, exitPrice, 'TIME_EXIT', 0);
      }
    }
  }

  /**
   * Closes a paper trade, applies financial frictions, updates state machine to POSITION_CLOSED, and persists to MongoDB
   */
  public static async closePosition(
    tradeId: string,
    grossExitPrice: number,
    reason: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'FORCE_EXIT',
    outcomeLabel: number
  ): Promise<void> {
    const pos = this.activePositions.get(tradeId);
    if (!pos) return;

    const frictions = this.calculateFrictions(
      pos.action,
      pos.grossEntryPrice,
      grossExitPrice,
      pos.quantity
    );

    console.log(
      `[TrackerWorker] Closing Trade ${tradeId} [${reason}] | Gross Exit: ${grossExitPrice} (Net Exit: ${frictions.netExitPrice.toFixed(2)}) | Net PnL: ₹${frictions.netRealizedPnL.toFixed(2)} (Charges: ₹${frictions.totalTaxesAndCharges.toFixed(2)})`
    );

    try {
      await PaperTradeModel.findOneAndUpdate(
        { tradeId },
        {
          state: 'POSITION_CLOSED',
          status: 'CLOSED',
          exitPrice: frictions.netExitPrice,
          grossExitPrice: frictions.grossExitPrice,
          netExitPrice: frictions.netExitPrice,
          exitTimestamp: new Date(),
          exitReason: reason,
          outcomeLabel,
          pnlPoints: frictions.netExitPrice - frictions.netEntryPrice,
          grossPnLPoints: frictions.grossPnLPoints,
          grossPnLAmount: frictions.grossPnLAmount,
          brokerage: frictions.brokerage,
          sttTax: frictions.sttTax,
          exchangeCharges: frictions.exchangeCharges,
          stampDuty: frictions.stampDuty,
          totalTaxesAndCharges: frictions.totalTaxesAndCharges,
          netRealizedPnL: frictions.netRealizedPnL,
          'stateTimestamps.exitTriggeredAt': new Date(),
          'stateTimestamps.positionClosedAt': new Date(),
        }
      );

      // Set anti-whipsaw cooldown in Redis (30 mins lockout)
      await setLastExitTimestamp(pos.symbol, Date.now());
    } catch (err) {
      console.error(`[TrackerWorker] Error saving closed trade ${tradeId} to MongoDB:`, err);
    } finally {
      this.activePositions.delete(tradeId);
    }
  }

  public static getActivePositions(): ActivePosition[] {
    return Array.from(this.activePositions.values());
  }

  /**
   * Helper to unpack SmartStream v2 binary buffer for Mode-1 (LTP)
   * Protocol layout (Little Endian):
   * Offset 0 (1 byte): Subscription Mode (1 = LTP)
   * Offset 1 (1 byte): Exchange Type (1 = NSE Cash)
   * Offset 2..27 (25 bytes): Token (null-padded UTF-8 string)
   * Offset 27..35 (8 bytes): Sequence Number (int64 LE)
   * Offset 35..43 (8 bytes): Exchange Timestamp (int64 LE)
   * Offset 43..51 (8 bytes): Last Traded Price (int64 LE / int32 LE, scaled by 100)
   */
  private static parseSmartStreamBinaryMessage(
    data: Buffer
  ): { token: string; ltp: number; exchangeType: number; timestamp: number } | null {
    try {
      if (data.length < 47) {
        return null;
      }

      const subscriptionMode = data.readUInt8(0);
      const exchangeType = data.readUInt8(1);

      // Extract 25-byte token (offsets 2 to 27)
      const token = data.toString('utf8', 2, 27).replace(/\0/g, '').trim();

      // Extract timestamp at offsets 35 to 43 if present
      let timestamp = Date.now();
      if (data.length >= 43) {
        try {
          const tsBig = data.readBigInt64LE(35);
          if (tsBig > 0n) {
            timestamp = Number(tsBig);
          }
        } catch {
          // Fallback if BigInt read fails
        }
      }

      // Extract LTP at offset 43 (scaled by 100 per Angel One SmartStream v2 specification)
      let rawLtp = 0;
      if (data.length >= 51) {
        try {
          rawLtp = Number(data.readBigInt64LE(43));
        } catch {
          rawLtp = data.readInt32LE(43);
        }
      } else if (data.length >= 47) {
        rawLtp = data.readInt32LE(43);
      }

      if (!token || rawLtp <= 0) {
        return null;
      }

      const ltp = rawLtp / 100.0;

      return {
        token,
        ltp,
        exchangeType,
        timestamp,
      };
    } catch (err: any) {
      console.error('[TrackerWorker] Binary frame parsing exception:', err.message);
      return null;
    }
  }

  /**
   * Process text/JSON control messages (pong, subscription ACKs)
   */
  private static handleTextMessage(messageStr: string): void {
    const trimmed = messageStr.trim();
    if (trimmed === 'pong' || trimmed === 'ping') {
      // Heartbeat acknowledgment from SmartStream server
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.status !== undefined || parsed.message || parsed.text) {
        console.log('[TrackerWorker] SmartAPI Control Message:', JSON.stringify(parsed));
      }

      // Handle fallback JSON tick format if transmitted in dev/mock environments
      if (parsed.token && (parsed.last_traded_price !== undefined || parsed.price !== undefined || parsed.ltp !== undefined)) {
        const rawPrice = parsed.last_traded_price ?? parsed.price ?? parsed.ltp;
        const price = rawPrice > 100000 ? rawPrice / 100 : rawPrice;
        const token = String(parsed.token);
        const symbol = parsed.symbol || (token === '26000' ? 'NIFTY' : token);

        const candleMgr = getCandleManager(symbol);
        candleMgr.onTickReceived(token, price, parsed.volume || 1);

        const tick: TickData = {
          symbol,
          token,
          price,
          volume: parsed.volume || 1,
          timestamp: parsed.timestamp || Date.now(),
        };
        this.onTick(tick);
      }
    } catch {
      // Non-JSON text message
      console.log('[TrackerWorker] SmartStream Text Message:', trimmed);
    }
  }

  /**
   * Self-healing 401 Unauthorized Interceptor with exponential backoff & max 5 retry threshold
   */
  private static async handle401Error(): Promise<void> {
    if (this.isHandling401) {
      return;
    }
    this.isHandling401 = true;
    this.isConnecting = false;
    this.cleanupSocketState();

    if (this.authFailureAttempts >= this.maxAuthFailureAttempts) {
      console.error(
        `[TrackerWorker] Max auth retry attempts (${this.maxAuthFailureAttempts}) reached due to persistent 401 Unauthorized errors. Halting auto-reconnect.`
      );
      this.isHandling401 = false;
      return;
    }

    this.authFailureAttempts++;
    console.log('[TrackerWorker] SmartAPI 401 Unauthorized detected. Invalidation and refreshing session credentials...');

    invalidateSmartApiSession();

    const delay = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, this.authFailureAttempts - 1),
      this.maxReconnectDelayMs
    );

    console.warn(
      `[TrackerWorker] Scheduling 401 self-healing reconnect in ${(delay / 1000).toFixed(1)}s (Attempt #${this.authFailureAttempts}/${this.maxAuthFailureAttempts})...`
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectTimer = setTimeout(async () => {
      try {
        await loginSmartApi(true);
        this.isHandling401 = false;
        await this.connectSmartApiWebSocket();
      } catch (err: any) {
        console.error('[TrackerWorker] Error during 401 self-healing reconnect:', err.message);
        this.isHandling401 = false;
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Schedule auto-reconnect with exponential backoff
   */
  private static scheduleReconnect(): void {
    if (!this.isMarketSessionActive && !this.isMarketHours()) {
      console.log('[TrackerWorker] Market session is inactive. WebSocket reconnect skipped.');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocketState();

    const delay = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelayMs
    );
    this.reconnectAttempts++;

    console.warn(`[TrackerWorker] Scheduling WebSocket reconnect in ${(delay / 1000).toFixed(1)}s (Attempt #${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.connectSmartApiWebSocket();
    }, delay);
  }

  /**
   * Clean up WebSocket instance & ping intervals safely
   */
  private static cleanupSocketState(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.wsClient) {
      try {
        this.wsClient.removeAllListeners();
        if (
          this.wsClient.readyState === WebSocket.OPEN ||
          this.wsClient.readyState === WebSocket.CONNECTING
        ) {
          this.wsClient.terminate();
        }
      } catch {
        // Ignore termination errors during cleanup
      }
      this.wsClient = null;
    }
  }

  /**
   * Connects to Angel One SmartAPI SmartStream v2 WebSocket for live market stream
   */
  public static async connectSmartApiWebSocket(): Promise<void> {
    if (!this.isMarketSessionActive && !this.isMarketHours()) {
      console.log('[TrackerWorker] Skipping WebSocket connection: outside active market hours.');
      return;
    }

    if (this.isConnecting) {
      console.log('[TrackerWorker] WebSocket connection attempt already in progress.');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let session = getCachedSession();
    if (!session) {
      try {
        session = await loginSmartApi();
      } catch (err: any) {
        console.error('[TrackerWorker] Failed to acquire SmartAPI session:', err.message);
        this.scheduleReconnect();
        return;
      }
    }

    if (!session || session.jwtToken.startsWith('mock')) {
      console.log('[TrackerWorker] SmartAPI Live Socket skipped (Using internal tick stream or Mock Session).');
      return;
    }

    this.isConnecting = true;
    const apiKey = process.env.SMARTAPI_API_KEY || '';
    const wsUrl = 'wss://smartapisocket.angelone.in/smart-stream';

    console.log(`[TrackerWorker] Connecting to SmartAPI SmartStream v2 at ${wsUrl} for client ${session.clientCode}...`);

    try {
      this.cleanupSocketState();

      const authHeader = `Bearer ${session.jwtToken || session.feedToken}`;

      this.wsClient = new WebSocket(wsUrl, {
        headers: {
          'Authorization': authHeader,
          'x-api-key': apiKey,
          'x-client-code': session.clientCode,
          'x-feed-token': session.feedToken,
        },
      });

      this.wsClient.on('unexpected-response', (_req, res) => {
        console.error(`[TrackerWorker] WebSocket unexpected server response: ${res.statusCode} ${res.statusMessage}`);
        if (res.statusCode === 401) {
          this.handle401Error();
        }
      });

      this.wsClient.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.authFailureAttempts = 0;
        this.isHandling401 = false;
        console.log('[TrackerWorker] Connected to SmartAPI WebSocket stream.');

        // Transmit immediate Mode-1 (LTP) subscription payload for Nifty 50 Spot (exchangeType: 1, token: "26000")
        const subscribePayload = {
          correlationID: 'tradegatekeeper_nifty_stream',
          action: 1, // 1 = Subscribe
          params: {
            mode: 1, // 1 = LTP
            tokenList: [
              {
                exchangeType: 1, // NSE Cash
                tokens: ['26000'], // NIFTY 50 Spot
              },
            ],
          },
        };

        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
          this.wsClient.send(JSON.stringify(subscribePayload));
          console.log('[TrackerWorker] Transmitted Mode-1 (LTP) subscription payload for Nifty 50 Spot (26000).');
        }

        // Active Heartbeat (Ping/Pong) every 25 seconds
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            try {
              this.wsClient.send('ping');
              this.wsClient.ping();
            } catch (pingErr: any) {
              console.error('[TrackerWorker] Error sending heartbeat ping:', pingErr.message);
            }
          }
        }, 25000);
      });

      this.wsClient.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        try {
          let buffer: Buffer;
          if (Buffer.isBuffer(data)) {
            buffer = data;
          } else if (Array.isArray(data)) {
            buffer = Buffer.concat(data);
          } else {
            buffer = Buffer.from(data as ArrayBuffer);
          }

          if (isBinary || (buffer.length >= 47 && buffer.readUInt8(0) === 1)) {
            const parsed = TrackerWorker.parseSmartStreamBinaryMessage(buffer);
            if (parsed) {
              const symbol = parsed.token === '26000' ? 'NIFTY' : parsed.token;
              const candleMgr = getCandleManager(symbol);
              candleMgr.onTickReceived(parsed.token, parsed.ltp, 1);

              const tick: TickData = {
                symbol,
                token: parsed.token,
                price: parsed.ltp,
                volume: 1,
                timestamp: parsed.timestamp,
              };
              TrackerWorker.onTick(tick);
            }
          } else {
            TrackerWorker.handleTextMessage(buffer.toString('utf8'));
          }
        } catch (err: any) {
          console.error('[TrackerWorker] Error handling WebSocket message:', err.message);
        }
      });

      this.wsClient.on('error', (err: Error) => {
        console.error('[TrackerWorker] WebSocket error:', err.message);
        if (err.stack) {
          console.error('[TrackerWorker] Stack trace:', err.stack);
        }
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        if (
          err.message.includes('401') ||
          err.message.toLowerCase().includes('unauthorized') ||
          err.message.includes('Unexpected server response: 401')
        ) {
          this.handle401Error();
        }
      });

      this.wsClient.on('close', (code: number, reason: Buffer) => {
        this.isConnecting = false;
        const reasonStr = reason ? reason.toString() : '';
        console.warn(`[TrackerWorker] WebSocket closed. Code: ${code}, Reason: "${reasonStr}".`);
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        if (!this.isHandling401 && (this.isMarketSessionActive || this.isMarketHours())) {
          TrackerWorker.scheduleReconnect();
        }
      });
    } catch (e: any) {
      this.isConnecting = false;
      console.error('[TrackerWorker] Exception initiating WebSocket:', e.message);
      if (e.stack) {
        console.error('[TrackerWorker] Exception stack trace:', e.stack);
      }
      if (
        e.message?.includes('401') ||
        e.message?.toLowerCase().includes('unauthorized')
      ) {
        this.handle401Error();
      } else if (this.isMarketSessionActive || this.isMarketHours()) {
        TrackerWorker.scheduleReconnect();
      }
    }
  }

  /**
   * Helper to check if current IST time falls within active trading hours (Monday-Friday, 08:45 AM - 03:45 PM IST)
   */
  public static isMarketHours(): boolean {
    const now = moment().tz('Asia/Kolkata');
    const day = now.day(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
    if (day === 0 || day === 6) return false;

    const totalMinutes = now.hours() * 60 + now.minutes();
    const startMinutes = 8 * 60 + 45; // 08:45 AM = 525 minutes
    const endMinutes = 15 * 60 + 45;  // 03:45 PM = 945 minutes

    return totalMinutes >= startMinutes && totalMinutes < endMinutes;
  }

  /**
   * 08:45 AM IST Pre-Market Warmup Procedure
   */
  public static async startPreMarketWarmup(): Promise<void> {
    console.log('[TrackerWorker] Starting pre-market warmup (08:45 AM IST)...');
    this.isMarketSessionActive = true;
    this.authFailureAttempts = 0;
    this.reconnectAttempts = 0;

    try {
      await loginSmartApi(true);
      await this.connectSmartApiWebSocket();
      console.log('[TrackerWorker] Pre-market warmup complete. WebSocket ready for 09:15 AM market open.');
    } catch (err: any) {
      console.error('[TrackerWorker] Error during pre-market warmup:', err.message);
    }
  }

  /**
   * 03:45 PM IST Post-Market Shutdown Procedure
   */
  public static stopMarketSession(): void {
    console.log('[TrackerWorker] Initiating post-market shutdown (03:45 PM IST)...');
    this.isMarketSessionActive = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.wsClient) {
      try {
        this.wsClient.removeAllListeners();
        if (
          this.wsClient.readyState === WebSocket.OPEN ||
          this.wsClient.readyState === WebSocket.CONNECTING
        ) {
          this.wsClient.close(1000, 'Normal Closure');
        }
      } catch (err: any) {
        console.error('[TrackerWorker] Error during WebSocket closure:', err.message);
      }
      this.wsClient = null;
    }

    console.log('[TrackerWorker] Market session closed. WebSocket safely disconnected for overnight idle.');
  }

  /**
   * Initializes the IST Market Hours Lifecycle Scheduler
   */
  public static initMarketLifecycleScheduler(): void {
    console.log('[TrackerWorker] Initializing IST Market Hours Lifecycle Scheduler (Asia/Kolkata timezone)...');

    if (this.lifecycleCheckTimer) {
      clearInterval(this.lifecycleCheckTimer);
    }

    // Evaluate IST market schedule state every 15 seconds
    this.lifecycleCheckTimer = setInterval(async () => {
      const now = moment().tz('Asia/Kolkata');
      const day = now.day(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
      const dateStr = now.format('YYYY-MM-DD');

      if (day >= 1 && day <= 5) {
        const totalMinutes = now.hours() * 60 + now.minutes();
        const warmupTime = 8 * 60 + 45;   // 08:45 AM = 525 mins
        const shutdownTime = 15 * 60 + 45; // 03:45 PM = 945 mins

        // Trigger 08:45 AM Pre-market warmup
        if (totalMinutes >= warmupTime && totalMinutes < shutdownTime) {
          if (this.lastWarmupDate !== dateStr) {
            this.lastWarmupDate = dateStr;
            await this.startPreMarketWarmup();
          }
        }

        // Trigger 03:45 PM Post-market shutdown
        if (totalMinutes >= shutdownTime && this.lastShutdownDate !== dateStr) {
          this.lastShutdownDate = dateStr;
          this.stopMarketSession();
        }
      }
    }, 15000);

    // Initial check on application boot
    if (this.isMarketHours()) {
      const todayStr = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
      this.lastWarmupDate = todayStr;
      console.log('[TrackerWorker] Application launched during market hours. Starting pre-market warmup...');
      this.startPreMarketWarmup();
    } else {
      console.log('[TrackerWorker] Application launched outside market hours. WebSocket remaining idle until next session warmup (08:45 AM IST).');
      this.isMarketSessionActive = false;
    }
  }
}
