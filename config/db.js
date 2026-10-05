const mongoose = require('mongoose');

async function connectDB() {
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    // البوت يستمر في العمل حتى لو فشل الاتصال بقاعدة البيانات (السجل تاريخي فقط)
  }
}

module.exports = connectDB;
