const mongoose = require('mongoose');

const edgeSchema = new mongoose.Schema(
  {
    target: { type: String, required: true, lowercase: true, trim: true },
    weight: { type: Number, required: true, min: 0, max: 6 },
    // identity | synonym | hyponym | hypernym | sibling | scene | mood | tangent
    relation: { type: String, default: 'synonym' },
  },
  { _id: false }
);

const semanticNodeSchema = new mongoose.Schema(
  {
    word: { type: String, required: true, lowercase: true, trim: true, unique: true },
    isExpanded: { type: Boolean, default: false },
    edges: { type: [edgeSchema], default: [] },
  },
  { timestamps: true }
);

semanticNodeSchema.index({ isExpanded: 1 });

module.exports =
  mongoose.models.SemanticNode || mongoose.model('SemanticNode', semanticNodeSchema);
