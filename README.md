# TradeGatekeeper 🛡️📈

**TradeGatekeeper** is an institutional-grade, self-hosted algorithmic trading engine and automated paper-testing platform designed specifically for Indian Index and Stock options (Nifty 50 & liquid F&O stocks).

Built for deployment on an Ubuntu VPS via multi-container Docker Compose, it enforces strict risk parameters, high-momentum execution windows, technical anti-whipsaw filters, automated TOTP session management, dynamic theta decay time-stops, and an XGBoost Machine Learning gatekeeper microservice.

---

## 🏗️ System Architecture

```
                       ┌─────────────────────────┐
                       │  Angel One SmartAPI     │
                       │   WebSocket Stream      │
                       └────────────┬────────────┘
                                    │ Ticks
                                    ▼
┌──────────────────┐    ┌─────────────────────────┐    ┌──────────────────┐
│ TradingView      │───>│    core-api (Node.js)   │───>│      Redis       │
│ Webhook Alerts   │    │ ┌─────────────────────┐ │    │ (1 Trade/Day Lock│
└──────────────────┘    │ │  RMSService         │ │    │  & Cooldowns)    │
                        │ ├─────────────────────┤ │    └──────────────────┘
                        │ │  GainzAlgo V2       │ │
                        │ ├─────────────────────┤ │    ┌──────────────────┐
                        │ │  OptionFilters      │ │───>│    MongoDB       │
                        │ └─────────────────────┘ │    │ (Trade Logs      │
                        └────────────┬────────────┘    │  & Features)     │
                                     │ Features        └──────────────────┘
                                     ▼
                        ┌─────────────────────────┐
                        │   ml-service (Python)   │
                        │ (FastAPI + XGBoost ML)  │
                        └─────────────────────────┘
```

---

## ⚡ Core Engine Features & Risk Management System (RMS)

1. **Strict Capital Protection (1 Trade Per Day)**:
   - Enforces exactly **ONE** trade per calendar date (IST).
   - Subsequent triggers for the day are atomically rejected via Redis with reason `DAILY_LIMIT_EXCEEDED`.
2. **Momentum Time Windows**:
   - Signal processing restricted to high-volatility liquidity windows:
     - **Morning Window**: 09:30 AM – 11:15 AM IST
     - **Afternoon Window**: 01:30 PM – 02:45 PM IST
3. **Event-Day Blacklist**:
   - Automatic trade rejection on RBI monetary policy announcements, union budget days, or major corporate earnings results.
4. **GainzAlgo V2 Alpha Engine**:
   - Native TypeScript indicator calculations (`technicalindicators`):
     - **Fast EMA (9)** & **Slow EMA (21)**
     - **RSI (14)** with Bullish threshold `> 55` and Bearish threshold `< 45`
     - **ATR (14)** with `1.5x` multiplier
   - **Entry Trigger**: EMA Crossover/Crossunder within the last 4 bars **AND** RSI crossing threshold.
5. **Options Anti-Trap & Anti-Whipsaw Filters**:
   - **HTF Trend Bias**: BUY only if price `> 15m 200 EMA`; SELL only if price `< 15m 200 EMA`.
   - **Sideways Chop Guard**: Rejects signals if `ADX(14) < 20`.
   - **Volume Surge Check**: Signal volume must be `>= 1.3x` of the 20-period volume SMA.
   - **Anti-Whipsaw Cooldown**: Minimum **30-minute (6-bar)** lockout period after any trade exit.
   - **Dynamic Theta Decay Time-Stop**: Exits position at market/breakeven if Target 1 is not achieved within **35 minutes**.
6. **Machine Learning Gatekeeper Subsystem**:
   - Python FastAPI microservice serving XGBoost inference.
   - Feature Vector: `[VolumeRatio20, AdxValue, HtfEmaDistance, RsiValue, AtrNormalized, OiBuildupScore]`.
   - Only approves trade execution if $P(\text{Win}) \ge 0.80$.

---

## 📁 Repository Structure

```
tradegatekeeper/
├── docker-compose.yml
├── .env.example
├── README.md
└── services/
    ├── core-api/
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── config/          # DB, Redis & SmartAPI TOTP config
    │       ├── types/           # TypeScript model interfaces
    │       ├── models/          # Mongoose Signal & PaperTrade schemas
    │       ├── engine/          # CandleManager, GainzAlgo V2 & OptionFilters
    │       ├── services/        # RMS, ML Client & RAM TrackerWorker
    │       ├── controllers/     # Webhook ingestion controller
    │       ├── routes/          # Express API endpoints
    │       └── server.ts        # Bootstrap entrypoint
    └── ml-service/
        ├── Dockerfile
        ├── requirements.txt
        ├── main.py              # FastAPI /ml/predict & /ml/train service
        └── train.py             # Standalone XGBoost training script
```

---

## 🚀 Quickstart & Deployment on Ubuntu VPS

### Prerequisites
- Ubuntu 22.04 LTS VPS
- Docker (`v24.0+`) and Docker Compose (`v2.20+`)
- Domain name pointed to VPS IP (for Nginx SSL)

### Step 1: Clone Repository & Configure Environment
```bash
git clone https://github.com/your-org/tradegatekeeper.git
cd tradegatekeeper

# Copy environment template
cp .env.example .env

# Edit environment variables with your SmartAPI credentials & TOTP secret
nano .env
```

### Step 2: Launch Docker Stack
```bash
docker compose up -d --build
```

Verify that all containers are healthy:
```bash
docker compose ps
```

---

## 🔒 Nginx Reverse Proxy & SSL Setup

To securely ingest Webhooks over HTTPS, configure Nginx on your VPS:

### 1. Install Nginx & Certbot
```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Configure Nginx Server Block (`/etc/nginx/sites-available/tradegatekeeper`)
```nginx
server {
    server_name tradegatekeeper.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 3. Enable Site & Acquire SSL Certificate
```bash
sudo ln -s /etc/nginx/sites-available/tradegatekeeper /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Obtain free Let's Encrypt SSL certificate
sudo certbot --nginx -d tradegatekeeper.yourdomain.com
```

---

## 🧪 Verification & Testing Guide

### 1. Health Check
```bash
curl -X GET http://localhost:3000/api/v1/health
```

### 2. Simulating WebSocket Ticks
Feed synthetic tick prices to populate the candle manager and evaluate open paper positions:
```bash
curl -X POST http://localhost:3000/api/v1/tick \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY",
    "token": "NIFTY_ATM",
    "price": 24500.50,
    "volume": 1500,
    "timestamp": 1774092300000
  }'
```

### 3. Ingesting a Signal (Webhook)
Send a test trade trigger payload:
```bash
curl -X POST http://localhost:3000/api/v1/signal \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY",
    "action": "BUY",
    "price": 24500.00,
    "oiBuildupScore": 0.85
  }'
```

### 4. Fetching Open Positions & Trade History
```bash
# View active paper positions in RAM
curl -X GET http://localhost:3000/api/v1/positions

# View past paper trades logged in MongoDB
curl -X GET http://localhost:3000/api/v1/trades
```

### 5. Triggering Machine Learning Model Retraining
```bash
curl -X POST http://localhost:3000/api/v1/ml/train
```

---

## ⚙️ License & Disclaimer

**Disclaimer**: TradeGatekeeper is provided for educational and paper-testing purposes only. Algorithmic options trading involves substantial risk of loss. Always perform thorough forward testing before considering live broker execution.
