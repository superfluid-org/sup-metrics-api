import axios from 'axios';
import { Client, Chain, Transport } from 'viem';
import * as ethersProviders from '@ethersproject/providers';

const WEI_PER_TOKEN = BigInt(10) ** BigInt(18);

// Block number search constants
export const BASE_BLOCK_TIME_SECONDS = 2; // Base has ~2 second block time
export const ETHEREUM_BLOCK_TIME_SECONDS = 12; // Ethereum has ~12 second block time
const FIVE_MINUTE_WINDOW_SECONDS = 5 * 60;

interface BlockSearchState {
  blockNumber: bigint;
  blockTimestamp: number;
  targetTimestamp: number;
  secondsPerBlock: number;
}

const blockSearchHints = new WeakMap<Map<number, bigint>, BlockSearchState>();

/**
 * Safely stringify objects that may contain BigInt values
 */
export function safeStringify(obj: any, space?: number): string {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }, space);
}

/**
 * Convert a BigInt value in wei to a token number (dividing by 10^18)
 */
export function toTokenNumber(value: bigint): number {
  return Number(value / WEI_PER_TOKEN);
}

/**
 * Format axios errors with detailed information
 */
export function formatAxiosError(error: unknown, context: string): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const data = error.response?.data;
    const message = error.message;
    
    let errorMsg = `${context}: `;
    if (status) {
      errorMsg += `[${status}] `;
    }
    if (statusText) {
      errorMsg += `${statusText}`;
    }
    
    // For JSON-RPC errors, extract only essential information
    if (data && typeof data === 'object' && 'jsonrpc' in data && 'error' in data) {
      const rpcError = (data as any).error;
      if (rpcError) {
        errorMsg += ` - JSON-RPC error: code=${rpcError.code || 'unknown'}, message=${rpcError.message || 'unknown'}`;
        // Only include data field if it's short and meaningful
        if (rpcError.data && typeof rpcError.data === 'string' && rpcError.data.length < 200) {
          errorMsg += `, data=${rpcError.data}`;
        }
      }
    } else if (data) {
      // For non-JSON-RPC errors, include a concise representation
      if (typeof data === 'string') {
        // Truncate long strings
        const truncated = data.length > 200 ? data.substring(0, 200) + '...' : data;
        errorMsg += ` - ${truncated}`;
      } else if (typeof data === 'object') {
        // For objects, try to extract error message if available
        const errorMessage = (data as any).error?.message || (data as any).message || (data as any).error;
        if (errorMessage && typeof errorMessage === 'string') {
          const truncated = errorMessage.length > 200 ? errorMessage.substring(0, 200) + '...' : errorMessage;
          errorMsg += ` - ${truncated}`;
        }
      }
    }
    
    // Add the error message if it provides additional information and isn't already included
    if (message && !errorMsg.includes(message)) {
      errorMsg += ` (${message})`;
    }
    return errorMsg;
  }
  // For non-axios errors, return the error as a string
  return `${context}: ${error}`;
}

/**
 * Query all pages from a GraphQL endpoint using pagination
 */
export async function queryAllPages<T>(
  queryFn: (lastId: string) => string,
  toItems: (response: any) => any[],
  itemFn: (item: any) => T,
  graphqlEndpoint: string
): Promise<T[]> {
  let lastId = "";
  const items: T[] = [];
  const pageSize = 1000;

  while (true) {
    const response = await axios.post(graphqlEndpoint, {
      query: queryFn(lastId)
    });

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      break;
    }

    const newItems = toItems(response);
    items.push(...newItems.map(itemFn));

    if (newItems.length < pageSize) {
      break;
    } else {
      lastId = newItems[newItems.length - 1].id;
    }
    process.stdout.write(".");
    if (process.env.STOP_EARLY) {
      break;
    }
  }

  return items;
}

/**
 * Convert a viem client to an ethers v5 provider
 */
export function viemClientToEthersV5Provider(client: Client<Transport, Chain>): ethersProviders.Provider {
  return new ethersProviders.StaticJsonRpcProvider(
    {
      url: client.transport.url,
      timeout: 25000,
      allowGzip: true
    },
    client.chain.id
  );
}

/**
 * Get the block number at or before a given timestamp.
 * Uses caching and hints to minimize RPC calls.
 */
export async function getBlockNumberAtOrBefore(
  client: any,
  timestamp: number,
  cache: Map<number, bigint>,
  lowerBound: bigint,
  upperBound: bigint,
  defaultBlockTimeSeconds: number
): Promise<bigint> {
  if (cache.has(timestamp)) {
    const cachedBlock = cache.get(timestamp)!;
    console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${cachedBlock} (cached) using 0 RPC calls`);
    return cachedBlock;
  }

  const clampBlockNumber = (value: bigint): bigint => {
    if (value < lowerBound) return lowerBound;
    if (value > upperBound) return upperBound;
    return value;
  };

  let rpcCalls = 0;
  const seenBlocks = new Map<bigint, number>();
  const fetchTimestamp = async (blockNumber: bigint): Promise<number> => {
    if (seenBlocks.has(blockNumber)) {
      return seenBlocks.get(blockNumber)!;
    }
    const block = await client.getBlock({ blockNumber, includeTransactions: false });
    rpcCalls += 1;
    const blockTimestamp = Number(block.timestamp);
    console.log(`  fetched block ${blockNumber} at timestamp ${blockTimestamp}`);
    seenBlocks.set(blockNumber, blockTimestamp);
    return blockTimestamp;
  };

  const hint = blockSearchHints.get(cache);
  let secondsPerBlock = hint?.secondsPerBlock ?? defaultBlockTimeSeconds;

  const estimateFromHint = (): bigint => {
    if (!hint) {
      // When no hint exists, use previous block (lowerBound) if available
      // Otherwise start from upperBound and work backwards
      if (lowerBound > 0n) {
        // We have a previous block, estimate forward from it
        // This is a conservative estimate - we'll refine it
        return clampBlockNumber(lowerBound);
      }
      // No previous block, start from upper bound (will be refined)
      return clampBlockNumber(upperBound);
    }
    const deltaSeconds = timestamp - hint.targetTimestamp;
    const deltaBlocks = Math.round(deltaSeconds / Math.max(1, secondsPerBlock));
    return clampBlockNumber(hint.blockNumber + BigInt(deltaBlocks));
  };

  const updateBounds = (
    blockNumber: bigint,
    blockTimestamp: number,
    bounds: {
      lowBlock: bigint | null;
      lowTimestamp: number;
      highBlock: bigint | null;
      highTimestamp: number;
    }
  ) => {
    if (blockTimestamp < timestamp) {
      if (!bounds.lowBlock || blockNumber > bounds.lowBlock) {
        bounds.lowBlock = blockNumber;
        bounds.lowTimestamp = blockTimestamp;
      }
    } else {
      if (!bounds.highBlock || blockNumber < bounds.highBlock) {
        bounds.highBlock = blockNumber;
        bounds.highTimestamp = blockTimestamp;
      }
    }
  };

  const bounds = {
    lowBlock: null as bigint | null,
    lowTimestamp: 0,
    highBlock: null as bigint | null,
    highTimestamp: 0
  };

  const windowEnd = timestamp + FIVE_MINUTE_WINDOW_SECONDS;
  const isWithinWindow = (blockTimestamp: number): boolean => {
    return blockTimestamp >= timestamp && blockTimestamp <= windowEnd;
  };

  let guess = estimateFromHint();
  let guessTimestamp = await fetchTimestamp(guess);
  updateBounds(guess, guessTimestamp, bounds);
  
  // Early exit if guess is already within window
  if (isWithinWindow(guessTimestamp)) {
    cache.set(timestamp, guess);
    const smoothedSecondsPerBlock = hint
      ? hint.secondsPerBlock * 0.5 + secondsPerBlock * 0.5
      : secondsPerBlock;
    blockSearchHints.set(cache, {
      blockNumber: guess,
      blockTimestamp: guessTimestamp,
      targetTimestamp: timestamp,
      secondsPerBlock: Math.max(0.5, Math.min(60, smoothedSecondsPerBlock))
    });
    console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${guess} (ts=${guessTimestamp}) using ${rpcCalls} RPC calls`);
    return guess;
  }

  const stepForward = async (anchorBlock: bigint, anchorTimestamp: number): Promise<boolean> => {
    const secondsBehind = timestamp - anchorTimestamp;
    const step = BigInt(Math.max(1, Math.round(secondsBehind / Math.max(1, secondsPerBlock))));
    let nextBlock = clampBlockNumber(anchorBlock + step);
    if (nextBlock === anchorBlock) {
      if (nextBlock === upperBound) return false;
      nextBlock = clampBlockNumber(anchorBlock + 1n);
      if (nextBlock === anchorBlock) return false;
    }
    const nextTimestamp = await fetchTimestamp(nextBlock);
    updateBounds(nextBlock, nextTimestamp, bounds);
    return isWithinWindow(nextTimestamp);
  };

  const stepBackward = async (anchorBlock: bigint, anchorTimestamp: number): Promise<boolean> => {
    const secondsAhead = anchorTimestamp - timestamp;
    const step = BigInt(Math.max(1, Math.round(secondsAhead / Math.max(1, secondsPerBlock))));
    let nextBlock = clampBlockNumber(anchorBlock - step);
    if (nextBlock === anchorBlock) {
      if (nextBlock === lowerBound) return false;
      nextBlock = clampBlockNumber(anchorBlock - 1n);
      if (nextBlock === anchorBlock) return false;
    }
    const nextTimestamp = await fetchTimestamp(nextBlock);
    updateBounds(nextBlock, nextTimestamp, bounds);
    return isWithinWindow(nextTimestamp);
  };

  while (!bounds.highBlock || bounds.highTimestamp < timestamp) {
    const anchorBlock = bounds.lowBlock ?? bounds.highBlock ?? guess;
    const anchorTimestamp = bounds.lowBlock ? bounds.lowTimestamp : bounds.highTimestamp || guessTimestamp;
    if (anchorBlock === upperBound && bounds.highTimestamp < timestamp) {
      break;
    }
    const foundWithinWindow = await stepForward(anchorBlock, anchorTimestamp);
    if (foundWithinWindow) {
      // Found a block within window, use it
      cache.set(timestamp, bounds.highBlock!);
      const smoothedSecondsPerBlock = hint
        ? hint.secondsPerBlock * 0.5 + secondsPerBlock * 0.5
        : secondsPerBlock;
      blockSearchHints.set(cache, {
        blockNumber: bounds.highBlock!,
        blockTimestamp: bounds.highTimestamp,
        targetTimestamp: timestamp,
        secondsPerBlock: Math.max(0.5, Math.min(60, smoothedSecondsPerBlock))
      });
      console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${bounds.highBlock} (ts=${bounds.highTimestamp}) using ${rpcCalls} RPC calls`);
      return bounds.highBlock!;
    }
    if ((bounds.highBlock ?? anchorBlock) === upperBound) {
      break;
    }
    if (!bounds.highBlock && (bounds.lowBlock ?? anchorBlock) === upperBound) {
      break;
    }
  }

  while (!bounds.lowBlock || bounds.lowTimestamp >= timestamp) {
    const anchorBlock = bounds.highBlock ?? bounds.lowBlock ?? guess;
    const anchorTimestamp = bounds.highBlock ? bounds.highTimestamp : bounds.lowTimestamp || guessTimestamp;
    if (anchorBlock === lowerBound && (!bounds.lowBlock || bounds.lowTimestamp >= timestamp)) {
      break;
    }
    const foundWithinWindow = await stepBackward(anchorBlock, anchorTimestamp);
    if (foundWithinWindow) {
      // Found a block within window, use it
      cache.set(timestamp, bounds.highBlock!);
      const smoothedSecondsPerBlock = hint
        ? hint.secondsPerBlock * 0.5 + secondsPerBlock * 0.5
        : secondsPerBlock;
      blockSearchHints.set(cache, {
        blockNumber: bounds.highBlock!,
        blockTimestamp: bounds.highTimestamp,
        targetTimestamp: timestamp,
        secondsPerBlock: Math.max(0.5, Math.min(60, smoothedSecondsPerBlock))
      });
      console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${bounds.highBlock} (ts=${bounds.highTimestamp}) using ${rpcCalls} RPC calls`);
      return bounds.highBlock!;
    }
    if ((bounds.lowBlock ?? anchorBlock) === lowerBound) {
      break;
    }
    if (!bounds.lowBlock && (bounds.highBlock ?? anchorBlock) === lowerBound) {
      break;
    }
  }

  if (!bounds.highBlock) {
    bounds.highBlock = upperBound;
    bounds.highTimestamp = await fetchTimestamp(upperBound);
  }

  if (!bounds.lowBlock) {
    bounds.lowBlock = lowerBound;
    bounds.lowTimestamp = await fetchTimestamp(lowerBound);
  }

  if (bounds.highTimestamp < timestamp) {
    cache.set(timestamp, bounds.highBlock);
    console.warn(`Using latest available block ${bounds.highBlock} for timestamp ${timestamp} (ts=${bounds.highTimestamp})`);
    console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${bounds.highBlock} (ts=${bounds.highTimestamp}) using ${rpcCalls} RPC calls`);
    return bounds.highBlock;
  }
  
  // Early exit: if highBlock is already within the acceptable window, use it
  if (isWithinWindow(bounds.highTimestamp)) {
    cache.set(timestamp, bounds.highBlock);
    const smoothedSecondsPerBlock = hint
      ? hint.secondsPerBlock * 0.5 + secondsPerBlock * 0.5
      : secondsPerBlock;
    blockSearchHints.set(cache, {
      blockNumber: bounds.highBlock,
      blockTimestamp: bounds.highTimestamp,
      targetTimestamp: timestamp,
      secondsPerBlock: Math.max(0.5, Math.min(60, smoothedSecondsPerBlock))
    });
    console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${bounds.highBlock} (ts=${bounds.highTimestamp}) using ${rpcCalls} RPC calls`);
    return bounds.highBlock;
  }

  while (bounds.highBlock - bounds.lowBlock > 1n) {
    const mid = bounds.lowBlock + (bounds.highBlock - bounds.lowBlock) / 2n;
    const midTimestamp = await fetchTimestamp(mid);
    updateBounds(mid, midTimestamp, bounds);
    
    // Early exit: if we found a block within the acceptable window, use it
    if (isWithinWindow(bounds.highTimestamp)) {
      break;
    }
  }

  let resultBlock = bounds.highBlock;
  let resultTimestamp = bounds.highTimestamp;

  while (resultTimestamp > windowEnd && resultBlock > lowerBound) {
    const prevBlock = resultBlock - 1n;
    const prevTimestamp = await fetchTimestamp(prevBlock);
    if (prevTimestamp < timestamp) {
      break;
    }
    resultBlock = prevBlock;
    resultTimestamp = prevTimestamp;
  }

  if (resultTimestamp > windowEnd) {
    console.warn(`No block within 5 minute window for timestamp ${timestamp}; using block ${resultBlock} (ts=${resultTimestamp})`);
  }

  cache.set(timestamp, resultBlock);

  let observedSecondsPerBlock = secondsPerBlock;
  if (seenBlocks.size >= 2) {
    const entries = Array.from(seenBlocks.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const [firstBlock, firstTimestamp] = entries[0];
    const [lastBlock, lastTimestamp] = entries[entries.length - 1];
    const blockDelta = Number(lastBlock - firstBlock);
    const timeDelta = lastTimestamp - firstTimestamp;
    if (blockDelta > 0 && timeDelta > 0) {
      observedSecondsPerBlock = timeDelta / blockDelta;
    }
  }

  const smoothedSecondsPerBlock = hint
    ? hint.secondsPerBlock * 0.5 + observedSecondsPerBlock * 0.5
    : observedSecondsPerBlock;

  blockSearchHints.set(cache, {
    blockNumber: resultBlock,
    blockTimestamp: resultTimestamp,
    targetTimestamp: timestamp,
    secondsPerBlock: Math.max(0.5, Math.min(60, smoothedSecondsPerBlock))
  });

  console.log(`getBlockNumberAtOrBefore(${timestamp}) -> block ${resultBlock} (ts=${resultTimestamp}) using ${rpcCalls} RPC calls`);

  return resultBlock;
}

