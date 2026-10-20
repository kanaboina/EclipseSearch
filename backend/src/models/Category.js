const mongoose = require('mongoose');

// Minimal schema for the public category fields used by search cards.
const categorySchema = new mongoose.Schema({ name: String, slug: String });

module.exports = mongoose.models.Category || mongoose.model('Category', categorySchema);
