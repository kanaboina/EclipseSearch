/** Explicit allowlist public card DTO. Never spread the raw document. */
function wallpaperCardDTO(w) {
  const cat = w.category && typeof w.category === 'object' && w.category.name
    ? { _id: w.category._id, name: w.category.name, slug: w.category.slug }
    : null;
  return {
    _id: String(w._id),
    title: w.title,
    slug: w.slug,
    excerpt: w.excerpt || '',
    previewUrl: w.previewUrl,
    thumbnailUrl: w.thumbnailUrl || w.previewUrl,
    modalUrl: w.modalUrl || w.previewUrl,
    heroUrl: w.heroUrl || w.previewUrl,
    mobileCardUrl: w.mobileCardUrl || null,
    category: cat,
    style: w.style,
    tags: w.tags || [],
    colors: w.colors || [],
    deviceType: w.deviceType,
    featured: !!w.featured,
    premium: !!w.premium,
    views: w.views || 0,
    width: w.width ?? null,
    height: w.height ?? null,
    createdAt: w.createdAt,
  };
}

module.exports = { wallpaperCardDTO };
