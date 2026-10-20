const mongoose = require('mongoose');

const wallpaperSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    excerpt: { type: String, default: '' },
    style: { type: String, default: '' },
    story: { type: String, default: '' },
    tags: { type: [String], default: [] },
    categoryName: { type: String, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    deviceType: { type: String, enum: ['desktop', 'phone', 'tablet'], default: 'desktop' },
    status: { type: String, enum: ['draft', 'published', 'scheduled'], default: 'draft' },
    deletionPending: { type: Boolean, default: false },
    publishAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
    downloadsCount: { type: Number, default: 0 },
    featured: { type: Boolean, default: false },
    premium: { type: Boolean, default: false },
    previewUrl: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    modalUrl: { type: String, default: '' },
    heroUrl: { type: String, default: '' },
    mobileCardUrl: { type: String, default: '' },
    colors: { type: [String], default: [] },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    uuid: { type: String, default: '' },
    downloadKeys: { type: [String], default: [] },
    downloadBucket: { type: String, default: '' },
    downloads: { type: Number, default: 0 },
    conversionJournal: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

wallpaperSchema.index({ status: 1, publishAt: 1 });
wallpaperSchema.index({ deviceType: 1 });
wallpaperSchema.index({ category: 1 });
wallpaperSchema.index({ tags: 1 });
wallpaperSchema.index({ featured: 1, status: 1 });
wallpaperSchema.index({ title: 'text', excerpt: 'text', tags: 'text', style: 'text' });

module.exports =
  mongoose.models.Wallpaper || mongoose.model('Wallpaper', wallpaperSchema);