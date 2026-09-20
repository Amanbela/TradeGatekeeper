export type TradeAction = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED' | 'REJECTED';
export type TradeOutcome = 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'NONE';

export interface TickData {
  symbol: string;
  token: string;
  price: number;
  volume: number;
  timestamp: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalPayload {
  symbol: string;
  action: TradeAction;
  price: number;
  timeframe?: string;
  timestamp?: number;
  oiBuildupScore?: number;
  strikePrice?: number;
  optionType?: 'CE' | 'PE';
}

export interface IndicatorResult {
  fastEma: number;
  slowEma: number;
  rsi: number;
  atr: number;
  htf200Ema: number;
  adx: number;
  volumeRatio: number;
  emaCrossInLast4: boolean;
  rsiTriggered: boolean;
  isValidEntry: boolean;
  rejectionReason?: string;
}

export interface MlFeatureVector {
  volumeRatio20: number;
  adxValue: number;
  htfEmaDistance: number;
  rsiValue: number;
  atrNormalized: number;
  oiBuildupScore: number;
}

export interface MlPredictRequest {
  features: MlFeatureVector;
}

export interface MlPredictResponse {
  probability: number;
  approved: boolean;
  threshold: number;
  modelLoaded: boolean;
}

export interface RMSCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface ActivePosition {
  tradeId: string;
  symbol: string;
  token: string;
  action: TradeAction;
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  entryTimestamp: number;
  maxHoldTimeMinutes: number;
  featureVector: MlFeatureVector;
}
