import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { Registry, Gauge } from 'prom-client';
import { config } from './config';
import { RegisterRoutes } from './routes';
import { getLastUpdatedTimestamps } from './metrics';

const app = express();

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Register TSOA routes
RegisterRoutes(app);

// Serve Swagger UI
app.use('/docs', swaggerUi.serve, swaggerUi.setup(undefined, {
  swaggerUrl: '/swagger.json',
}));

// Serve swagger.json
app.get('/swagger.json', (_req, res) => {
  res.sendFile(__dirname + '/swagger.json');
});

// Prometheus metrics
const promRegistry = new Registry();
const lastUpdatedGauge = new Gauge({
  name: 'sup_metrics_last_updated_timestamp_seconds',
  help: 'Unix timestamp of the last successful background update for each metrics source',
  labelNames: ['source'],
  registers: [promRegistry],
  collect() {
    const timestamps = getLastUpdatedTimestamps();
    for (const [source, ts] of Object.entries(timestamps)) {
      this.labels(source).set(ts);
    }
  },
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', promRegistry.contentType);
  res.end(await promRegistry.metrics());
});

// Error handling
app.use(function errorHandler(err: any, req: express.Request, res: express.Response, next: express.NextFunction) {
  if (err?.status === 400) {
    return res.status(400).json({ error: err.message });
  }
  
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});