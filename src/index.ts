import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { RegisterRoutes } from './routes';

const app = express();

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware to round numbers to 2 decimals and prevent scientific notation
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (data: any) => originalJson(JSON.parse(JSON.stringify(data, (_, v) => 
    typeof v === 'number' ? Math.round(v) : v
  )));
  next();
});

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