// Wrapper to import @d10r/snapshot-strategies utils with proper typing
// This avoids TypeScript checking the package's source files directly

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

type Score = Record<string, number>;
type Snapshot = number | 'latest';

export interface GetScoresDirectParams {
  space: string;
  strategies: any[];
  network: string;
  provider: any;
  addresses: string[];
  snapshot: Snapshot;
}

// Use require to avoid TypeScript checking the package's source files directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snapshotStrategiesUtils = require('@d10r/snapshot-strategies/build/src/strategies/utils');

function normalizeFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFixtureValue);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeFixtureValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function fixtureKey(params: Omit<GetScoresDirectParams, 'provider'>): string {
  const normalized = normalizeFixtureValue({
    ...params,
    addresses: [...params.addresses].sort()
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export const getScoresDirect = async (
  space: string,
  strategies: any[],
  network: string,
  provider: any,
  addresses: string[],
  snapshot: Snapshot
): Promise<Score[]> => {
  const mode = config.snapshotScoreFixtureMode;
  const params = { space, strategies, network, addresses, snapshot };

  if (mode === 'off') {
    return snapshotStrategiesUtils.getScoresDirect(
      space,
      strategies,
      network,
      provider,
      addresses,
      snapshot
    );
  }

  const key = fixtureKey(params);
  const filePath = path.join(config.metricsFixtureDir, 'snapshot-score', `${key}.json`);

  if (mode === 'replay') {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Snapshot score fixture miss for space=${space} network=${network} snapshot=${snapshot} (expected ${filePath}). Record with SNAPSHOT_SCORE_FIXTURE_MODE=record first.`
      );
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Score[];
  }

  const res = await snapshotStrategiesUtils.getScoresDirect(
    space,
    strategies,
    network,
    provider,
    addresses,
    snapshot
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(res), 'utf8');
  return res;
};

export default {
  getScoresDirect
};
