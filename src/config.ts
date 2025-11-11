import dotenv from 'dotenv';

dotenv.config();

const required = ['BASE_RPC_URL', 'ETHEREUM_RPC_URL', 'GRAPH_NETWORK_API_KEY', 'SF_SUBGRAPH_URL', 'SUP_SUBGRAPH_URL'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing required config: ${missing.join(', ')}`);

// default values are for the mainnet deployment
export const config = {
  // Infra
  baseRpcUrl: process.env.BASE_RPC_URL!,
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL!,
  graphNetworkApiKey: process.env.GRAPH_NETWORK_API_KEY!,
  sfSubgraphUrl: process.env.SF_SUBGRAPH_URL!, // base-mainnet protocol subgraph
  supSubgraphUrl: process.env.SUP_SUBGRAPH_URL!, // base-mainnet SUP subgraph
  vestingSubgraphUrl: process.env.VESTING_SUBGRAPH_URL!, // base-mainnet vesting subgraph

  // Snapshot
  delegationSubgraphId: process.env.DELEGATION_SUBGRAPH_ID || '9qxDXD1SNnZriMMkCRVAmSdsv4KP6Xvnr8U2CRc5HQWh', // snapshot-base
  snapshotHubUrl: process.env.SNAPSHOT_HUB_URL || 'https://hub.snapshot.org/graphql',
  snapshotScoreUrl: process.env.SNAPSHOT_SCORE_URL || 'https://score.snapshot.org/',
  snapshotSpace: process.env.SNAPSHOT_SPACE || 'superfluid.eth',

  // Contracts
  baseTokenAddress: process.env.BASE_TOKEN_ADDRESS || '0xa69f80524381275A7fFdb3AE01c54150644c8792',
  ethereumTokenAddress: process.env.ETHEREUM_TOKEN_ADDRESS || '0xD05001Db979ff2f1a3B2105875d3454E90dd2961',
  lockerFactoryAddress: process.env.LOCKER_FACTORY_ADDRESS || '0xA6694cAB43713287F7735dADc940b555db9d39D9',
  additionalTotalVp: process.env.ADDITIONAL_TOTAL_VP || '0',
  epProgramManager: process.env.EP_PROGRAM_MANAGER || '0x1e32cf099992E9D3b17eDdDFFfeb2D07AED95C6a',
  vestingFactoryAddress: process.env.VESTING_FACTORY_ADDRESS || '0x3DF8A6558073e973f4c3979138Cca836C993E285', // aka lockedSUP aka vSUP
  stakingRewardControllerAddress: process.env.STAKING_REWARD_CONTROLLER_ADDRESS || '0xb19Ae25A98d352B36CED60F93db926247535048b',
  daoTreasuryAddress: process.env.DAO_TREASURY_ADDRESS || '0xac808840f02c47C05507f48165d2222FF28EF4e1',
  foundationTreasuryAddress: process.env.FOUNDATION_TREASURY_ADDRESS || '0xb2a19fB5C2cF21505f5dD12335Dc8B73a17FE5Ff',
  vestingTreasuryAddress: process.env.VESTING_TREASURY_ADDRESS || '0x5c0fdb8602d5721276179c51c81f0e50e36846a4',
  
  // App
  port: parseInt(process.env.PORT || '3000', 10),
  votingMetricsUpdateInterval: parseInt(process.env.VOTING_METRICS_UPDATE_INTERVAL || '86400', 10),
  distributionMetricsUpdateInterval: parseInt(process.env.DISTRIBUTION_METRICS_UPDATE_INTERVAL || '86400', 10),
  vpCalcChunkSize: parseInt(process.env.VP_CALC_CHUNK_SIZE || '5000', 10),
}; 

export type AppConfig = typeof config;
