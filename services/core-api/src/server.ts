import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { connectDB } from './config/db';
import { loginSmartApi } from './config/smartApi';
import { bootstrapHistoricalCandles } from './services/historyBootstrap';
import { TrackerWorker } from './services/trackerWorker';
import apiRouter from './routes/api';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(helmet());
app.use(cors());
app.use(express.json());

// API Route mounting
app.use('/api/v1', apiRouter);

async function bootstrap() {
  console.log('=====================================================');
  console.log('         TradeGatekeeper Engine Bootstrapping        ');
  console.log('=====================================================');

  try {
    // 1. Connect MongoDB
    await connectDB();

    // 2. Authenticate SmartAPI Session & Generate TOTP
    await loginSmartApi();

    // 3. Warmup Historical OHLCV Candles from Angel One SmartAPI REST
    await bootstrapHistoricalCandles('NIFTY', '26000');

    // 4. Initialize Paper Trade Tracker & RAM positions state
    await TrackerWorker.init();

    // 5. Connect Live WebSocket market feed
    TrackerWorker.connectSmartApiWebSocket();

    // 6. Listen Express API Server
    const server = app.listen(PORT, () => {
      console.log(`[Core API] Server running on http://0.0.0.0:${PORT}`);
      console.log(`[Core API] Endpoints available at http://0.0.0.0:${PORT}/api/v1/health`);
    });

    // Graceful Shutdown
    const gracefulShutdown = (signal: string) => {
      console.log(`\n[Core API] Received ${signal}. Shutting down gracefully...`);
      server.close(() => {
        console.log('[Core API] Express HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    console.error('[Core API] Bootstrap error:', error);
    process.exit(1);
  }
}

bootstrap();
