import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import ragRoutes from './routes/rag.js';
import { startPriceTrackingScheduler } from './services/priceTrackerService.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix for ESM to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/price-tracker')
.then(() => {
  console.log('MongoDB connected successfully');
  // Start automatic background price tracking (scheduled every 12 hours)
  const checkIntervalHours = Number(process.env.PRICE_CHECK_INTERVAL_HOURS) || 12;
  startPriceTrackingScheduler(checkIntervalHours);
})
.catch((err) => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/rag', ragRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Price Tracker API is running' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
