import axios from 'axios';
import { MlFeatureVector, MlPredictResponse } from '../types';
import { logSystemEvent } from '../models/SystemEvent';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://ml-service:8000';

export class MlClient {
  /**
   * Evaluates ML microservice prediction score.
   * Respects process.env.ML_MODE ('advisory' | 'gating', default 'advisory').
   */
  public static async predict(features: MlFeatureVector): Promise<MlPredictResponse> {
    const mlMode = process.env.ML_MODE || 'advisory';
    const isAdvisoryMode = mlMode.toLowerCase() === 'advisory';

    try {
      const response = await axios.post<MlPredictResponse>(
        `${ML_SERVICE_URL}/ml/predict`,
        { features },
        { timeout: 3000 }
      );

      const res = response.data;
      if (isAdvisoryMode) {
        // In Advisory Mode, ML computes probability and logs decision, but ALWAYS approves trade!
        return {
          probability: res.probability,
          approved: true,
          threshold: res.threshold,
          modelLoaded: res.modelLoaded,
          mode: 'advisory',
        };
      }

      return {
        ...res,
        mode: 'gating',
      };
    } catch (error: any) {
      console.warn(`[MLClient] Prediction request failed (${error.message}). ML_MODE=${mlMode}.`);
      logSystemEvent('ML_UNAVAILABLE', `ML service prediction failed: ${error.message}`, 'WARN').catch(() => {});

      if (isAdvisoryMode) {
        // Advisory mode fallback: Allow trade execution, log advisory notice
        return {
          probability: 0.5,
          approved: true,
          threshold: 0.8,
          modelLoaded: false,
          mode: 'advisory_fallback',
        };
      }

      // FAIL-CLOSED: In gating/strict mode, ML failure blocks trade
      return {
        probability: 0.0,
        approved: false,
        threshold: 0.8,
        modelLoaded: false,
        mode: 'gating_fail_closed',
      };
    }
  }

  /**
   * Triggers ML model retraining script via FastAPI
   */
  public static async triggerRetraining(): Promise<{ status: string; message: string }> {
    try {
      const response = await axios.post(`${ML_SERVICE_URL}/ml/train`, {}, { timeout: 10000 });
      return response.data;
    } catch (error: any) {
      console.error('[MLClient] Retraining trigger error:', error.message);
      throw new Error(`Failed to trigger ML model training: ${error.message}`);
    }
  }
}

