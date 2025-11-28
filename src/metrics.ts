import axios from 'axios';
import { config } from './config';
import * as fs from 'fs';
import * as path from 'path';
import {
  TotalDelegatedScoreResponse,
  DaoMembersCountResponse,
  TotalScoreResponse,
  VotingPower,
  DaoMember,
  DaoMembersResponse,
  DistributionMetrics,
  DistributionMetricsAggregate,
  DistributionMetricsResponse,
  VestingSchedule,
  LockerBreakdown,
  DistributionMetricsHistoryEntry,
  DistributionMetricsHistoryResponse,
  StakeCooldownProjectionEntry
} from './types'; 
import snapshot from '@snapshot-labs/snapshot.js';
import snapshotStrategies from '@d10r/snapshot-strategies';
import { createPublicClient, http, Address, erc20Abi } from 'viem';
import { formatUnits } from 'viem';
import { base, mainnet } from 'viem/chains'
import { LOCKER_ABI, SUP_VESTING_FACTORY_ABI, SUPERFLUID_POOL_ABI, UNISWAP_V3_POOL_ABI } from './abis';
import { 
  safeStringify, 
  toTokenNumber, 
  formatAxiosError, 
  queryAllPages, 
  viemClientToEthersV5Provider,
  getBlockNumberAtOrBefore,
  BASE_BLOCK_TIME_SECONDS,
  ETHEREUM_BLOCK_TIME_SECONDS
} from './utils';

// File paths for metric data
const DATA_DIR = './data';
const VOTING_METRICS_FILE_SCHEMA_VERSION = 2;
const DISTRIBUTION_METRICS_FILE_SCHEMA_VERSION = 7;
const DISTRIBUTION_METRICS_HISTORY_FILE_SCHEMA_VERSION = 2;
const HISTORY_FILE_NAME = 'distributionMetricsHistory.json';
const HISTORY_FILE_PATH = path.join(DATA_DIR, HISTORY_FILE_NAME);
const baseBlockNumberCache = new Map<number, bigint>();
const ethereumBlockNumberCache = new Map<number, bigint>();
const VESTING_FACTORY_DEPLOYMENT_BLOCK = 33631769n;

// Setup viem client with batching support
const viemClient = createPublicClient({
  chain: base,
  transport: http(config.baseRpcUrl, { 
    batch: {
      wait: 100
    }
  }),
});


interface MemberData {
  ownVp: number;
  delegatedVp?: number;
  nrDelegators?: number;
  delegate?: string;
  locker?: string;
}

interface SpaceConfig {
  network: string;
  strategies: {
    name: string;
    params: any;
  }[];
  lastUpdatedAt: number;
}

// Internal structure for persisted data
interface MetricsData<T> {
  schemaVersion: number;
  lastUpdatedAt: number;
  data: T;
}

// Generic metrics manager handling data loading, saving and periodic updating
class MetricsManager<T> {
  private data: MetricsData<T>;
  private filePath: string;
  private schemaVersion: number;
  private updateFn: () => Promise<T>;
  private intervalSec: number;
  private isUpdating: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    initialData: T,
    updateFn: () => Promise<T>,
    filename: string,
    schemaVersion: number,
    intervalSec: number
  ) {
    console.log(`Initializing ${filename} with interval ${intervalSec} seconds`);
    this.updateFn = updateFn;
    this.intervalSec = intervalSec;
    this.schemaVersion = schemaVersion;
    this.data = {
      schemaVersion: this.schemaVersion,
      lastUpdatedAt: 0,
      data: initialData
    };
    this.filePath = path.join(DATA_DIR, filename);
    
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      console.log(`Creating data directory ${DATA_DIR}`);
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Start periodic updates if interval is positive
    if (this.intervalSec > 0) {
      this.startPeriodicUpdates();
    }
  }

  // Get current data
  getData(): { data: T; lastUpdatedAt: number } {
    return {
      data: this.data.data,
      lastUpdatedAt: this.data.lastUpdatedAt
    };
  }

  // Save data to file
  private saveToFile(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.data, null, 2)
      );
    } catch (error) {
      console.error(`### Error saving to ${this.filePath}:`, error);
    }
  }

  // Load data from file
  private loadFromFile(): boolean {
    try {
      if (fs.existsSync(this.filePath)) {
        const fileData = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (fileData.schemaVersion !== this.schemaVersion) {
          console.warn(`File schema version mismatch: ${fileData.schemaVersion} (expected ${this.schemaVersion})`);
          return false;
        }
        this.data = fileData;
        return true;
      }
    } catch (error) {
      console.error(`### Error loading from ${this.filePath}:`, error);
    }
    return false;
  }

  // Update data
  async update(): Promise<void> {
    // Check if an update is already running
    if (this.isUpdating) {
      console.log(`Update already in progress for ${this.filePath}, skipping this update`);
      return;
    }

    try {
      this.isUpdating = true;
      console.log(`Starting update for ${this.filePath}`);
      
      const newData = await this.updateFn();
      const currentTimestamp = Math.floor(Date.now() / 1000);
      this.data = {
        schemaVersion: this.schemaVersion,
        lastUpdatedAt: currentTimestamp,
        data: newData
      };
      
      this.saveToFile();
      console.log(`Completed update for ${this.filePath}`);
    } catch (error) {
      console.error(`Error updating data for ${this.filePath}:`, error);
    } finally {
      this.isUpdating = false;
    }
  }

  // Check if data needs updating based on age and interval
  private needsUpdate(): boolean {
    if (this.intervalSec <= 0) return false;
    if (this.data.lastUpdatedAt === 0) return true; // No data loaded
    
    const now = Math.floor(Date.now() / 1000);
    const dataAge = now - this.data.lastUpdatedAt;
    return dataAge >= this.intervalSec;
  }

  // Start periodic updates
  private startPeriodicUpdates(): void {
    // Always load data on start
    console.log(`Loading data for ${this.filePath}`);
    const loaded = this.loadFromFile();
    
    // Determine if we need to update
    if (this.needsUpdate()) {
      const reason = !loaded ? "No cached data found" : `Cached data is stale (${Math.floor(Date.now() / 1000) - this.data.lastUpdatedAt}s old)`;
      console.log(`${reason}, will update`);
      
      // Perform initial update if needed
      if (!process.env.SKIP_INITIAL_UPDATE) {
        this.update();
      }
    } else {
      const dataAge = Math.floor(Date.now() / 1000) - this.data.lastUpdatedAt;
      console.log(`Using cached data (${dataAge}s old)`);
    }
    
    // Setup interval for future updates
    console.log(`Setting up periodic updates for ${this.filePath} with interval ${this.intervalSec} seconds`);
    this.intervalId = setInterval(() => {
      this.update();
    }, this.intervalSec * 1000);
  }

  // Stop periodic updates
  stopPeriodicUpdates(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

const defaultHistoricalData: MetricsData<DistributionMetricsHistoryEntry[]> = {
  schemaVersion: DISTRIBUTION_METRICS_HISTORY_FILE_SCHEMA_VERSION,
  lastUpdatedAt: 0,
  data: []
};

let historicalDistributionMetrics: MetricsData<DistributionMetricsHistoryEntry[]> = { ...defaultHistoricalData };

function ensureDataDirectoryExists(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Creating data directory ${DATA_DIR}`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadHistoricalDistributionMetricsFromDisk(): void {
  try {
    ensureDataDirectoryExists();
    if (!fs.existsSync(HISTORY_FILE_PATH)) {
      return;
    }
    const fileData = JSON.parse(fs.readFileSync(HISTORY_FILE_PATH, 'utf8'));
    if (fileData.schemaVersion !== DISTRIBUTION_METRICS_HISTORY_FILE_SCHEMA_VERSION) {
      console.warn(`Historical metrics schema version mismatch: ${fileData.schemaVersion} (expected ${DISTRIBUTION_METRICS_HISTORY_FILE_SCHEMA_VERSION})`);
      return;
    }
    historicalDistributionMetrics = fileData;
  } catch (error) {
    console.error('Error loading historical distribution metrics:', error);
  }
}

function saveHistoricalDistributionMetricsToDisk(data: MetricsData<DistributionMetricsHistoryEntry[]>): void {
  try {
    ensureDataDirectoryExists();
    fs.writeFileSync(
      HISTORY_FILE_PATH,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error('Error saving historical distribution metrics:', error);
  }
}

// Helper function to create default distribution metrics structure
function createDefaultDistributionMetrics(): DistributionMetricsAggregate {
  return {
    reserveBalances: 0,
    lockerBalances: 0,
    stakedSup: 0,
    lpSup: 0,
    lpSupProvided: 0,
    lpSupCollected: 0,
    streamingOut: 0,
    communityCharge: 0,
    investorsTeamLocked: 0,
    daoTreasury: 0,
    daoTreasuryUnlocked: 0,
    daoTreasuryLocked: 0,
    daoSPRProgramManager: 0,
    foundationTreasury: 0,
    vestingTreasury: 0,
    supCorpOps: 0,
    other: 0,
    totalSupply: 1000000000, // 1B SUP tokens
    reservesWithFontaines: 0,
    reservesWithStake: 0,
    reservesWithLiquidity: 0,
    reservesWithInstantUnlock: 0,
    reservesWithNone: 0,
    instantUnlocked: 0,
    streamUnlocked: 0,
    tax: 0,
    stakeCooldownProjection: [],
  };
}

// Create voting metrics manager instance
const votingMetricsManager = new MetricsManager<Record<string, MemberData>>(
  {},
  fetchVotingMetrics,
  "votingMetrics.json",
  VOTING_METRICS_FILE_SCHEMA_VERSION,
  config.votingMetricsUpdateInterval
);

// Create distribution metrics manager instance
const distributionMetricsManager = new MetricsManager<DistributionMetrics>(
  {
    ...createDefaultDistributionMetrics(),
    lockers: []
  },
  fetchDistributionMetrics,
  "distributionMetrics.json",
  DISTRIBUTION_METRICS_FILE_SCHEMA_VERSION,
  config.distributionMetricsUpdateInterval
);

// lightweight calculation which just queries aggregates and omits the list of lockers
async function fetchDistributionMetrics2(): Promise<DistributionMetricsAggregate> {
  const timestamp = Math.floor(Date.now() / 1000);
  
  const ethereumClient = createPublicClient({
    chain: mainnet,
    transport: http(config.ethereumRpcUrl, {
      batch: {
        wait: 100
      }
    }),
  });

  // add a small offset to reduce the risk of the subgraph not yet having synced it
  const latestBaseBlock = await viemClient.getBlockNumber() - 100n;
  const latestEthereumBlock = await ethereumClient.getBlockNumber() - 20n;

  const baseBlock = await getBlockNumberAtOrBefore(
    viemClient,
    timestamp,
    baseBlockNumberCache,
    0n,
    latestBaseBlock,
    BASE_BLOCK_TIME_SECONDS
  );
  const ethereumBlock = await getBlockNumberAtOrBefore(
    ethereumClient,
    timestamp,
    ethereumBlockNumberCache,
    0n,
    latestEthereumBlock,
    ETHEREUM_BLOCK_TIME_SECONDS
  );

  const snapshot = await calculateDistributionMetricsAtTimestamp(timestamp, baseBlock, ethereumBlock);
  
  // Return without timestamp and with empty lockers array
  const { timestamp: _, ...metrics } = snapshot;
  return metrics;
}

// Create distribution metrics 2 manager instance
const distributionMetrics2Manager = new MetricsManager<DistributionMetricsAggregate>(
  createDefaultDistributionMetrics(),
  fetchDistributionMetrics2,
  "distributionMetrics2.json",
  DISTRIBUTION_METRICS_FILE_SCHEMA_VERSION,
  config.distributionMetrics2UpdateInterval
);

loadHistoricalDistributionMetricsFromDisk();
if (process.env.REFRESH_HISTORICAL_STATE && process.env.REFRESH_HISTORICAL_STATE.toLowerCase() === 'true') {
  void refreshHistoricalDistributionMetricsIfNeeded();
}

// Cache for space config with 24h expiration
let cachedSpaceConfig: SpaceConfig | undefined;
const spaceConfigExpiration = 24 * 60 * 60;

const getSpaceConfig = async (): Promise<SpaceConfig> => {
  const now = Math.floor(Date.now() / 1000);

  // Return cached config if it exists and is less than 24h old
  if (cachedSpaceConfig && (now - cachedSpaceConfig.lastUpdatedAt) < spaceConfigExpiration) {
    return cachedSpaceConfig;
  }

  try {
    // Fetch space configuration
    const query = `
      query GetSpaceConfig($id: String!) {
        space(id: $id) {
          id
          name
          network
          strategies {
            name
            params
          }
        }
      }
    `;

    const response = await axios.post(
      config.snapshotHubUrl,
      {
        query,
        variables: {
          id: config.snapshotSpace
        }
      }
    );

    const space = response.data.data.space;
    if (!space) {
      throw new Error(`Space ${config.snapshotSpace} not found`);
    }

    cachedSpaceConfig = {
      network: space.network,
      strategies: space.strategies,
      lastUpdatedAt: now
    };

    console.log(`** Loaded space config for ${config.snapshotSpace}: ${JSON.stringify(cachedSpaceConfig, null, 2)}`);
    return cachedSpaceConfig;
  } catch (error) {
    console.error(formatAxiosError(error, 'Error loading space config'));
    
    // If we have a cached config, use it as fallback
    if (cachedSpaceConfig) {
      console.log('Using cached space config as fallback');
      return cachedSpaceConfig;
    }
    
    throw error;
  }
};

// Public API methods

export const getDaoMembersCount = (): DaoMembersCountResponse => {
  const { data: unifiedData, lastUpdatedAt } = votingMetricsManager.getData();
  return {
    daoMembersCount: Object.keys(unifiedData).length,
    lastUpdatedAt
  };
};

export const getTotalDelegatedScore = (): TotalDelegatedScoreResponse => {
  const { data: unifiedData, lastUpdatedAt } = votingMetricsManager.getData();
  
  // Calculate total delegated score by summing all delegatedVp
  const totalDelegatedScore = Object.values(unifiedData).reduce(
    (sum, member) => sum + (member.delegatedVp || 0),
    0
  );

  // Convert to per-delegate format
  const perDelegateScore = Object.entries(unifiedData)
    .filter(([_, member]) => member.delegatedVp && member.delegatedVp > 0)
    .map(([address, member]) => ({
      address,
      score: member.ownVp + (member.delegatedVp || 0),
      delegatedScore: member.delegatedVp!,
      nrDelegations: member.nrDelegators || 0
    }));

  return {
    totalDelegatedScore,
    perDelegateScore,
    lastUpdatedAt
  };
};

// Combine data for DAO members endpoint from voting metrics
export const getDaoMembers = (): DaoMember[] => {
  console.log('getDaoMembers called');
  const { data: unifiedData, lastUpdatedAt } = votingMetricsManager.getData();
  
  // Convert to required format
  const daoMembers = Object.entries(unifiedData).map(([address, data]) => {
    const member = {
      address,
      locker: data.locker || null,
      votingPower: data.ownVp,
      hasDelegate: data.delegate || null,
      isDelegate: data.delegatedVp ? {
        delegatedVotingPower: data.delegatedVp,
        nrDelegators: data.nrDelegators || 0
      } : null
    };
    return member;
  });

  console.log('Created', daoMembers.length, 'members');
  return daoMembers;
};

export const getDaoMembersWithFilters = (
  minVotingPower: number = 0, 
  includeAllDelegates: boolean = false
): DaoMembersResponse => {
  console.log('getDaoMembersWithFilters called with:', { minVotingPower, includeAllDelegates });
  const daoMembers = getDaoMembers();
  const { lastUpdatedAt } = votingMetricsManager.getData();
  
  
  const filteredMembers = daoMembers.filter(member => {
    // If include_all_delegates is true AND this is a delegate, bypass min_vp check
    if (includeAllDelegates && member.isDelegate) {
      return true;
    }
    
    // Otherwise apply minimum voting power filter
    const passes = member.votingPower >= minVotingPower;
    return passes;
  });
  
  return {
    totalMembersCount: daoMembers.length,
    daoMembers: filteredMembers,
    lastUpdatedAt
  };
};

export const getDistributionMetrics = (): DistributionMetricsResponse => {
  const { data: distributionData, lastUpdatedAt } = distributionMetricsManager.getData();
  const { lockers, ...distributionMetrics } = distributionData;
  return {
    metrics: distributionMetrics,
    lastUpdatedAt
  };
};

export const getDistributionMetrics2 = (): DistributionMetricsResponse => {
  const { data: distributionData, lastUpdatedAt } = distributionMetrics2Manager.getData();
  return {
    metrics: distributionData,
    lastUpdatedAt
  };
};

export const getDistributionMetricsHistory = (): DistributionMetricsHistoryResponse => {
  return {
    metrics: historicalDistributionMetrics.data,
    lastUpdatedAt: historicalDistributionMetrics.lastUpdatedAt
  };
};

// Function to get investors and team addresses from vesting schedules
async function getInvestorsAndTeamAddresses(): Promise<string[]> {
  // Step 1: Get vesting sender contracts from transfer instantUnlockEvents
  console.log('Fetching vesting sender contracts from transfer instantUnlockEvents...');
  
  const query = `
    {
      transferEvents(
        where: {
          token: "${config.baseTokenAddress}",
          from: "${config.vestingTreasuryAddress}"
        }
      ) {
        to {
          id
        }
      }
    }
  `;

  const response = await axios.post(config.sfSubgraphUrl, { query });
  const transferEvents = response.data.data.transferEvents;
  
  // Extract unique addresses from transfer instantUnlockEvents
  const senderContracts = new Set<string>();
  for (const event of transferEvents) {
    senderContracts.add(event.to.id.toLowerCase());
  }
  
  const vestingSenderContracts = Array.from(senderContracts);
  console.log(`Found ${vestingSenderContracts.length} vesting sender contracts`);
  
  if (vestingSenderContracts.length === 0) {
    console.log('No vesting sender contracts found, returning empty array');
    return [];
  }
  
  // Step 2: Get receivers of vesting schedules
  console.log('Fetching vesting schedule receivers...');
  const vestingSchedules = await getVestingSchedules(vestingSenderContracts, null);
  console.log(`Found ${vestingSchedules.length} vesting schedules`);
  const receivers = [...new Set(vestingSchedules.map(schedule => schedule.receiver.toLowerCase()))];
  console.log(`Found ${receivers.length} vesting schedule receivers`);
    
  return receivers;
}


// Get SUP vesting schedules with optional filtering by senders and/or receivers
async function getVestingSchedules(
  senders: string[] | null = null,
  receivers: string[] | null = null,
  onlyFlowing: boolean = false,
  blockNumber?: bigint
): Promise<VestingSchedule[]> {
  try {
    const blockClause = blockNumber !== undefined ? `block: { number: ${blockNumber.toString()} },` : '';
    const vestingSchedules = await queryAllPages(
      (lastId) => `{
        vestingSchedules(
          first: 1000,
          ${blockClause}
          where: {
            superToken: "${config.baseTokenAddress}",
            ${onlyFlowing ? 'cliffAndFlowExecutedAt_not: null, endExecutedAt: null,' : ''}
            ${senders?.length ? `sender_in: [${senders.map(addr => `"${addr.toLowerCase()}"`).join(', ')}],` : ''}
            ${receivers?.length ? `receiver_in: [${receivers.map(addr => `"${addr.toLowerCase()}"`).join(', ')}],` : ''}
            id_gt: "${lastId}"
          },
          orderBy: id,
          orderDirection: asc
        ) {
          id
          sender
          receiver
          cliffAndFlowDate
          endDate
          flowRate
          cliffAmount
          remainderAmount
          claimValidityDate
        }
      }`,
      (res) => res.data.data.vestingSchedules,
      (item) => ({
        ...item,
        cliffAndFlowDate: parseInt(item.cliffAndFlowDate),
        endDate: parseInt(item.endDate),
        flowRate: BigInt(item.flowRate),
        cliffAmount: BigInt(item.cliffAmount),
        remainderAmount: BigInt(item.remainderAmount),
        claimValidityDate: parseInt(item.claimValidityDate)
      }),
      config.vestingSubgraphUrl
    );
    return vestingSchedules;
  } catch (error) {
    console.error('Error fetching vesting schedules:', error);
    return [];
  }
}

interface ProgramManagerStreamState {
  streamedUntilUpdatedAt: bigint;
  currentFlowRate: bigint;
  updatedAtTimestamp: number;
  createdAtTimestamp: number;
}

async function sumProgramManagerTransfers(
  direction: 'in' | 'out',
  blockNumber: bigint,
  tokenAddress: string,
  programManager: string
): Promise<bigint> {
  const directionField = direction === 'out' ? 'from' : 'to';
  const transfers = await queryAllPages<bigint>(
    (lastId) => `{
      transferEvents(
        first: 1000,
        block: { number: ${blockNumber.toString()} },
        where: {
          token: "${tokenAddress}",
          ${directionField}: "${programManager}",
          id_gt: "${lastId}"
        },
        orderBy: id,
        orderDirection: asc
      ) {
        id
        value
      }
    }`,
    (res) => res.data.data.transferEvents,
    (item) => BigInt(item.value),
    config.sfSubgraphUrl
  );

  return transfers.reduce((sum, value) => sum + value, 0n);
}

async function fetchProgramManagerStreamsAtBlock(
  direction: 'in' | 'out',
  blockNumber: bigint,
  tokenAddress: string,
  programManager: string
): Promise<ProgramManagerStreamState[]> {
  const directionField = direction === 'out' ? 'sender' : 'receiver';

  return queryAllPages<ProgramManagerStreamState>(
    (lastId) => `{
      streams(
        first: 1000,
        block: { number: ${blockNumber.toString()} },
        where: {
          token: "${tokenAddress}",
          ${directionField}: "${programManager}",
          id_gt: "${lastId}"
        },
        orderBy: id,
        orderDirection: asc
      ) {
        id
        streamedUntilUpdatedAt
        currentFlowRate
        updatedAtTimestamp
        createdAtTimestamp
      }
    }`,
    (res) => res.data.data.streams,
    (item) => ({
      streamedUntilUpdatedAt: BigInt(item.streamedUntilUpdatedAt),
      currentFlowRate: BigInt(item.currentFlowRate),
      updatedAtTimestamp: parseInt(item.updatedAtTimestamp, 10),
      createdAtTimestamp: parseInt(item.createdAtTimestamp, 10)
    }),
    config.sfSubgraphUrl
  );
}

function sumStreamAmounts(streams: ProgramManagerStreamState[], refTimestamp: number): bigint {
  return streams.reduce((total, stream) => {
    if (refTimestamp <= stream.createdAtTimestamp) {
      return total;
    }
    if (stream.updatedAtTimestamp > refTimestamp) {
      return total;
    }
    const deltaSeconds = refTimestamp > stream.updatedAtTimestamp
      ? BigInt(refTimestamp - stream.updatedAtTimestamp)
      : 0n;
    return total + stream.streamedUntilUpdatedAt + stream.currentFlowRate * deltaSeconds;
  }, 0n);
}

// Helper function to calculate lpSupProvided and lpSupCollected from liquidity positions
async function calculateLpSupProvidedAndCollected(blockNumber?: bigint): Promise<{ 
  lpSupProvided: number; 
  lpSupCollected: number;
  liquidityPositions: Array<{ liquidityAmount: string }>;
}> {
  const blockClause = blockNumber !== undefined ? `block: { number: ${blockNumber.toString()} },` : '';
  
  console.log('Fetching liquidity positions...');
  const liquidityPositions = await queryAllPages<{
    id: string;
    locker: { id: string };
    liquidityAmount: string;
    token1AmountProvided: string;
    token1AmountCollected: string | null;
  }>(
    (lastId) => `{
      liquidityPositions(
        first: 1000,
        ${blockClause}
        where: {
          id_gt: "${lastId}"
        },
        orderBy: id,
        orderDirection: asc
      ) {
        id
        locker {
          id
        }
        liquidityAmount
        token1AmountProvided
        token1AmountCollected
      }
    }`,
    (res) => res.data.data.liquidityPositions,
    (item) => ({
      id: item.id,
      locker: { id: item.locker.id },
      liquidityAmount: item.liquidityAmount,
      token1AmountProvided: item.token1AmountProvided,
      token1AmountCollected: item.token1AmountCollected,
    }),
    config.supSubgraphUrl
  );

  const totalToken1AmountProvidedWei = liquidityPositions.reduce((sum, position) => {
    return sum + BigInt(position.token1AmountProvided);
  }, 0n);
  const lpSupProvided = toTokenNumber(totalToken1AmountProvidedWei);

  const totalToken1AmountCollectedWei = liquidityPositions.reduce((sum, position) => {
    return sum + BigInt(position.token1AmountCollected || '0');
  }, 0n);
  const lpSupCollected = toTokenNumber(totalToken1AmountCollectedWei);

  console.log(`  Found ${liquidityPositions.length} liquidity positions, lpSupProvided: ${lpSupProvided}, lpSupCollected: ${lpSupCollected}`);
  
  return { 
    lpSupProvided, 
    lpSupCollected,
    liquidityPositions: liquidityPositions.map(p => ({ liquidityAmount: p.liquidityAmount }))
  };
}

async function calculateDistributionMetricsAtTimestamp(
  timestamp: number,
  baseBlock: bigint,
  ethereumBlock: bigint
): Promise<DistributionMetricsHistoryEntry> {
  const programManagerAddress = config.epProgramManager.toLowerCase();
  const tokenAddress = config.baseTokenAddress.toLowerCase();

  const ethereumClient = createPublicClient({
    chain: mainnet,
    transport: http(config.ethereumRpcUrl, {
      batch: {
        wait: 100
      }
    }),
  });

  const investorsTeamLockedPromise: Promise<bigint> =
    baseBlock >= VESTING_FACTORY_DEPLOYMENT_BLOCK
      ? (viemClient.readContract({
          address: config.vestingFactoryAddress as Address,
          abi: SUP_VESTING_FACTORY_ABI,
          functionName: 'totalSupply',
          args: [],
          blockNumber: baseBlock
        }) as Promise<bigint>).catch(() => 0n)
      : Promise.resolve<bigint>(0n);

  const [
    programManagerBalance,
    communityChargeBalance,
    investorsTeamLockedWei,
    daoTreasuryBalanceWei,
    sprProgramManagerBalanceWei,
    vestingTreasuryBalanceWei,
    taxDistributionUnits,
    supCorpTreasuryBalanceWei,
    supCorpOpsBalanceWei,
  ] = await Promise.all([
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.epProgramManager as Address],
      blockNumber: baseBlock
    }),
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.stakingRewardControllerAddress as Address],
      blockNumber: baseBlock
    }),
    investorsTeamLockedPromise,
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.daoTreasuryAddress as Address],
      blockNumber: baseBlock
    }),
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.epProgramManager as Address],
      blockNumber: baseBlock
    }),
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.vestingTreasuryAddress as Address],
      blockNumber: baseBlock
    }),
    viemClient.readContract({
      address: config.taxDistributionPool as Address,
      abi: SUPERFLUID_POOL_ABI,
      functionName: 'getTotalUnits',
      args: [],
      blockNumber: baseBlock
    }),
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.supCorpTreasuryAddress as Address],
      blockNumber: baseBlock
    }),
    viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.supCorpOpsAddress as Address],
      blockNumber: baseBlock
    })
  ]);

  // derive reserve balances: what went into programManager minuts its current balance
  const [transfersOutWei, transfersInWei] = await Promise.all([
    sumProgramManagerTransfers('out', baseBlock, tokenAddress, programManagerAddress),
    sumProgramManagerTransfers('in', baseBlock, tokenAddress, programManagerAddress)
  ]);
  console.log(`  transfersOutWei: ${transfersOutWei.toString()}, transfersInWei: ${transfersInWei.toString()}`);

  const [streamsOut, streamsIn] = await Promise.all([
    fetchProgramManagerStreamsAtBlock('out', baseBlock, tokenAddress, programManagerAddress),
    fetchProgramManagerStreamsAtBlock('in', baseBlock, tokenAddress, programManagerAddress)
  ]);
  // log streamsOut
  console.log(`  streamsOut at block ${baseBlock.toString()}: ${safeStringify(streamsOut, 2)}`);

  const streamedOutWei = sumStreamAmounts(streamsOut, timestamp);
  const streamedInWei = sumStreamAmounts(streamsIn, timestamp);

  console.log(`transfersOutWei: ${transfersOutWei.toString()}, streamedOutWei: ${streamedOutWei.toString()}`);

  const reserveBalances = toTokenNumber(transfersInWei + streamedInWei - programManagerBalance);

  const foundationTreasuryBalanceWei = await ethereumClient.readContract({
    address: config.ethereumTokenAddress as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [config.foundationTreasuryAddress as Address],
    blockNumber: ethereumBlock
  });

  const supCorpTreasuryEthereumBalanceWei = await ethereumClient.readContract({
    address: config.ethereumTokenAddress as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [config.supCorpTreasuryAddress as Address],
    blockNumber: ethereumBlock
  });

  const supCorpOpsEthereumBalanceWei = await ethereumClient.readContract({
    address: config.ethereumTokenAddress as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [config.supCorpOpsAddress as Address],
    blockNumber: ethereumBlock
  });

  console.log(`  supCorpTreasuryEthereumBalanceWei: ${supCorpTreasuryEthereumBalanceWei.toString()}, supCorpOpsEthereumBalanceWei: ${supCorpOpsEthereumBalanceWei.toString()}`);

  const stakedSup = Number(taxDistributionUnits as bigint);
  const communityCharge = toTokenNumber(communityChargeBalance as bigint);
  const investorsTeamLocked = toTokenNumber(investorsTeamLockedWei as bigint);
  const daoTreasuryUnlocked = toTokenNumber(daoTreasuryBalanceWei as bigint);
  const daoSPRProgramManager = toTokenNumber(sprProgramManagerBalanceWei as bigint);
  const vestingTreasury = toTokenNumber(vestingTreasuryBalanceWei as bigint);
  const foundationTreasury = toTokenNumber(foundationTreasuryBalanceWei as bigint);
  // SUP corp treasury on Ethereum is considered ops
  const supCorpOps = toTokenNumber(supCorpOpsBalanceWei + supCorpOpsEthereumBalanceWei + supCorpTreasuryEthereumBalanceWei);
  console.log(`  supCorpOps: ${supCorpOps}, supCorpOpsBalanceWei: ${supCorpOpsBalanceWei.toString()}, supCorpOpsEthereumBalanceWei: ${supCorpOpsEthereumBalanceWei.toString()}, supCorpTreasuryEthereumBalanceWei: ${supCorpTreasuryEthereumBalanceWei.toString()}`);

  const vestingSchedules = await getVestingSchedules(null, [config.daoTreasuryAddress], true, baseBlock);
  let totalVestingAmount = 0n;
  for (const schedule of vestingSchedules) {
    if (schedule.endDate > timestamp) {
      const timeRemaining = schedule.endDate - timestamp;
      if (timeRemaining > 0) {
        totalVestingAmount += schedule.flowRate * BigInt(timeRemaining);
      }
    }
  }
  // before the vesting was created, all the amount of supCorpTreasury shall be associated to DAO locked
  const daoTreasuryLocked = totalVestingAmount === 0n ? toTokenNumber(supCorpTreasuryBalanceWei as bigint) : toTokenNumber(totalVestingAmount);
  const daoTreasury = daoTreasuryUnlocked + daoTreasuryLocked;

  // Query instant unlock events from SUP subgraph
  console.log('Fetching instant unlock events...');
  const instantUnlocks = await queryAllPages<{
    locker: { id: string };
    netAmount: bigint;
  }>(
    (lastId) => `{
      instantUnlocks(
        first: 1000,
        block: { number: ${baseBlock.toString()} },
        where: {
          id_gt: "${lastId}"
        },
        orderBy: id,
        orderDirection: asc
      ) {
        id
        locker {
          id
        }
        netAmount
      }
    }`,
    (res) => res.data.data.instantUnlocks,
    (item) => ({
      locker: { id: item.locker.id },
      netAmount: BigInt(item.netAmount)
    }),
    config.supSubgraphUrl
  );

  // Sum up netAmount values (the 20% that recipients actually received)
  const totalInstantUnlockedWei = instantUnlocks.reduce((sum, unlock) => sum + unlock.netAmount, 0n);
  const instantUnlocked = toTokenNumber(totalInstantUnlockedWei);
  const tax = toTokenNumber(totalInstantUnlockedWei * BigInt(4));

  // Count distinct lockers that performed instant unlocks
  const distinctLockers = new Set(instantUnlocks.map(unlock => unlock.locker.id.toLowerCase()));
  const reservesWithInstantUnlock = distinctLockers.size;

  console.log(`  Found ${instantUnlocks.length} instant unlock events from ${reservesWithInstantUnlock} distinct lockers, total netAmount: ${instantUnlocked}`);

  // Calculate lpSupProvided and lpSupCollected
  const { lpSupProvided, lpSupCollected, liquidityPositions } = await calculateLpSupProvidedAndCollected(baseBlock);

  console.log('Fetching Uniswap V3 pool price...');
  const poolSlot0 = await viemClient.readContract({
    address: config.uniswapV3PoolAddress as Address,
    abi: UNISWAP_V3_POOL_ABI,
    functionName: 'slot0',
    blockNumber: baseBlock
  });
  const sqrtPriceX96 = poolSlot0[0] as bigint;
  console.log(`Pool sqrtPriceX96 at block ${baseBlock.toString()}: ${sqrtPriceX96.toString()}`);

  const Q96 = 1n << 96n;
  const MIN_SQRT_RATIO = 4295128739n;

  // Sum up all liquidity amounts
  const totalLiquidityWei = liquidityPositions.reduce((sum, position) => {
    return sum + BigInt(position.liquidityAmount);
  }, 0n);

  // Calculate SUP amount: amount1 = L * (sqrtPriceX96 - MIN_SQRT_RATIO) / Q96
  const lpSupWei = (totalLiquidityWei * (sqrtPriceX96 - MIN_SQRT_RATIO)) / Q96;
  const lpSup = toTokenNumber(lpSupWei);

  console.log(`  Calculated lpSup: ${lpSup}`);

  // Query fontaines and calculate streaming out
  console.log('Fetching fontaines...');
  const fontaines = await queryAllPages<{
    id: string;
    locker: { id: string };
    recipient: string;
    unlockAmount: string;
    unlockPeriod: string;
    blockTimestamp: string;
    endDate: string;
    unlockFlowRate: string;
  }>(
    (lastId) => `{
      fontaines(
        first: 1000,
        block: { number: ${baseBlock.toString()} },
        where: {
          id_gt: "${lastId}"
        },
        orderBy: id,
        orderDirection: asc
      ) {
        id
        locker {
          id
        }
        recipient
        unlockAmount
        unlockPeriod
        blockTimestamp
        endDate
        unlockFlowRate
      }
    }`,
    (res) => res.data.data.fontaines,
    (item) => ({
      id: item.id,
      locker: { id: item.locker.id },
      recipient: item.recipient,
      unlockAmount: item.unlockAmount,
      unlockPeriod: item.unlockPeriod,
      blockTimestamp: item.blockTimestamp,
      endDate: item.endDate,
      unlockFlowRate: item.unlockFlowRate
    }),
    config.supSubgraphUrl
  );

  console.log(`Found ${fontaines.length} fontaines`);

  let totalStreamingOut = 0n;
  let totalStreamUnlocked = 0n;

  for (const fontaine of fontaines) {
    const fontaineBlockTimestamp = parseInt(fontaine.blockTimestamp, 10);
    const endDate = parseInt(fontaine.endDate, 10);
    const unlockAmount = BigInt(fontaine.unlockAmount);
    const unlockFlowRate = BigInt(fontaine.unlockFlowRate);

    // Verification check: unlockFlowRate * (endDate - blockTimestamp) == unlockAmount
    const expectedUnlockAmount = unlockFlowRate * BigInt(endDate - fontaineBlockTimestamp);
    // unlockAmount can be slightly larger due to rounding, but not more than 1 second of unlockFlowRate
    if (unlockAmount < expectedUnlockAmount || unlockAmount - expectedUnlockAmount > unlockFlowRate) {
      throw new Error(
        `Fontaine ${fontaine.id} verification failed: ` +
        `unlockFlowRate * (endDate - blockTimestamp) = ${expectedUnlockAmount.toString()} != unlockAmount = ${unlockAmount.toString()}, unlockFlowRate = ${unlockFlowRate.toString()}`
      );
    }

    // Throw error if snapshot timestamp is before fontaine started
    if (timestamp < fontaineBlockTimestamp) {
      throw new Error(
        `Snapshot timestamp ${timestamp} is before fontaine ${fontaine.id} blockTimestamp ${fontaineBlockTimestamp}`
      );
    }

    // Calculate how much has been streamed
    let streamed: bigint;
    if (timestamp >= endDate) {
      // Fully streamed
      streamed = unlockAmount;
    } else {
      // Partially streamed
      const timeElapsed = BigInt(timestamp - fontaineBlockTimestamp);
      streamed = unlockFlowRate * timeElapsed;
    }

    const remaining = unlockAmount - streamed;
    totalStreamingOut += remaining;
    totalStreamUnlocked += streamed;
  }

  const streamingOut = toTokenNumber(totalStreamingOut);
  const streamUnlocked = toTokenNumber(totalStreamUnlocked);
  console.log(`  Calculated streamingOut: ${streamingOut}, streamUnlocked: ${streamUnlocked}`);

  const lockerBalances = reserveBalances - (stakedSup + lpSup + streamingOut + instantUnlocked + streamUnlocked + tax);

  const totalSupply = 1000000000;
  const otherRaw = totalSupply -
    (reserveBalances + communityCharge + investorsTeamLocked + daoTreasury + foundationTreasury + daoSPRProgramManager + vestingTreasury + supCorpOps);
  const other = otherRaw < 0 ? 0 : otherRaw;

  return {
    timestamp,
    reserveBalances,
    lockerBalances,
    stakedSup,
    lpSup,
    lpSupProvided,
    lpSupCollected,
    streamingOut,
    communityCharge,
    investorsTeamLocked,
    daoTreasury,
    daoTreasuryUnlocked,
    daoTreasuryLocked,
    daoSPRProgramManager,
    foundationTreasury,
    vestingTreasury,
    supCorpOps,
    other,
    totalSupply,
    // Historical calculations don't process individual lockers, so these are set to 0
    reservesWithFontaines: 0,
    reservesWithStake: 0,
    reservesWithLiquidity: 0,
    reservesWithInstantUnlock,
    reservesWithNone: 0,
    instantUnlocked,
    streamUnlocked,
    tax,
    stakeCooldownProjection: []
  };
}

async function fetchHistoricalDistributionMetrics(
  startTimestamp: number,
  endTimestamp: number,
  stepSeconds: number = 86400 * 7
): Promise<DistributionMetricsHistoryEntry[]> {
  if (endTimestamp < startTimestamp) {
    return [];
  }

  console.log(`Starting historical distribution metrics fetch from ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(endTimestamp * 1000).toISOString()}`);

  const snapshots: DistributionMetricsHistoryEntry[] = [];

  const ethereumClient = createPublicClient({
    chain: mainnet,
    transport: http(config.ethereumRpcUrl, {
      batch: {
        wait: 100
      }
    }),
  });

  const latestBaseBlock = await viemClient.getBlockNumber();
  const latestEthereumBlock = await ethereumClient.getBlockNumber();

  let previousBaseBlock = 0n;
  let previousEthereumBlock = 0n;

  for (let timestamp = startTimestamp; timestamp <= endTimestamp; timestamp += stepSeconds) {
    try {
      console.log(`Calculating historical distribution metrics for ${new Date(timestamp * 1000).toISOString().slice(0, 10)}`);

      const baseBlock = await getBlockNumberAtOrBefore(
        viemClient,
        timestamp,
        baseBlockNumberCache,
        previousBaseBlock,
        latestBaseBlock,
        BASE_BLOCK_TIME_SECONDS
      );
      const ethereumBlock = await getBlockNumberAtOrBefore(
        ethereumClient,
        timestamp,
        ethereumBlockNumberCache,
        previousEthereumBlock,
        latestEthereumBlock,
        ETHEREUM_BLOCK_TIME_SECONDS
      );

      previousBaseBlock = baseBlock;
      previousEthereumBlock = ethereumBlock;

      const snapshot = await calculateDistributionMetricsAtTimestamp(timestamp, baseBlock, ethereumBlock);
      snapshots.push(snapshot);
      console.log(`[HistoricalMetrics] Snapshot for ${new Date(timestamp * 1000).toISOString().slice(0, 10)}: ${safeStringify(snapshot, 2)}`);
    } catch (error) {
      // Silently swallow errors and continue to next timestamp
      console.warn(`Skipping timestamp ${timestamp} due to error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return snapshots;
}

async function refreshHistoricalDistributionMetricsIfNeeded(): Promise<void> {
  const refreshFlag = process.env.REFRESH_HISTORICAL_STATE;
  if (!refreshFlag || refreshFlag.toLowerCase() !== 'true') {
    return;
  }

  try {
    // TODO: make configurable
    const startTimestamp = Math.floor(Date.UTC(2025, 1, 19, 0, 0, 0) / 1000);
    const now = new Date();
    const endTimestamp = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) / 1000);

    const historicalSnapshots = await fetchHistoricalDistributionMetrics(startTimestamp, endTimestamp);
    const lastUpdatedAt = Math.floor(Date.now() / 1000);

    const payload: MetricsData<DistributionMetricsHistoryEntry[]> = {
      schemaVersion: DISTRIBUTION_METRICS_HISTORY_FILE_SCHEMA_VERSION,
      lastUpdatedAt,
      data: historicalSnapshots
    };

    historicalDistributionMetrics = payload;
    saveHistoricalDistributionMetricsToDisk(payload);
  } catch (error) {
    console.error('Failed to refresh historical distribution metrics:', error);
  }
}

export const getVotingPowerBatch = async (addresses: string[], includeDelegations: boolean): Promise<VotingPower[]> => {
  const spaceConfig = await getSpaceConfig();

  const strategies = includeDelegations ? 
    spaceConfig.strategies : 
    spaceConfig.strategies.filter(strategy => strategy.name !== "delegation");
  
  try {
    const chunks = [];
    for (let i = 0; i < addresses.length; i += config.vpCalcChunkSize) {
      chunks.push(addresses.slice(i, i + config.vpCalcChunkSize));
    }
    
    console.log(`Processing ${addresses.length} addresses in ${chunks.length} chunks of max ${config.vpCalcChunkSize}`);
    
    // Process each chunk and combine results
    const allScores: any[] = [{}, {}, {}]; // 0: fountainhead, 1: delegate, 2: vsup
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      process.stdout.write(`Processing chunk ${i+1}/${chunks.length} (${chunk.length} addresses)...`);
      const startTime = Date.now();

      const provider = viemClientToEthersV5Provider(viemClient);
      
      const chunkScores = await snapshotStrategies.utils.getScoresDirect(
        config.snapshotSpace, // space
        strategies, // strategies
        spaceConfig.network, // network
        provider, // provider
        chunk, // addresses (just this chunk)
        'latest' // snapshot?
      );
      
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;
      console.log(` completed in ${duration.toFixed(2)}s`);
      
      // Merge scores from this chunk into the corresponding strategy arrays
      chunkScores.forEach((strategyScores, strategyIndex) => {
        Object.assign(allScores[strategyIndex], strategyScores);
      });
      
      // uncomment for debugging
      //fs.writeFileSync(`scores_chunk_${i}.json`, JSON.stringify(chunkScores, null, 2));
    }

    // uncomment for debugging
    //fs.writeFileSync('scores.json', JSON.stringify(allScores, null, 2));
    const scoresFountainhead = allScores[0];
    const scoresDelegation = includeDelegations ? allScores[1] : {};
    const scoresVsup = includeDelegations ? allScores[2] : allScores[1];

    // Process the scores according to the required format
    const result: VotingPower[] = addresses.map(address => {
      const addressLower = address.toLowerCase();

      return {
        address: addressLower,
        own: (scoresFountainhead[addressLower] || 0) + (scoresVsup[addressLower] || 0),
        delegated: scoresDelegation[addressLower]
      };
    });

    return result;
  } catch (error) {
    console.error(formatAxiosError(error, 'Error fetching voting power for batch'));
    throw error;
  }
}

export const getVotingPower = async (address: string): Promise<VotingPower> => {
  const spaceConfig = await getSpaceConfig();

  try {
    const scoreApiPayload = {
      jsonrpc: "2.0",
      method: "get_vp",
      params: {
        address: address.toLowerCase(),
        space: config.snapshotSpace,
        strategies: spaceConfig.strategies,
        network: spaceConfig.network,
        snapshot: "latest"
      }
    };

    const response = await axios.post(config.snapshotScoreUrl, scoreApiPayload);
    if (response.data?.result?.vp) {
      const totalVp = response.data.result.vp;
      // TODO: add check that item 0 is indeed the own voting power
      const ownVp = response.data.result.vp_by_strategy[0] + response.data.result.vp_by_strategy[2];
      const delegatedVp = response.data.result.vp_by_strategy[1];
      if (totalVp - ownVp !== delegatedVp) {
        console.error(`Voting power for ${address}: ${totalVp} (delegated: ${delegatedVp}, own: ${ownVp})`);
        throw new Error(`Voting power for ${address} is not consistent`);
      }
      console.log(`Voting power for ${address}: ${totalVp} (delegated: ${delegatedVp}, own: ${ownVp})`);
      //console.log(`Voting power raw for ${address}: ${JSON.stringify(response.data.result, null, 2)}`);
      console.log(`  get_vp ${address} returned: ${JSON.stringify(response.data.result, null, 2)}`);
      return {
        address: address.toLowerCase(),
        own: ownVp,
        delegated: delegatedVp
      };
    }

    return {
      address: address.toLowerCase(),
      own: 0,
      delegated: 0
    };
  } catch (error) {
    console.error(formatAxiosError(error, `Error fetching voting power for ${address}`));
    throw error;
  }
};

/**
 * Gets the voting power for a specific account using snapshot.js
 * @param locker The address to get voting power for
 * @param useOwnStrategies If true, uses only the first strategy without delegation
 * @returns The voting power as a number
 */
export const getAccountVotingPower = async (locker: string, useOwnStrategies: boolean = false): Promise<number> => {
  const spaceConfig = await getSpaceConfig();
  
  try {
    // Set up snapshot options
    const options = {
      url: config.snapshotScoreUrl
    };
    
    // Define strategies - either use all strategies or just the first one without delegation
    const strategies = useOwnStrategies ? [spaceConfig.strategies[0]] : spaceConfig.strategies;
    
    // Get voting power for the account address
    const vp = await snapshot.utils.getVp(
      locker,
      spaceConfig.network,
      strategies,
      'latest', // Use latest snapshot
      config.snapshotSpace,
      false, // No delegation
      options
    );
    
    return vp.vp || 0; // Return voting power or 0 if undefined
  } catch (error) {
    console.error(`### Error fetching voting power for ${locker}:`, error);
    return 0; // Return 0 on error
  }
};

export const getDelegateForUser = async (address: string): Promise<string | null> => {
  const query = `
    {
      delegations(first: 1, where: {
        space: "${config.snapshotSpace}",
        delegator: "${address.toLowerCase()}"
      }, orderBy: timestamp, orderDirection: desc) {
        delegate
      }
    }
    `;

  try {
    const subgraphUrl = `https://gateway.thegraph.com/api/${config.graphNetworkApiKey}/subgraphs/id/${config.delegationSubgraphId}`;
    const response = await axios.post(subgraphUrl, { query });

    const delegations = response.data.data.delegations;
    return delegations.length > 0 ? delegations[0].delegate : null;
  } catch (error) {
    console.error(formatAxiosError(error, `Error fetching delegate for ${address}`));
    throw error;
  }
};

/**
 * Gets the total score calculated from flow distributions for pools managed by EP Program Manager
 */
export const getTotalScore = async (): Promise<TotalScoreResponse> => {
  try {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    console.log(`Current timestamp: ${currentTimestamp}`);
    
    const query = `
      query {
        flowDistributionUpdatedEvents(
          where: {poolDistributor_: {account: "${config.epProgramManager.toLowerCase()}"}}
        ) {
          pool {
            id
            flowRate
            totalAmountDistributedUntilUpdatedAt
            updatedAtTimestamp
          }
        }
      }
    `;

    const response = await axios.post(config.sfSubgraphUrl, { query });
    const instantUnlockEvents = response.data.data.flowDistributionUpdatedEvents;
    
    console.log(`Found ${instantUnlockEvents.length} flow distribution instantUnlockEvents`);
    // log full detail
//    console.log(JSON.stringify(response.data.data, null, 2));
    
    // Create a Map to store unique pools by ID
    const uniquePools = new Map();
    
    // Process instantUnlockEvents and keep only the most recent event for each pool
    for (const event of instantUnlockEvents) {
      const pool = event.pool;
      const poolId = pool.id;
      
      // If we haven't seen this pool before, or if this event is more recent than what we have, keep it
      // (it shouldn't matter which one we pick, semantics should be that of a pointer)
      if (!uniquePools.has(poolId) || parseInt(pool.updatedAtTimestamp) > parseInt(uniquePools.get(poolId).updatedAtTimestamp)) {
        uniquePools.set(poolId, pool);
      }
    }
    
    let totalScore = BigInt(config.additionalTotalVp) * BigInt(10 ** 18);
    
    // Process only unique pools
    for (const pool of uniquePools.values()) {
      const poolId = pool.id;
      const flowRate = BigInt(pool.flowRate);
      const totalAmountDistributedUntilUpdatedAt = BigInt(pool.totalAmountDistributedUntilUpdatedAt);
      const updatedAtTimestamp = parseInt(pool.updatedAtTimestamp);
      
      const timeElapsed = currentTimestamp - updatedAtTimestamp;
      const additionalAmount = flowRate * BigInt(timeElapsed);
      const totalAmountDistributed = totalAmountDistributedUntilUpdatedAt + additionalAmount;
      
      totalScore += totalAmountDistributed;
    }
    
    console.log(`Total Score: ${totalScore.toString()}`);
    
    // Convert BigInt to Number for JSON serialization
    // Dividing by 10^18 to get a more manageable number (assuming 18 decimals)
    const totalScoreNormalized = Number(totalScore / BigInt(10 ** 18));
    
    return {
      totalScore: totalScoreNormalized,
      lastUpdatedAt: currentTimestamp
    };
  } catch (error) {
    console.error(formatAxiosError(error, 'Error fetching total score'));
    throw error;
  }
};

async function fetchVotingMetrics(): Promise<Record<string, MemberData>> {
  try {
    console.log('Starting voting metrics fetch...');
    const currentTimestamp = Math.floor(Date.now() / 1000);
    
    // 1. Get members of pools (lockers) funded via EP Program Manager flow distributions
    const query = `
      query {
        flowDistributionUpdatedEvents(
          first: 1000,
          where: {poolDistributor_: {account: "${config.epProgramManager.toLowerCase()}"}}
        ) {
          pool {
            id
          }
        }
      }
    `;

    const response = await axios.post(config.sfSubgraphUrl, { query });
    const instantUnlockEvents = response.data.data.flowDistributionUpdatedEvents;
    
    console.log(`Found ${instantUnlockEvents.length} flow distribution instantUnlockEvents`);
    
    // Create a Set to store unique pool IDs
    const uniquePools = new Set();
    for (const event of instantUnlockEvents) {
      uniquePools.add(event.pool.id);
    }
    
    console.log(`Found ${uniquePools.size} unique pools`);
    
    // Map for locker -> owner mapping
    const lockerToOwnerMap = new Map<string, string>();
  
    // Set of accounts to be considered (snapshot doesn't know the set of voting power holders)
    const uniqueAccounts = new Set<string>();
    

    // Get investors and team addresses dynamically from vesting schedules
    const investorsAndTeam = await getInvestorsAndTeamAddresses();
    console.log(`Adding ${investorsAndTeam.length} investors and team addresses to unique accounts`);
    investorsAndTeam.forEach(address => uniqueAccounts.add(address.toLowerCase()));
    
    // Get all pool members (which are lockers)
    for (const poolId of uniquePools) {
      console.log(`Getting members for pool ${poolId} ...`);

      const poolMembers = await queryAllPages(
        (lastId) => `{
          poolMembers(
            first: 1000,
            where: {
              pool: "${poolId}",
              id_gt: "${lastId}"
            },
            orderBy: id,
            orderDirection: asc
          ) {
            id
            account {
              id
            }
          }
        }`,
        (res) => res.data.data.poolMembers,
        (item) => item.account.id,
        config.sfSubgraphUrl
      );
      console.log(`Found ${poolMembers.length} pool members for pool ${poolId}, now getting owners...`);
      
      // Get owners for each locker
      const ownerPromises = poolMembers.map(locker => 
        viemClient.readContract({
          address: locker as Address,
          abi: LOCKER_ABI,
          functionName: 'lockerOwner',
          args: []
        }).catch(error => {
          // this is allowed to fail because it's possible to have pool members that are not lockers
          return { error: true, address: locker, errorMessage: error.message };
        })
      );
        
      const results = await Promise.allSettled(ownerPromises);
      console.log(`Found ${results.length} owners for pool ${poolId}`);
      
      // Collect failed addresses for summary logging
      const failedAddresses: string[] = [];
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          if (result.value && typeof result.value === 'object' && 'error' in result.value) {
            // This is an error result
            failedAddresses.push(result.value.address);
          } else if (result.value !== null) {
            // This is a successful result
            const owner = result.value as Address;
            const lockerAddress = poolMembers[i];
            lockerToOwnerMap.set(lockerAddress.toLowerCase(), owner.toLowerCase());
            uniqueAccounts.add(owner.toLowerCase());
          }
        }
      }
      
      // Print summary of failed addresses if any
      if (failedAddresses.length > 0) {
        console.log(`### Failed to get lockerOwner for ${failedAddresses.length} addresses: ${failedAddresses.join(', ')}`);
      }
    }

    // 2. Get delegations
    console.log(`Fetching delegations...`);
    const delegations = await queryAllPages(
      (lastId) => `{
        delegations(
          first: 1000,
          where: {
            space: "${config.snapshotSpace}",
            id_gt: "${lastId}"
          },
          orderBy: id,
          orderDirection: asc
        ) {
          id
          delegator
          delegate
        }
      }`,
      (res) => res.data.data.delegations,
      (item) => item,
      `https://gateway.thegraph.com/api/${config.graphNetworkApiKey}/subgraphs/id/${config.delegationSubgraphId}`
    );

    // Add delegators and delegates to unique accounts
    for (const delegation of delegations) {
      uniqueAccounts.add(delegation.delegator.toLowerCase());
      uniqueAccounts.add(delegation.delegate.toLowerCase());
    }

    // 3. Get own voting power for all accounts (without delegations)
    const uniqueAccountsArray = Array.from(uniqueAccounts);
    console.log(`Fetching own voting power for ${uniqueAccountsArray.length} accounts...`);
    const ownVotingPowers = await getVotingPowerBatch(uniqueAccountsArray, false);

    // 4. Calculate delegated voting power
    const delegatedVotingPower = new Map<string, number>();
    const delegatorCount = new Map<string, number>();

    for (const delegation of delegations) {
      const delegator = delegation.delegator.toLowerCase();
      const delegate = delegation.delegate.toLowerCase();
      
      // Find delegator's own voting power
      const delegatorVp = ownVotingPowers.find(vp => vp.address === delegator);
      if (delegatorVp) {
        // Add delegator's voting power to delegate's total
        const currentDelegatedVp = delegatedVotingPower.get(delegate) || 0;
        delegatedVotingPower.set(delegate, currentDelegatedVp + delegatorVp.own);
        
        // Increment delegator count
        const currentCount = delegatorCount.get(delegate) || 0;
        delegatorCount.set(delegate, currentCount + 1);
      }
    }

    // 5. Compile final data structure
    const data: Record<string, MemberData> = {};
    
    // Process voting powers
    for (const vp of ownVotingPowers) {
      // Find the locker for this account by searching the lockerToOwnerMap
      let locker: string | undefined;
      for (const [lockerAddress, owner] of lockerToOwnerMap.entries()) {
        if (owner === vp.address) {
          locker = lockerAddress;
          break;
        }
      }
      
      const memberData: MemberData = {
        ownVp: vp.own,
        locker
      };

      // Add delegated voting power if this account is a delegate
      const delegatedVp = delegatedVotingPower.get(vp.address);
      if (delegatedVp && delegatedVp > 0) {
        memberData.delegatedVp = delegatedVp;
        memberData.nrDelegators = delegatorCount.get(vp.address) || 0;
      }
      
      data[vp.address] = memberData;
    }

    // Process delegations to add delegate info
    for (const delegation of delegations) {
      const delegator = delegation.delegator.toLowerCase();
      const delegate = delegation.delegate.toLowerCase();
      
      // Add delegate info to delegator
      if (data[delegator]) {
        data[delegator].delegate = delegate;
      }
    }

    // Sort data by total VP (ownVp + delegatedVp) descending
    const sortedEntries = Object.entries(data).sort(([, a], [, b]) => {
      const aTotal = a.ownVp + (a.delegatedVp || 0);
      const bTotal = b.ownVp + (b.delegatedVp || 0);
      return bTotal - aTotal;
    });

    // Create new sorted object
    const sortedData: Record<string, MemberData> = {};
    for (const [address, memberData] of sortedEntries) {
      sortedData[address] = memberData;
    }

    return sortedData;

  } catch (error) {
    console.error(formatAxiosError(error, 'Error fetching voting metrics'));
    throw error;
  }
}

async function fetchDistributionMetrics(): Promise<DistributionMetrics> {
  try {
    console.log('Starting distribution metrics fetch...');
    const currentTimestamp = Math.floor(Date.now() / 1000);
    
    // Initialize metrics with default values
    const metrics: DistributionMetrics = {
      ...createDefaultDistributionMetrics(),
      lockers: []
    };

    // Get community charge (StakingRewardController balance)
    console.log('Fetching community charge...');
    const communityChargeBalance = await viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.stakingRewardControllerAddress as Address]
    });
    metrics.communityCharge = Number((communityChargeBalance as bigint) / BigInt(10 ** 18));

    // Get investors/team locked SUP (SupVestingFactory totalSupply)
    console.log('Fetching investors/team locked SUP...');
    const vestingTotalSupply = await viemClient.readContract({
      address: config.vestingFactoryAddress as Address,
      abi: SUP_VESTING_FACTORY_ABI,
      functionName: 'totalSupply',
      args: []
    });
    metrics.investorsTeamLocked = Number((vestingTotalSupply as bigint) / BigInt(10 ** 18));

    // Get DAO Treasury balance and vesting schedule amounts
    console.log('Fetching DAO Treasury balance and vesting schedules...');
    const daoTreasuryBalance = await viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.daoTreasuryAddress as Address]
    });
    
    // Get flowing vesting schedules for DAO treasury
    const vestingSchedules = await getVestingSchedules(null, [config.daoTreasuryAddress], true);

    // Calculate remaining amount to be streamed from vesting schedules
    let totalVestingAmount = BigInt(0);
    const now = Math.floor(Date.now() / 1000);
    
    for (const schedule of vestingSchedules) {
      // Only calculate if the schedule hasn't ended yet
      if (schedule.endDate > now) {
        const timeRemaining = schedule.endDate - now;
        const remainingAmount = schedule.flowRate * BigInt(timeRemaining);
        totalVestingAmount += remainingAmount;
        
        console.log(`DAO treasury is receiving a scheduled flow from ${schedule.sender} with flowRate=${schedule.flowRate.toString()}, timeRemaining=${timeRemaining}s, remainingAmount=${remainingAmount.toString()}`);
      }
    }
    
    // Add current balance + remaining vesting amount
    const currentBalance = Number((daoTreasuryBalance as bigint) / BigInt(10 ** 18));
    const remainingVestingAmount = Number(totalVestingAmount / BigInt(10 ** 18));
    metrics.daoTreasury = currentBalance + remainingVestingAmount;
    metrics.daoTreasuryUnlocked = currentBalance;
    metrics.daoTreasuryLocked = remainingVestingAmount;
    
    console.log(`DAO Treasury: current balance=${currentBalance}, remaining vesting=${remainingVestingAmount}, total=${metrics.daoTreasury}`);

    // Get SUP owned by the SPR Program Manager
    console.log('Fetching SUP owned by the SPR Program Manager...');
    const sprProgramManagerBalance = await viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.epProgramManager as Address]
    });
    metrics.daoSPRProgramManager = Number((sprProgramManagerBalance as bigint) / BigInt(10 ** 18));

    console.log(`SPR Program Manager: balance=${metrics.daoSPRProgramManager}`);

    // Get SUP owner by the Vesting Treasury
    console.log('Fetching SUP owner by the Vesting Treasury...');
    const vestingTreasuryBalance = await viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.vestingTreasuryAddress as Address]
    });
    metrics.vestingTreasury = Number((vestingTreasuryBalance as bigint) / BigInt(10 ** 18));


    const ethereumViemClient = createPublicClient({
      chain: mainnet,
      transport: http(config.ethereumRpcUrl, {
        batch: {
          wait: 100
        }
      }),
    });

    // Get SUP owned by the Corp ops on Ethereum
    console.log('Fetching SUP owned by the Corp ops on Ethereum...');
    const supCorpOpsEthereumBalance = await ethereumViemClient.readContract({
      address: config.ethereumTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.supCorpOpsAddress as Address]
    });
    // Get SUP owned by the Corp ops on Base
    console.log('Fetching SUP owned by the Corp ops on Base...');
    const supCorpOpsBaseBalance = await viemClient.readContract({
      address: config.baseTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.supCorpOpsAddress as Address]
    });

    metrics.supCorpOps = Number((supCorpOpsEthereumBalance + supCorpOpsBaseBalance as bigint) / BigInt(10 ** 18));

    // Get Foundation Treasury balance (on Ethereum)
    console.log('Fetching Foundation Treasury balance...');
    const foundationTreasuryBalance = await ethereumViemClient.readContract({
      address: config.ethereumTokenAddress as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [config.foundationTreasuryAddress as Address]
    });
    metrics.foundationTreasury = Number((foundationTreasuryBalance as bigint) / BigInt(10 ** 18));

    // Get all locker addresses from the locker subgraph
    console.log('Fetching locker addresses from subgraph...');
    const lockers = await queryAllPages(
      (lastId) => `{
        lockers(
          first: 1000,
          where: { id_gt: "${lastId}" }
          orderBy: id,
          orderDirection: asc
        ) {
          id
        }
      }`,
      (res) => res.data.data.lockers,
      (item) => item.id,
      config.supSubgraphUrl
    );

    console.log(`Found ${lockers.length} lockers`);

    // Get sqrtPriceX96 once from the Uniswap V3 pool
    console.log('Fetching Uniswap V3 pool price...');
    const poolSlot0 = await viemClient.readContract({
      address: config.uniswapV3PoolAddress as Address,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'slot0',
    });
    const sqrtPriceX96 = poolSlot0[0] as bigint;
    console.log(`Pool sqrtPriceX96: ${sqrtPriceX96.toString()}`);

    // Constants for LP calculation
    const Q96 = 1n << 96n;
    const MIN_SQRT_RATIO = 4295128739n;

    const batchSize = 100;
    // Map locker address -> {owner, staked, lp, fontaines, available, unlocksAt, instantUnlocked, streamUnlocked, tax}
    const lockerMap = new Map<string, {
      owner: string, 
      staked: bigint, 
      lp: bigint, 
      fontaines: bigint, 
      available: bigint, 
      unlocksAt: bigint | null,
      instantUnlocked: bigint,
      streamUnlocked: bigint,
      tax: bigint
    }>();

    for (let i = 0; i < lockers.length; i += batchSize) {
      const batch = lockers.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(lockers.length / batchSize)}`);

      const availableBalancePromises = batch.map(lockerAddress => 
        viemClient.readContract({
          address: lockerAddress as Address,
          abi: LOCKER_ABI,
          functionName: 'getAvailableBalance',
          args: []
        })
      );

      const stakedBalancePromises = batch.map(lockerAddress =>
        viemClient.readContract({
          address: lockerAddress as Address,
          abi: LOCKER_ABI,
          functionName: 'getStakedBalance',
          args: []
        })
      );

      const liquidityBalancePromises = batch.map(lockerAddress =>
        viemClient.readContract({
          address: lockerAddress as Address,
          abi: LOCKER_ABI,
          functionName: 'getLiquidityBalance',
          args: []
        })
      );

      const ownerPromises = batch.map(lockerAddress =>
        viemClient.readContract({
          address: lockerAddress as Address,
          abi: LOCKER_ABI,
          functionName: 'lockerOwner',
          args: []
        })
      );

      const unlocksAtPromises = batch.map(lockerAddress =>
        viemClient.readContract({
          address: lockerAddress as Address,
          abi: LOCKER_ABI,
          functionName: 'stakingUnlocksAt',
          args: []
        })
      );

      const [availableBalances, stakedBalances, liquidityBalances, owners, unlocksAtTimestamps] = await Promise.all([
        Promise.all(availableBalancePromises),
        Promise.all(stakedBalancePromises),
        Promise.all(liquidityBalancePromises),
        Promise.all(ownerPromises),
        Promise.all(unlocksAtPromises)
      ]);

      // Compute SUP denominated LP amounts from liquidity balances
      const lpBalances = liquidityBalances.map(liquidityBalance => {
        const liquidity = liquidityBalance as bigint;
        // Exact: amount1 = L * (sqrtPriceX96 - MIN_SQRT_RATIO) / Q96
        return (liquidity * (sqrtPriceX96 - MIN_SQRT_RATIO)) / Q96;
      });

      // Track per-locker data and log detailed info for non-zero liquidity balances
      batch.forEach((lockerAddress, idx) => {
        lockerMap.set(lockerAddress.toLowerCase(), {
          owner: owners[idx] ? (owners[idx] as Address).toLowerCase() : '',
          staked: stakedBalances[idx] as bigint,
          lp: lpBalances[idx] as bigint,
          fontaines: BigInt(0), // placeholder, added as next step
          available: availableBalances[idx] as bigint,
          unlocksAt: unlocksAtTimestamps[idx] as bigint,
          instantUnlocked: BigInt(0),
          streamUnlocked: BigInt(0),
          tax: BigInt(0)
        });
      });
    }

    // Query transfer instantUnlockEvents to stakingRewardController for instant-unlock detection
    console.log('Fetching transfer instantUnlockEvents to stakingRewardController...');
    const transferEvents = await queryAllPages(
      (lastId) => `{
        transferEvents(
          first: 1000,
          where: {
            token: "${config.baseTokenAddress.toLowerCase()}",
            to: "${config.stakingRewardControllerAddress.toLowerCase()}",
            id_gt: "${lastId}"
          },
          orderBy: id,
          orderDirection: asc
        ) {
          id
          from {
            id
          }
          value
          timestamp
        }
      }`,
      (res) => res.data.data.transferEvents,
      (item) => item,
      config.sfSubgraphUrl
    );

    console.log(`Found ${transferEvents.length} transfer instantUnlockEvents to stakingRewardController`);

    // Build a map of locker -> transfer instantUnlockEvents (only for lockers that exist)
    const lockerAddressesSet = new Set(lockers.map(l => l.toLowerCase()));
    const instantUnlockEventsByLocker = new Map<string, Array<{ value: bigint; timestamp: number }>>();
    
    transferEvents.forEach(event => {
      const fromAddress = event.from.id.toLowerCase();
      if (lockerAddressesSet.has(fromAddress)) {
        if (!instantUnlockEventsByLocker.has(fromAddress)) {
          instantUnlockEventsByLocker.set(fromAddress, []);
        }
        instantUnlockEventsByLocker.get(fromAddress)!.push({
          value: BigInt(event.value),
          timestamp: parseInt(event.timestamp, 10)
        });
      }
    });

    console.log(`Found ${instantUnlockEventsByLocker.size} lockers with instant-unlock instantUnlockEvents`);

    // Calculate streaming out by querying fontaines from sup_subgraph
    console.log('Fetching fontaines...');
    const fontaines = await queryAllPages(
      (lastId) => `{
        fontaines(
          first: 1000,
          where: { id_gt: "${lastId}" }
          orderBy: id,
          orderDirection: asc
        ) {
          id
          locker {
            id
          }
          recipient
          unlockAmount
          unlockPeriod
        }
      }`,
      (res) => res.data.data.fontaines,
      (item) => item,
      config.supSubgraphUrl
    );

    console.log(`Found ${fontaines.length} fontaines`);

    // Get SUP balance of each fontaine contract
    console.log('Fetching SUP balances for fontaines...');
    const fontaineBalancePromises = fontaines.map(fontaine => 
      viemClient.readContract({
        address: config.baseTokenAddress as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [fontaine.id as Address]
      })
    );

    const fontaineBalances = await Promise.all(fontaineBalancePromises);
    
    // Map fontaine balances to lockers and calculate stream unlocks
    fontaines.forEach((fontaine, idx) => {
      const lockerId = fontaine.locker.id.toLowerCase();
      const balance = fontaineBalances[idx] as bigint;
      const unlockAmount = BigInt(fontaine.unlockAmount);
      const unlockPeriod = parseInt(fontaine.unlockPeriod, 10);
      
      // Log if unlockPeriod is different from the expected 12 months. Only for those the assumption of 0 tax holds
      if (unlockPeriod !== 31536000) {
        console.log(`Warning: Fontaine ${fontaine.id} has unlockPeriod ${unlockPeriod} (expected 31536000)`);
      }
      
      const locker = lockerMap.get(lockerId);
      if (locker) {
        locker.fontaines += balance;
        if (balance > unlockAmount) {
          throw new Error(`Fontaine ${fontaine.id} has balance ${balance} > unlockAmount ${unlockAmount}`);
        }
        locker.streamUnlocked += unlockAmount - balance;
      } else {
        throw new Error(`Fontaine ${fontaine.id} - owning locker ${lockerId} not found in lockerMap`);
      }
    });

    // Calculate totals and build per-locker breakdown
    //let totalLockerSup = BigInt(0);
    let totalAvailableSup = BigInt(0);
    let totalStakedSup = BigInt(0);
    let totalLpSup = BigInt(0);
    let totalStreamingOut = BigInt(0);
    let totalInstantUnlocked = BigInt(0);
    let totalStreamUnlocked = BigInt(0);
    let totalTax = BigInt(0);
    const lockerBreakdowns: LockerBreakdown[] = [];
    
    // Count reserves by category
    let reservesWithFontaines = 0;
    let reservesWithStake = 0;
    let reservesWithLiquidity = 0;
    let reservesWithInstantUnlock = 0;
    let reservesWithNone = 0;

    lockerMap.forEach((data, address) => {
      // Process instant unlock instantUnlockEvents for this locker
      const instantUnlockEvents = instantUnlockEventsByLocker.get(address);
      if (instantUnlockEvents) {
        instantUnlockEvents.forEach(event => {
          // 20% is unlocked, 80% goes to tax
          const unlocked = event.value / BigInt(4); // 1/4 of 80% is 20%
          data.instantUnlocked += unlocked;
          data.tax += event.value; // 80% of value
        });
      }

      const available = Number(data.available / BigInt(10 ** 18));
      const staked = Number(data.staked / BigInt(10 ** 18));
      const lp = Number(data.lp / BigInt(10 ** 18));
      const fontaines = Number(data.fontaines / BigInt(10 ** 18));
      const instantUnlocked = Number(data.instantUnlocked / BigInt(10 ** 18));
      const streamUnlocked = Number(data.streamUnlocked / BigInt(10 ** 18));
      const tax = Number(data.tax / BigInt(10 ** 18));

      totalAvailableSup += data.available;
      totalStakedSup += data.staked;
      totalLpSup += data.lp;
      totalStreamingOut += data.fontaines;
      totalInstantUnlocked += data.instantUnlocked;
      totalStreamUnlocked += data.streamUnlocked;
      totalTax += data.tax;
      
      lockerBreakdowns.push({ 
        address, 
        owner: data.owner, 
        available, 
        staked, 
        lp, 
        fontaines,
        instantUnlocked,
        streamUnlocked,
        tax
      });

      if (fontaines > 0) {
        reservesWithFontaines++;
      }
      if (staked > 0) {
        reservesWithStake++;
      }
      if (lp > 0) {
        reservesWithLiquidity++;
      }
      if (data.instantUnlocked > 0n) {
        reservesWithInstantUnlock++;
      }

      // Count reserves that did none of the above
      if (fontaines === 0 && staked === 0 && lp === 0 && data.instantUnlocked === 0n) {
        reservesWithNone++;
      }
    });

    metrics.lockerBalances = Number(totalAvailableSup / BigInt(10 ** 18));
    metrics.stakedSup = Number(totalStakedSup / BigInt(10 ** 18));
    metrics.streamingOut = Number(totalStreamingOut / BigInt(10 ** 18));
    metrics.lpSup = Number(totalLpSup / BigInt(10 ** 18));

    // Calculate lpSupProvided and lpSupCollected
    const { lpSupProvided, lpSupCollected } = await calculateLpSupProvidedAndCollected();
    metrics.lpSupProvided = lpSupProvided;
    metrics.lpSupCollected = lpSupCollected;

    metrics.reserveBalances = metrics.lockerBalances + metrics.stakedSup + metrics.lpSup + metrics.streamingOut;

    // Calculate "Other" as remainder (note that stakedSup and streamingOut are already included in reserveBalances)
    metrics.other = metrics.totalSupply -
      ( metrics.reserveBalances + metrics.lpSup + metrics.communityCharge + 
      metrics.investorsTeamLocked + metrics.daoTreasury + metrics.foundationTreasury +
      metrics.daoSPRProgramManager + metrics.vestingTreasury + metrics.supCorpOps);

    // Set locker counts
    metrics.reservesWithFontaines = reservesWithFontaines;
    metrics.reservesWithStake = reservesWithStake;
    metrics.reservesWithLiquidity = reservesWithLiquidity;
    metrics.reservesWithInstantUnlock = reservesWithInstantUnlock;
    metrics.reservesWithNone = reservesWithNone;
    
    // Set unlock totals
    metrics.instantUnlocked = Number(totalInstantUnlocked / BigInt(10 ** 18));
    metrics.streamUnlocked = Number(totalStreamUnlocked / BigInt(10 ** 18));
    metrics.tax = Number(totalTax / BigInt(10 ** 18));

    // Calculate stake cooldown projection for 30 days in the past to 30 days in the future
    const projection: StakeCooldownProjectionEntry[] = [];
    const SECONDS_PER_DAY = 86400;
    
    // Initialize projection with dates from 30 days ago to 30 days in the future (61 days total)
    const currentDate = new Date();
    const todayUTC = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate()));
    
    for (let day = -30; day <= 30; day++) {
      const date = new Date(todayUTC);
      date.setUTCDate(date.getUTCDate() + day);
      const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      projection.push({ date: dateString, amount: 0 });
    }
    
    // Track amounts that are outside the projection range
    let sumTooFarInPast = 0;
    
    // Calculate which day each locker's stake becomes unstakable
    lockerMap.forEach((data, lockerAddress) => {
      if (data.staked > 0n && data.unlocksAt !== null) {
        const unlocksAt = Number(data.unlocksAt);
        const unlockDate = new Date(unlocksAt * 1000);
        const unlockDateUTC = new Date(Date.UTC(
          unlockDate.getUTCFullYear(),
          unlockDate.getUTCMonth(),
          unlockDate.getUTCDate()
        ));
        
        const daysFromNow = Math.floor((unlockDateUTC.getTime() - todayUTC.getTime()) / (1000 * SECONDS_PER_DAY));
        const stakedAmount = Number(data.staked / BigInt(10 ** 18));
        
        // Include if unlock is within the projection range (-30 to +30 days)
        if (daysFromNow >= -30 && daysFromNow <= 30) {
          // Map daysFromNow to array index: -30 -> 0, -29 -> 1, ..., 0 -> 30, ..., 30 -> 60
          const projectionIndex = daysFromNow + 30;
          projection[projectionIndex].amount += stakedAmount;
        } else if (daysFromNow < -30) {
          // More than 30 days in the past - sum up
          sumTooFarInPast += stakedAmount;
        } else {
          // More than 30 days in the future - log individual locker
          const futureUnlockDateString = unlockDateUTC.toISOString().split('T')[0];
          console.log(`Locker ${lockerAddress} (owner: ${data.owner}) has unlock date ${futureUnlockDateString} (${daysFromNow} days from now) with staked amount: ${stakedAmount}`);
        }
      }
    });
    
    // Log the sum of amounts that are too far in the past
    if (sumTooFarInPast > 0) {
      console.log(`Sum of staked amounts with unlock dates more than 30 days in the past: ${sumTooFarInPast}`);
    }
    
    metrics.stakeCooldownProjection = projection;

    // Add per-locker breakdown
    metrics.lockers = lockerBreakdowns;

    console.log('Distribution metrics calculated:', {
      reserveBalances: metrics.reserveBalances,
      lockerBalances: metrics.lockerBalances,
      stakedSup: metrics.stakedSup,
      lpSup: metrics.lpSup,
      streamingOut: metrics.streamingOut,
      communityCharge: metrics.communityCharge,
      investorsTeamLocked: metrics.investorsTeamLocked,
      daoTreasury: metrics.daoTreasury,
      foundationTreasury: metrics.foundationTreasury,
      supCorpOps: metrics.supCorpOps,
      other: metrics.other,
      totalSupply: metrics.totalSupply,
      lockers: metrics.lockers.length,
      reservesWithFontaines: metrics.reservesWithFontaines,
      reservesWithStake: metrics.reservesWithStake,
      reservesWithLiquidity: metrics.reservesWithLiquidity,
      reservesWithInstantUnlock: metrics.reservesWithInstantUnlock,
      reservesWithNone: metrics.reservesWithNone,
      instantUnlocked: metrics.instantUnlocked,
      streamUnlocked: metrics.streamUnlocked,
      tax: metrics.tax
    });

    return metrics;

  } catch (error) {
    console.error(formatAxiosError(error, 'Error fetching distribution metrics'));
    throw error;
  }
}
