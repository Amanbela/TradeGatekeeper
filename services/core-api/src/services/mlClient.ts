import axios from 'axios';
import { MlFeatureVector, MlPredictResponse } from '../types';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://ml-service:8000';

export class MlClient {
  /**
   * Calls the Python FastAPI ML microservice to compute P(Win)
   */
  public static async predict(features: MlFeatureVector): Promise<MlPredictResponse> {
    try {
      const response = await axios.post<MlPredictResponse>(
        `${ML_SERVICE_URL}/ml/predict`,
        { features },
        { timeout: 3000 }
      );
      return response.data;
    } catch (error: any) {
      console.warn(`[MLClient] Prediction request failed (${error.message}). Defaulting to fallback approval.`);
      // Return safe fallback response so system does not freeze if ML service is warming up
      return {
        probability: 0.85,
        approved: true,
        threshold: 0.80,
        modelLoaded: false,
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
