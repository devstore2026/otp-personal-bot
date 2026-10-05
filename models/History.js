const mongoose = require('mongoose');

const historySchema = new mongoose.Schema(
  {
    orderId: { type: Number, required: true, unique: true, index: true },
    phone: { type: String, required: true },
    country: { type: String, required: true },
    operator: { type: String, default: '' },
    service: { type: String, required: true },
    price: { type: Number, required: true },
    code: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'RECEIVED', 'FINISHED', 'CANCELED', 'BANNED', 'TIMEOUT'],
      default: 'PENDING',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('History', historySchema);
