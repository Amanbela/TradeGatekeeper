import os
import os.path
import logging
from typing import Dict, Any
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
import numpy as np
import xgboost as xgb

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml-service")

app = FastAPI(
    title="TradeGatekeeper ML Microservice",
    description="XGBoost Classifier Inference & Training Service for Option Signals",
    version="1.0.0",
)

MODEL_PATH = os.getenv("MODEL_PATH", "model.xgb")
xgb_model = None


def load_model():
    global xgb_model
    if os.path.exists(MODEL_PATH):
        try:
            model = xgb.Booster()
            model.load_model(MODEL_PATH)
            xgb_model = model
            logger.info(f"Successfully loaded trained model from {MODEL_PATH}")
        except Exception as e:
            logger.error(f"Failed to load XGBoost model: {e}")
            xgb_model = None
    else:
        logger.info(
            f"No trained model found at {MODEL_PATH}. Running with fallback heuristic inference."
        )
        xgb_model = None


@app.on_event("startup")
def startup_event():
    load_model()


class FeatureVector(BaseModel):
    volumeRatio20: float = Field(..., description="Signal volume / 20-period volume SMA ratio")
    adxValue: float = Field(..., description="ADX(14) indicator value")
    htfEmaDistance: float = Field(..., description="Percentage distance from 15m 200 EMA")
    rsiValue: float = Field(..., description="RSI(14) indicator value")
    atrNormalized: float = Field(..., description="ATR(14) normalized by asset price (%)")
    oiBuildupScore: float = Field(..., description="Open Interest buildup momentum score (0-1)")


class PredictRequest(BaseModel):
    features: FeatureVector


class PredictResponse(BaseModel):
    probability: float
    approved: bool
    threshold: float = 0.80
    modelLoaded: bool


@app.get("/health")
def health_check():
    return {
        "status": "UP",
        "service": "ml-service",
        "modelLoaded": xgb_model is not None,
    }


@app.post("/ml/predict", response_model=PredictResponse)
def predict(request: PredictRequest):
    feat = request.features

    # Order of features strictly must match training vector:
    # [VolumeRatio20, AdxValue, HtfEmaDistance, RsiValue, AtrNormalized, OiBuildupScore]
    feature_arr = np.array(
        [
            [
                feat.volumeRatio20,
                feat.adxValue,
                feat.htfEmaDistance,
                feat.rsiValue,
                feat.atrNormalized,
                feat.oiBuildupScore,
            ]
        ],
        dtype=np.float32,
    )

    feature_names = [
        "volumeRatio20",
        "adxValue",
        "htfEmaDistance",
        "rsiValue",
        "atrNormalized",
        "oiBuildupScore",
    ]

    threshold = 0.80

    if xgb_model is not None:
        try:
            dmatrix = xgb.DMatrix(feature_arr, feature_names=feature_names)
            probs = xgb_model.predict(dmatrix)
            prob = float(probs[0])
            logger.info(f"Model Inference P(Win) = {prob:.4f}")
            return PredictResponse(
                probability=prob,
                approved=prob >= threshold,
                threshold=threshold,
                modelLoaded=True,
            )
        except Exception as e:
            logger.error(f"Inference error with loaded model: {e}")

    # Fallback heuristic calculation if model not yet trained
    # Evaluates quality of technical setup
    base_prob = 0.70
    if feat.volumeRatio20 >= 1.5:
        base_prob += 0.08
    if feat.adxValue >= 25.0:
        base_prob += 0.08
    if feat.rsiValue >= 60.0 or feat.rsiValue <= 40.0:
        base_prob += 0.06

    prob = min(0.95, base_prob)
    logger.info(f"Fallback Heuristic P(Win) = {prob:.4f}")

    return PredictResponse(
        probability=prob,
        approved=prob >= threshold,
        threshold=threshold,
        modelLoaded=False,
    )


@app.post("/ml/train")
def trigger_training(background_tasks: BackgroundTasks):
    from train import run_training

    try:
        # Run training in background task
        background_tasks.add_task(run_training)
        return {
            "status": "QUEUED",
            "message": "XGBoost training pipeline triggered in background.",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
