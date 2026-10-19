const mongoose = require('mongoose');

const aiIngestionJobSchema = new mongoose.Schema(
  {
    wallpaperId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallpaper', required: true, unique: true },
    desiredStatus: { type: String, enum: ['published', 'scheduled'], default: 'published' },
    unprocessedWords: { type: [String], required: true },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null },
    nextRetryAt: { type: Date, default: Date.now },
    state: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed_permanent'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

aiIngestionJobSchema.index({ state: 1, nextRetryAt: 1 });

module.exports =
  mongoose.models.AiIngestionJob || mongoose.model('AiIngestionJob', aiIngestionJobSchema);
