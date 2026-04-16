import axios from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

function normalizeUrl(url: string): string {
  return url.split('?')[0].replace(/\/$/, '');
}

/** True for The Graph subgraphs used by this app (not Snapshot Hub). */
function isTapedSubgraphUrl(url: string): boolean {
  const u = normalizeUrl(url);
  const candidates = [config.sfSubgraphUrl, config.supSubgraphUrl, config.vestingSubgraphUrl].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  for (const c of candidates) {
    if (u === normalizeUrl(c)) return true;
  }
  const delegationUrl = normalizeUrl(
    `https://gateway.thegraph.com/api/${config.graphNetworkApiKey}/subgraphs/id/${config.delegationSubgraphId}`
  );
  return u === delegationUrl;
}

function fixtureKey(url: string, body: unknown): string {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return createHash('sha256').update(`${url}\n${payload}`).digest('hex');
}

/**
 * POST to a GraphQL subgraph endpoint with optional disk fixtures (record / replay).
 * Snapshot Hub and other HTTP are not intercepted — use plain axios there.
 */
export interface GraphqlPayload {
  data: Record<string, any>;
  errors?: unknown;
}

export interface GraphqlResponse<T = GraphqlPayload> {
  data: T;
}

export async function postSubgraphGraphql<T = unknown>(
  url: string,
  body: unknown
): Promise<GraphqlResponse<T>> {
  const mode = config.subgraphFixtureMode;
  if (mode === 'off' || !isTapedSubgraphUrl(url)) {
    return axios.post<T>(url, body);
  }

  const key = fixtureKey(url, body);
  const filePath = path.join(config.metricsFixtureDir, `${key}.json`);

  if (mode === 'replay') {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Subgraph fixture miss for ${url} (expected ${filePath}). Record with SUBGRAPH_FIXTURE_MODE=record first.`
      );
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    return { data: parsed };
  }

  // record
  const res = await axios.post<T>(url, body);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(res.data, null, 0), 'utf8');
  return res;
}
