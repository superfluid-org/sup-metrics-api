import { Controller, Get, Query, Route, Tags } from 'tsoa';
import { isAddress } from 'viem';
import {
  getDaoMembersCount,
  getTotalDelegatedScore,
  getVotingPower,
  getDelegateForUser,
  getTotalScore,
  getDaoMembersWithFilters,
  getDistributionMetrics
} from '../metrics';
import {
  DaoMembersCountResponse,
  TotalDelegatedScoreResponse,
  UserScoreResponse,
  UserDelegateResponse,
  ConfigResponse,
  TotalScoreResponse,
  DaoMembersResponse,
  DistributionMetricsResponse
} from '../types';
import { config } from '../config';

@Route('v1')
@Tags('Token Metrics')
export class MetricsController extends Controller {
  /**
   * Get the number of DAO members.<br><br>
   * 
   * This is currently calculated by counting the accounts connected to a pool.<br>
   * That's quite accurate because SUP distribution is currently taking place through distributions to lockers.<br>
   * This is close enough to reality as long as the token isn't transferrable.<br><br>
   * 
   * This metrics is periodically updated in the background. The last update timestamp is returned.
   */
  @Get('/dao_members_count')
  public getDaoMembersCount(): DaoMembersCountResponse {
    return getDaoMembersCount();
  }

  /**
   * Get the cumulated score of all delegations.<br><br>
   * 
   * This is the sum of the snapshot scores (based on the current space configuration / strategies) of all delegates.<br>
   * It is derived by first getting a list of space delegates from the delegation contract subgraph,
   * and then querying the current score for each of them from the snapshot scores API, summing them up.<br>
   * It is returned as floating point number.<br><br>
   * 
   * This metrics is periodically updated in the background. The last update timestamp is returned.
   */
  @Get('/total_delegated_score')
  public getTotalDelegatedScore(): TotalDelegatedScoreResponse {
    return getTotalDelegatedScore();
  }

  /**
   * Get the snapshot score for a specific account.<br><br>
   * 
   * This is essentially the cumulated amount a user owns (locked, unlocked or staked).<br>
   * It is derived by querying the current score for the user from the snapshot scores API.<br>
   * It is returned as floating point number.
   */
  @Get('/user_score')
  public async getUserScore(
    @Query() address: string
  ): Promise<UserScoreResponse> {
    if (!isAddress(address)) {
      throw new Error('Invalid Ethereum address');
    }
    const votingPower = await getVotingPower(address.toLowerCase());
    return {
      score: votingPower.own + votingPower.delegated,
      delegatedScore: votingPower.delegated,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Get the delegate for a specific user address.<br><br>
   * 
   * This is the address of the user's delegate.<br>
   * If no delegate is set, null is returned.
   */
  @Get('/user_delegate')
  public async getUserDelegate(
    @Query() address: string
  ): Promise<UserDelegateResponse> {
    if (!isAddress(address)) {
      throw new Error('Invalid Ethereum address');
    }
    const delegate = await getDelegateForUser(address.toLowerCase());
    return {
      delegate,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Get the total score based on flow distribution.<br><br>
   * 
   * This calculates the total amount distributed across all pools managed by the EP Program Manager.<br>
   * It is derived by querying the Superfluid subgraph for flow distribution events and calculating<br>
   * the current total based on flow rates and elapsed time.
   */
  @Get('/total_score')
  public async getTotalScore(): Promise<TotalScoreResponse> {
    return getTotalScore();
  }

  /**
   * Get DAO members with delegation information.<br><br>
   * 
   * Returns a list of DAO members with their voting power, delegation info, and delegate status.<br>
   * The list is ordered by voting power + delegated voting power descending.<br>
   * Can be filtered by minimum voting power and to include all delegates regardless of voting power.<br>
   * This is periodically updated in the background. The last update timestamp is returned.
   * 
   * @param min_vp Minimum voting power threshold (default: 10000)
   * @param include_all_delegates Include all delegates regardless of voting power (default: false)
   */
  @Get('/dao_members')
  public getDaoMembers(
    @Query() min_vp?: number,
    @Query() include_all_delegates?: string
  ): DaoMembersResponse {
    return getDaoMembersWithFilters(
      min_vp !== undefined ? Number(min_vp) : 10000,
      include_all_delegates === 'true'
    );
  }

  /**
   * Get SUP token distribution metrics.<br><br>
   * 
   * Returns comprehensive metrics about SUP token distribution across different categories:<br>
   * - Reserve Balances: Total SUP distributed to lockers but not yet unlocked<br>
   * - Staked SUP: Portion currently staked via lockers<br>
   * - LP SUP: Portion in UniswapV3 liquidity via lockers<br>
   * - Streaming Out: Portion transferred from lockers to fountains, not yet streamed to users<br>
   * - Community Charge: SUP owned by StakingRewardController (tax from fast unlocks)<br>
   * - Investors/Team Locked: SUP distributed via SupVestingFactory<br>
   * - DAO Treasury: DAO Treasury balance<br>
   * - Foundation Treasury: Foundation Treasury balance<br>
   * - Other: Remainder of 1B SUP tokens<br><br>
   * 
   * This metrics is periodically updated in the background. The last update timestamp is returned.
   */
  @Get('/distribution_metrics')
  public getDistributionMetrics(): DistributionMetricsResponse {
    const distributionMetrics = getDistributionMetrics();
    return {
      metrics: distributionMetrics.metrics,
      lastUpdatedAt: distributionMetrics.lastUpdatedAt
    };
  }

  /**
   * Get API configuration.<br><br>
   * Returns tokenAddress, snapshotSpace and snapshotHubUrl.
   */
  @Get('/config')
  public getConfig(): ConfigResponse {
    return {
      tokenAddress: config.baseTokenAddress,
      lockerFactoryAddress: config.lockerFactoryAddress,
      snapshotSpace: config.snapshotSpace,
      snapshotHubUrl: config.snapshotHubUrl,
    };
  }
} 