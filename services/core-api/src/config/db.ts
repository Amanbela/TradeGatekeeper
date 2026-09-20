import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/tradegatekeeper';

export async function connectDB(): Promise<void> {
  const options = {
    autoIndex: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };

  let isConnected = false;
  let attempts = 0;

  while (!isConnected && attempts < 10) {
    try {
      attempts++;
      console.log(`[MongoDB] Connecting to ${MONGO_URI} (Attempt ${attempts})...`);
      await mongoose.connect(MONGO_URI, options);
      isConnected = true;
      console.log('[MongoDB] Connected successfully.');
    } catch (err) {
      console.error(`[MongoDB] Connection attempt ${attempts} failed:`, err);
      if (attempts >= 10) {
        throw new Error('Failed to connect to MongoDB after 10 attempts');
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
  }

  mongoose.connection.on('disconnected', () => {
    console.warn('[MongoDB] Disconnected! Attempting to reconnect...');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] Runtime error:', err);
  });
}
