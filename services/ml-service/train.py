import os
import logging
import numpy as np
import pandas as pd
import pymongo
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, roc_auc_score

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml-train")

MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongodb:27017/tradegatekeeper")
MODEL_PATH = os.getenv("MODEL_PATH", "model.xgb")


def fetch_training_data_from_mongo():
    logger.info(f"Connecting to MongoDB at {MONGO_URI}...")
    client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = client.get_database()
    collection = db["papertrades"]

    cursor = collection.find(
        {"status": "CLOSED", "outcomeLabel": {"$in": [0, 1]}},
        {"features": 1, "outcomeLabel": 1, "_id": 0},
    )

    records = list(cursor)
    logger.info(f"Retrieved {len(records)} closed paper trades from MongoDB.")

    X_data = []
    y_data = []

    for r in records:
        f = r.get("features", {})
        if f and "volumeRatio20" in f:
            row = [
                f.get("volumeRatio20", 1.0),
                f.get("adxValue", 20.0),
                f.get("htfEmaDistance", 0.0),
                f.get("rsiValue", 50.0),
                f.get("atrNormalized", 1.5),
                f.get("oiBuildupScore", 0.5),
            ]
            X_data.append(row)
            y_data.append(r.get("outcomeLabel"))

    return np.array(X_data), np.array(y_data)


def generate_bootstrap_synthetic_data(samples=500):
    """
    Generates realistic bootstrap synthetic training samples if MongoDB contains < 50 real trades.
    Ensures model training pipeline runs seamlessly out-of-the-box.
    """
    logger.info(f"Generating {samples} synthetic bootstrap samples for initial model training...")
    np.random.seed(42)

    vol_ratio = np.random.uniform(0.8, 3.0, samples)
    adx = np.random.uniform(15.0, 50.0, samples)
    htf_dist = np.random.uniform(-2.5, 2.5, samples)
    rsi = np.random.uniform(30.0, 75.0, samples)
    atr_norm = np.random.uniform(0.8, 3.0, samples)
    oi_score = np.random.uniform(0.1, 0.9, samples)

    X = np.column_stack([vol_ratio, adx, htf_dist, rsi, atr_norm, oi_score])

    # Probability of win increases with volume ratio, ADX, and strong RSI
    win_score = (
        (vol_ratio - 1.3) * 0.25
        + (adx - 20) * 0.02
        + np.abs(rsi - 50) * 0.015
        + oi_score * 0.2
        + np.random.normal(0, 0.3, samples)
    )

    y = (win_score > 0.2).astype(int)

    return X, y


def run_training():
    logger.info("Starting XGBoost Model Training Pipeline...")

    try:
        X, y = fetch_training_data_from_mongo()
    except Exception as e:
        logger.warn(f"Failed to fetch data from MongoDB ({e}). Falling back to synthetic bootstrap.")
        X, y = np.array([]), np.array([])

    if len(X) < 50:
        logger.info(f"Insufficient real trade samples in DB ({len(X)} found). Merging synthetic bootstrap data.")
        X_synth, y_synth = generate_bootstrap_synthetic_data(samples=600)
        if len(X) > 0:
            X = np.vstack([X, X_synth])
            y = np.concatenate([y, y_synth])
        else:
            X, y = X_synth, y_synth

    feature_names = [
        "volumeRatio20",
        "adxValue",
        "htfEmaDistance",
        "rsiValue",
        "atrNormalized",
        "oiBuildupScore",
    ]

    df_X = pd.DataFrame(X, columns=feature_names)
    df_y = pd.Series(y)

    X_train, X_val, y_train, y_val = train_test_split(df_X, df_y, test_size=0.2, random_state=42)

    logger.info(f"Training set size: {len(X_train)} | Validation set size: {len(X_val)}")

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=feature_names)
    dval = xgb.DMatrix(X_val, label=y_val, feature_names=feature_names)

    params = {
        "objective": "binary:logistic",
        "eval_metric": ["logloss", "auc"],
        "max_depth": 4,
        "eta": 0.05,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "seed": 42,
    }

    evals = [(dtrain, "train"), (dval, "val")]
    bst = xgb.train(params, dtrain, num_boost_round=100, evals=evals, early_stopping_rounds=15, verbose_eval=False)

    val_preds = bst.predict(dval)
    val_labels = (val_preds >= 0.5).astype(int)

    acc = accuracy_score(y_val, val_labels)
    auc = roc_auc_score(y_val, val_preds)

    logger.info(f"Training Completed. Validation Accuracy: {acc * 100:.2f}% | ROC-AUC: {auc:.4f}")

    bst.save_model(MODEL_PATH)
    logger.info(f"Model saved successfully to {MODEL_PATH}")

    return {
        "status": "SUCCESS",
        "accuracy": float(acc),
        "roc_auc": float(auc),
        "samples": len(X),
        "modelPath": MODEL_PATH,
    }


if __name__ == "__main__":
    run_training()
