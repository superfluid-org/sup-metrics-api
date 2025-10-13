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
  DistributionMetricsResponse,
  VestingSchedule
} from './types'; 
import snapshot from '@snapshot-labs/snapshot.js';
import snapshotStrategies from '@d10r/snapshot-strategies';
import { createPublicClient, http, Client, Chain, Transport, Address, erc20Abi } from 'viem';
import { base, mainnet } from 'viem/chains'
import * as ethersProviders from '@ethersproject/providers';
import { LOCKER_ABI, SUP_VESTING_FACTORY_ABI } from './abis';

// File paths for metric data
const DATA_DIR = './data';
const FILE_SCHEMA_VERSION = 3;

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
  private updateFn: () => Promise<T>;
  private intervalSec: number;
  private isUpdating: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    initialData: T,
    updateFn: () => Promise<T>,
    filename: string,
    intervalSec: number
  ) {
    console.log(`Initializing ${filename} with interval ${intervalSec} seconds`);
    this.updateFn = updateFn;
    this.intervalSec = intervalSec;
    this.data = {
      schemaVersion: FILE_SCHEMA_VERSION,
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
        if (fileData.schemaVersion !== FILE_SCHEMA_VERSION) {
          console.warn(`File schema version mismatch: ${fileData.schemaVersion} (expected ${FILE_SCHEMA_VERSION})`);
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
        schemaVersion: FILE_SCHEMA_VERSION,
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

// Create voting metrics manager instance
const votingMetricsManager = new MetricsManager<Record<string, MemberData>>(
  {},
  fetchVotingMetrics,
  'votingMetrics.json',
  config.votingMetricsUpdateInterval
);

// Create distribution metrics manager instance
const distributionMetricsManager = new MetricsManager<DistributionMetrics>(
  {
    reserveBalances: 0,
    lockerBalances: 0,
    stakedSup: 0,
    lpSup: 0,
    streamingOut: 0,
    communityCharge: 0,
    investorsTeamLocked: 0,
    daoTreasury: 0,
    foundationTreasury: 0,
    other: 0,
    totalSupply: 1000000000 // 1B SUP tokens
  },
  fetchDistributionMetrics,
  'distributionMetrics.json',
  config.distributionMetricsUpdateInterval
);

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
  return {
    metrics: distributionData,
    lastUpdatedAt
  };
};

// Function to get investors and team addresses from vesting schedules
async function getInvestorsAndTeamAddresses(): Promise<string[]> {
  // Step 1: Get vesting sender contracts from transfer events
  console.log('Fetching vesting sender contracts from transfer events...');
  
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
  
  // Extract unique addresses from transfer events
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
  onlyFlowing: boolean = false
): Promise<VestingSchedule[]> {
  try {
    const vestingSchedules = await queryAllPages(
      (lastId) => `{
        vestingSchedules(
          first: 1000,
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

// Keep existing helper functions
async function queryAllPages<T>(
  queryFn: (lastId: string) => string,
  toItems: (response: any) => any[],
  itemFn: (item: any) => T,
  graphqlEndpoint: string
): Promise<T[]> {
  let lastId = "";
  const items: T[] = [];
  const pageSize = 1000;

  while (true) {
    //console.log(`querying page ${lastId}`);
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

// Helper function to format axios errors
function formatAxiosError(error: unknown, context: string): string {
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
      errorMsg += `${statusText} - `;
    }
    if (data) {
      // If data is an object, stringify it
      const dataStr = typeof data === 'object' ? JSON.stringify(data) : data;
      errorMsg += `Response: ${dataStr} `;
    }
    // Add the error message if it provides additional information
    if (message && !errorMsg.includes(message)) {
      errorMsg += `(${message})`;
    }
    return errorMsg;
  }
  // For non-axios errors, return the error as a string
  return `${context}: ${error}`;
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

      const provider = _viemClientToEthersV5Provider(viemClient);
      
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
    const events = response.data.data.flowDistributionUpdatedEvents;
    
    console.log(`Found ${events.length} flow distribution events`);
    // log full detail
//    console.log(JSON.stringify(response.data.data, null, 2));
    
    // Create a Map to store unique pools by ID
    const uniquePools = new Map();
    
    // Process events and keep only the most recent event for each pool
    for (const event of events) {
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


function _viemClientToEthersV5Provider(client: Client<Transport, Chain>): ethersProviders.Provider {
  return new ethersProviders.StaticJsonRpcProvider(
    {
      url: client.transport.url,
      timeout: 25000,
      allowGzip: true
    },
    client.chain.id
  );
}

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
    const events = response.data.data.flowDistributionUpdatedEvents;
    
    console.log(`Found ${events.length} flow distribution events`);
    
    // Create a Set to store unique pool IDs
    const uniquePools = new Set();
    for (const event of events) {
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
      reserveBalances: 0, // includes stakedSup and streamingOut
      lockerBalances: 0,
      stakedSup: 0,
      lpSup: 0,
      streamingOut: 0,
      communityCharge: 0,
      investorsTeamLocked: 0,
      daoTreasury: 0,
      foundationTreasury: 0,
      other: 0,
      totalSupply: 1000000000 // 1B SUP tokens
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
    
    console.log(`DAO Treasury: current balance=${currentBalance}, remaining vesting=${remainingVestingAmount}, total=${metrics.daoTreasury}`);

    // Get Foundation Treasury balance (on Ethereum)
    console.log('Fetching Foundation Treasury balance...');
    const ethereumViemClient = createPublicClient({
      chain: mainnet,
      transport: http(config.ethereumRpcUrl, {
        batch: {
          wait: 100
        }
      }),
    });
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

    const batchSize = 100;
    // SUP in lockers (unstaked)
    let totalLockerSup = BigInt(0);
    // staked SUP
    let totalStakedSup = BigInt(0);
    // (claim on) SUP in LP positions
    let totalLpSup = BigInt(0);

    for (let i = 0; i < lockers.length; i += batchSize) {
      const batch = lockers.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(lockers.length / batchSize)}`);

      // Fetch locker balances
      //console.log('Fetching locker availableBalances and staked amounts...');
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

      // LP balance not yet available, use placeholder
      const lpPromises = batch.map(_ => BigInt(0));

      const [availableBalances, stakedBalances, lpBalances] = await Promise.all([
        Promise.all(availableBalancePromises),
        Promise.all(stakedBalancePromises),
        Promise.all(lpPromises)
      ]);

      // Sum up the batch results
      totalLockerSup += availableBalances.reduce((sum, balance) => sum + (balance as bigint), BigInt(0));
      totalStakedSup += stakedBalances.reduce((sum, balance) => sum + (balance as bigint), BigInt(0));
      totalLpSup += lpBalances.reduce((sum, balance) => sum + (balance as bigint), BigInt(0));

    }

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
    
    // Sum up all fontaine balances
    const totalStreamingOut = fontaineBalances.reduce((sum, balance) => sum + (balance as bigint), BigInt(0));

    metrics.lockerBalances = Number(totalLockerSup / BigInt(10 ** 18));
    metrics.stakedSup = Number(totalStakedSup / BigInt(10 ** 18));
    metrics.streamingOut = Number(totalStreamingOut / BigInt(10 ** 18));
    metrics.lpSup = Number(totalLpSup / BigInt(10 ** 18));
    metrics.reserveBalances = metrics.lockerBalances + metrics.stakedSup + metrics.streamingOut;

    // Calculate "Other" as remainder (note that stakedSup and streamingOut are already included in reserveBalances)
    metrics.other = metrics.totalSupply -
      ( metrics.reserveBalances + metrics.lpSup + metrics.communityCharge + 
      metrics.investorsTeamLocked + metrics.daoTreasury + metrics.foundationTreasury);

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
      other: metrics.other,
      totalSupply: metrics.totalSupply
    });

    return metrics;

  } catch (error) {
    console.error(formatAxiosError(error, 'Error fetching distribution metrics'));
    throw error;
  }
}
