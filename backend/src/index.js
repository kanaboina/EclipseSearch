const { setupSearchEngine, createSearchHttpServer } = require('./server');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  console.log('[Server] Initializing Search Engine & Atlas layer...');
  const t0 = Date.now();
  const engine = await setupSearchEngine();
  console.log(`[Server] Search Engine initialized in ${Date.now() - t0}ms (Atlas Live: ${engine.isAtlasLive})`);

  const server = createSearchHttpServer(engine);
  server.listen(PORT, HOST, () => {
    console.log(`[Server] EclipseSearch HTTP Server running on http://${HOST}:${PORT}`);
  });

  const shutdown = () => {
    console.log('\n[Server] Shutting down gracefully...');
    server.close(() => {
      console.log('[Server] Closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { main };
