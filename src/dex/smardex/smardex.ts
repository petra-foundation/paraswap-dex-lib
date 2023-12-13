import { AbiCoder, Interface } from '@ethersproject/abi';
import { Contract } from 'web3-eth-contract';
import _ from 'lodash';
import {
  DEST_TOKEN_PARASWAP_TRANSFERS,
  ETHER_ADDRESS,
  NULL_ADDRESS,
  Network,
  SRC_TOKEN_PARASWAP_TRANSFERS,
  SwapSide,
} from '../../constants';
import {
  AdapterExchangeParam,
  Address,
  ExchangePrices,
  Logger,
  NumberAsString,
  PoolLiquidity,
  PoolPrices,
  SimpleExchangeParam,
  Token,
  TransferFeeParams,
} from '../../types';
import { IDexHelper } from '../../dex-helper/index';
import {
  SmardexFees,
  SmardexPair,
  SmardexPoolOrderedParams,
  SmardexPoolState,
} from './types';
import { getBigIntPow, getDexKeysWithNetwork, isETHAddress } from '../../utils';
import SmardexFactoryABI from '../../abi/smardex/smardex-factory.json';
import SmardexPoolABI from '../../abi/smardex/smardex-pool.json';
import SmardexRouterABI from '../../abi/smardex/smardex-router.json';

import { SimpleExchange } from '../simple-exchange';
import {
  SmardexRouterFunctions,
  directSmardexFunctionName,
  DefaultSmardexPoolGasCost,
  FEES_LEGACY_LAYER_ONE,
} from '../smardex/constants';
import { SmardexData, SmardexParam } from '../smardex/types';
import { IDex } from '../..';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { Adapters, SmardexConfig } from './config';
import ParaSwapABI from '../../abi/IParaswap.json';
import { applyTransferFee } from '../../lib/token-transfer-fee';
import { computeAmountIn, computeAmountOut } from './sdk/core';
import { SmardexEventPool } from './smardex-event-pool';
import { USDReservesService } from './usd-reserves';

const smardexPool = new Interface(SmardexPoolABI);

const coder = new AbiCoder();

export class Smardex
  extends SimpleExchange
  implements IDex<SmardexData, SmardexParam>
{
  pairs: { [key: string]: SmardexPair } = {};
  factory: Contract;

  routerInterface: Interface;
  exchangeRouterInterface: Interface;
  static directFunctionName = directSmardexFunctionName;

  factoryAddress: string;
  routerAddress: string;

  protected subgraphURL: string | undefined;
  protected initCode: string;
  protected legacyInitCode: string;

  public legacyPairs: string[];

  logger: Logger;
  readonly hasConstantPriceLargeAmounts = false;
  readonly isFeeOnTransferSupported: boolean = false;
  readonly SRC_TOKEN_DEX_TRANSFERS = 1;
  readonly DEST_TOKEN_DEX_TRANSFERS = 1;

  // Constants for top pools caching
  readonly CACHED_RESERVES_USD_TTL = 3000;
  readonly CACHED_RESERVES_USD_KEY = 'cachedReservesUSD';

  readonly usdReserves: USDReservesService;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(SmardexConfig);

  constructor(
    protected network: Network,
    dexKey: string,
    public dexHelper: IDexHelper,
    protected adapters = Adapters[network] || {},
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    const config = SmardexConfig[dexKey];
    this.routerAddress = config[network].router!;
    this.factoryAddress = config[network].factoryAddress;
    this.subgraphURL = config[network].subgraphURL;
    this.initCode = config[network].initCode;
    this.legacyInitCode = config[network].legacyInitCode || '';
    this.legacyPairs = config[network].legacyPairs || [];
    const factoryAbi = SmardexFactoryABI;
    this.factory = new dexHelper.web3Provider.eth.Contract(
      factoryAbi as any,
      this.factoryAddress,
    );
    this.routerInterface = new Interface(ParaSwapABI);
    this.exchangeRouterInterface = new Interface(SmardexRouterABI);
    this.usdReserves = new USDReservesService(
      this.dexKey,
      this.network,
      this.dexHelper,
      this.subgraphURL!,
    );
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side] ? this.adapters[side] : null;
  }

  async getPoolIdentifiers(
    _from: Token,
    _to: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const from = this.dexHelper.config.wrapETH(_from);
    const to = this.dexHelper.config.wrapETH(_to);

    if (from.address.toLowerCase() === to.address.toLowerCase()) {
      return [];
    }

    const tokenAddress = [from.address.toLowerCase(), to.address.toLowerCase()]
      .sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1))
      .join('_');

    const poolIdentifier = `${this.dexKey}_${tokenAddress}`;
    return [poolIdentifier];
  }

  async getPricesVolume(
    _from: Token,
    _to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    // list of pool identifiers to use for pricing, if undefined use all pools
    limitPools?: string[],
    transferFees: TransferFeeParams = {
      srcFee: 0,
      destFee: 0,
      srcDexFee: 0,
      destDexFee: 0,
    },
  ): Promise<ExchangePrices<SmardexData> | null> {
    try {
      const from = this.dexHelper.config.wrapETH(_from);
      const to = this.dexHelper.config.wrapETH(_to);

      if (from.address.toLowerCase() === to.address.toLowerCase()) {
        return null;
      }

      const tokenAddress = [
        from.address.toLowerCase(),
        to.address.toLowerCase(),
      ]
        .sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1))
        .join('_');

      const poolIdentifier = `${this.dexKey}_${tokenAddress}`;

      if (limitPools && limitPools.every(p => p !== poolIdentifier))
        return null;

      await this.batchCatchUpPairs([[from, to]], blockNumber);
      const isSell = side === SwapSide.SELL;
      const pairParam = await this.getPairOrderedParams(
        from,
        to,
        blockNumber,
        transferFees.srcDexFee,
      );

      if (!pairParam) return null;

      const unitAmount = getBigIntPow(isSell ? from.decimals : to.decimals);

      // SmarDex does not support Fees on Transfer Tokens
      const [unitVolumeWithFee, ...amountsWithFee] = applyTransferFee(
        [unitAmount, ...amounts],
        side,
        isSell ? transferFees.srcFee : transferFees.destFee,
        isSell ? SRC_TOKEN_PARASWAP_TRANSFERS : DEST_TOKEN_PARASWAP_TRANSFERS,
      );

      const unit = isSell
        ? await this.getSellPricePath(unitVolumeWithFee, [pairParam])
        : await this.getBuyPricePath(unitVolumeWithFee, [pairParam]);

      const prices = isSell
        ? await Promise.all(
            amountsWithFee.map(amount =>
              this.getSellPricePath(amount, [pairParam]),
            ),
          )
        : await Promise.all(
            amountsWithFee.map(amount =>
              this.getBuyPricePath(amount, [pairParam]),
            ),
          );

      const [unitOutWithFee, ...outputsWithFee] = applyTransferFee(
        [unit, ...prices],
        side,
        // This part is confusing, because we treat differently SELL and BUY fees
        // If Buy, we should apply transfer fee on srcToken on top of dexFee applied earlier
        // But for Sell we should apply only one dexFee
        isSell ? transferFees.destDexFee : transferFees.srcFee,
        isSell ? this.DEST_TOKEN_DEX_TRANSFERS : SRC_TOKEN_PARASWAP_TRANSFERS,
      );

      // As uniswapv2 just has one pool per token pair
      return [
        {
          prices: outputsWithFee,
          unit: unitOutWithFee,
          data: {
            deadline: Math.floor(new Date().getTime()) + 120,
            receiver: this.augustusAddress,
            router: this.routerAddress,
            path: [from.address.toLowerCase(), to.address.toLowerCase()],
            factory: this.factoryAddress,
            initCode: this.legacyPairs.includes(pairParam.exchange) ? this.legacyInitCode : this.initCode,
            pools: [
              {
                address: pairParam.exchange,
                fee: 0, // Smardex does not support Fees on Transfer Tokens
                direction:
                  pairParam.fromToken.toLocaleLowerCase() ===
                  pairParam.token0.toLocaleLowerCase(),
              },
            ],
          },
          exchange: this.dexKey,
          poolIdentifier,
          gasCost: DefaultSmardexPoolGasCost,
          poolAddresses: [pairParam.exchange],
        },
      ];
    } catch (e) {
      if (blockNumber === 0)
        this.logger.error(
          `Error_getPricesVolume: Aurelius block manager not yet instantiated`,
        );
      this.logger.error(`Error_getPrices:`, e);
      return null;
    }
  }

  async getBuyPricePath(
    amount: bigint,
    params: SmardexPoolOrderedParams[],
  ): Promise<bigint> {
    let price = amount;
    for (const param of params.reverse()) {
      price = await this.getBuyPrice(param, price);
    }
    return price;
  }

  async getSellPricePath(
    amount: bigint,
    params: SmardexPoolOrderedParams[],
  ): Promise<bigint> {
    let price = amount;
    for (const param of params) {
      price = await this.getSellPrice(param, price);
    }
    return price;
  }

  async getBuyPrice(
    priceParams: SmardexPoolOrderedParams,
    destAmount: bigint,
  ): Promise<bigint> {
    const amountIn = computeAmountIn(
      priceParams.token0,
      priceParams.token1,
      priceParams.reserves0,
      priceParams.reserves1,
      priceParams.fictiveReserves0,
      priceParams.fictiveReserves1,
      destAmount,
      priceParams.toToken,
      +priceParams.priceAverageLastTimestamp,
      priceParams.priceAverage0,
      priceParams.priceAverage1,
      priceParams.feesLP,
      priceParams.feesPool,
    ).amount;

    return BigInt(amountIn.toString());
  }

  async getSellPrice(
    priceParams: SmardexPoolOrderedParams,
    srcAmount: bigint,
  ): Promise<bigint> {
    const amountOut = computeAmountOut(
      priceParams.token0,
      priceParams.token1,
      priceParams.reserves0,
      priceParams.reserves1,
      priceParams.fictiveReserves0,
      priceParams.fictiveReserves1,
      srcAmount,
      priceParams.fromToken,
      +priceParams.priceAverageLastTimestamp,
      priceParams.priceAverage0,
      priceParams.priceAverage1,
      priceParams.feesLP,
      priceParams.feesPool,
    ).amount;

    return BigInt(amountOut.toString());
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(_poolPrices: PoolPrices<SmardexData>): number | number[] {
    return (
      CALLDATA_GAS_COST.DEX_OVERHEAD +
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> weth
      CALLDATA_GAS_COST.ADDRESS +
      // ParentStruct -> pools[] header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> pools[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> pools[0]
      CALLDATA_GAS_COST.wordNonZeroBytes(22)
    );
  }

  async findPair(from: Token, to: Token) {
    if (from.address.toLowerCase() === to.address.toLowerCase()) return null;
    const [token0, token1] =
      BigInt(from.address.toLowerCase()) < BigInt(to.address.toLowerCase())
        ? [from, to]
        : [to, from];

    const key = `${token0.address.toLowerCase()}-${token1.address.toLowerCase()}`;
    let pair = this.pairs[key];
    if (pair) return pair;
    const exchange = await this.factory.methods
      .getPair(token0.address, token1.address)
      .call();
    if (exchange === NULL_ADDRESS) {
      pair = { token0, token1 };
    } else {
      pair = { token0, token1, exchange };
    }
    this.pairs[key] = pair;
    return pair;
  }

  async batchCatchUpPairs(pairs: [Token, Token][], blockNumber: number) {
    if (!blockNumber) return;
    const pairsToFetch: SmardexPair[] = [];
    for (const _pair of pairs) {
      const pair = await this.findPair(_pair[0], _pair[1]);
      if (!(pair && pair.exchange)) continue;
      if (!pair.pool) {
        pairsToFetch.push(pair);
      } else if (!pair.pool.getState(blockNumber)) {
        pairsToFetch.push(pair);
      }
    }

    if (!pairsToFetch.length) return;

    const reserves = await this.getManyPoolReserves(pairsToFetch, blockNumber);

    if (reserves.length !== pairsToFetch.length) {
      this.logger.error(
        `Error_getManyPoolReserves didn't get any pool reserves`,
      );
    }

    for (let i = 0; i < pairsToFetch.length; i++) {
      const pairState = reserves[i];
      const pair = pairsToFetch[i];
      if (!pair.pool) {
        await this.addPool(
          pair,
          pairState.reserves0,
          pairState.reserves1,
          pairState.fictiveReserves0,
          pairState.fictiveReserves1,
          pairState.priceAverage0,
          pairState.priceAverage1,
          pairState.feesLP,
          pairState.feesPool,
          blockNumber,
          pairState.priceAverageLastTimestamp,
        );
      } else pair.pool.setState(pairState, blockNumber);
    }
  }

  // On Smardex the fees are upgradable on layer 2.
  public getFeesMultiCallData(pairAddress: string) {
    if (this.legacyPairs.includes(pairAddress.toLowerCase())) {
      return null;
    }
    const callEntry = {
      target: pairAddress,
      callData: smardexPool.encodeFunctionData('getPairFees'),
    };
    const callDecoder = (values: any[]): SmardexFees => {
      const feesData = smardexPool.decodeFunctionResult(
        'getPairFees',
        values,
      );
      return {
        feesLP: feesData.feesLP_.toBigInt(),
        feesPool: feesData.feesPool_.toBigInt(),
      };
    };
    return {
      callEntry,
      callDecoder,
    };
  }

  protected async addPool(
    pair: SmardexPair,
    reserves0: string,
    reserves1: string,
    fictiveReserves0: string,
    fictiveReserves1: string,
    priceAverage0: string,
    priceAverage1: string,
    feesLp: bigint,
    feesPool: bigint,
    blockNumber: number,
    priceAverageLastTimestamp: number,
  ) {
    const multiCallFeeData = this.getFeesMultiCallData(pair.exchange!);
    pair.pool = new SmardexEventPool(
      smardexPool,
      this.dexHelper,
      pair.exchange!,
      pair.token0,
      pair.token1,
      this.logger,
      multiCallFeeData?.callEntry,
      multiCallFeeData?.callDecoder,
      this.legacyPairs,
    );
    pair.pool.addressesSubscribed.push(pair.exchange!);

    await pair.pool.initialize(blockNumber, {
      state: {
        reserves0,
        reserves1,
        fictiveReserves0,
        fictiveReserves1,
        priceAverage0,
        priceAverage1,
        feesLP: feesLp,
        feesPool,
        priceAverageLastTimestamp,
      },
    });
  }

  async getManyPoolReserves(
    pairs: SmardexPair[],
    blockNumber: number,
  ): Promise<SmardexPoolState[]> {
    try {
      const multiCallFeeData = pairs.map(pair =>
        this.getFeesMultiCallData(pair.exchange!),
      );
      const calldata = pairs
        .map((pair, i) => {
          let calldata = [
            {
              target: pair.exchange!,
              callData: smardexPool.encodeFunctionData('getReserves'),
            },
            {
              target: pair.exchange!,
              callData: smardexPool.encodeFunctionData('getFictiveReserves'),
            },
            {
              target: pair.exchange!,
              callData: smardexPool.encodeFunctionData('getPriceAverage'),
            },
          ];
          // Exclude legacy pairs from fees call
          !this.legacyPairs.includes(pair.exchange!.toLowerCase()) && calldata.push(multiCallFeeData[i]!.callEntry);
          return calldata;
        })
        .flat();

      const data: { returnData: any[] } =
        await this.dexHelper.multiContract.methods
          .aggregate(calldata)
          .call({}, blockNumber);

      const returnData = _.chunk(data.returnData, 4);
      return pairs.map((_pair: SmardexPair, i) => ({
        reserves0: coder
          .decode(['uint256', 'uint256'], returnData[i][0])[0]
          .toString(),
        reserves1: coder
          .decode(['uint256', 'uint256'], returnData[i][0])[1]
          .toString(),
        fictiveReserves0: coder
          .decode(['uint256', 'uint256'], returnData[i][1])[0]
          .toString(),
        fictiveReserves1: coder
          .decode(['uint256', 'uint256'], returnData[i][1])[1]
          .toString(),
        priceAverage0: coder
          .decode(['uint256', 'uint256', 'uint256'], returnData[i][2])[0]
          .toString(),
        priceAverage1: coder
          .decode(['uint256', 'uint256', 'uint256'], returnData[i][2])[1]
          .toString(),
        priceAverageLastTimestamp: coder
          .decode(['uint256', 'uint256', 'uint256'], returnData[i][2])[2]
          .toString(),
        feesLP: this.legacyPairs.includes(_pair.exchange!.toLowerCase())
          ? FEES_LEGACY_LAYER_ONE.feesLP
          : multiCallFeeData[i]!.callDecoder(returnData[i][3]).feesLP,
        feesPool: this.legacyPairs.includes(_pair.exchange!.toLowerCase())
          ? FEES_LEGACY_LAYER_ONE.feesPool
          : multiCallFeeData[i]!.callDecoder(returnData[i][3]).feesPool,
      }));
    } catch (e) {
      this.logger.error(
        `Error_getManyPoolReserves could not get reserves with error:`,
        e,
      );
      return [];
    }
  }

  protected fixPath(path: Address[], srcToken: Address, destToken: Address) {
    return path.map((token: string, i: number) => {
      if (
        (i === 0 && srcToken.toLowerCase() === ETHER_ADDRESS.toLowerCase()) ||
        (i === path.length - 1 &&
          destToken.toLowerCase() === ETHER_ADDRESS.toLowerCase())
      )
        return ETHER_ADDRESS;
      return token;
    });
  }

  async getPairOrderedParams(
    from: Token,
    to: Token,
    blockNumber: number,
    tokenDexTransferFee: number,
  ): Promise<SmardexPoolOrderedParams | null> {
    const pair = await this.findPair(from, to);
    if (!(pair && pair.pool && pair.exchange)) return null;
    const pairState = pair.pool.getState(blockNumber);
    if (!pairState) {
      this.logger.error(
        `Error_orderPairParams expected reserves, got none (maybe the pool doesn't exist) ${
          from.symbol || from.address
        } ${to.symbol || to.address}`,
      );
      return null;
    }
    // const fee = (pairState.feesPool + tokenDexTransferFee).toString();

    return {
      fromToken: from.address,
      toToken: to.address,
      token0: pair.token0.address,
      token1: pair.token1.address,
      reserves0: BigInt(pairState.reserves0),
      reserves1: BigInt(pairState.reserves1),
      fictiveReserves0: BigInt(pairState.fictiveReserves0),
      fictiveReserves1: BigInt(pairState.fictiveReserves1),
      priceAverage0: BigInt(pairState.priceAverage0),
      priceAverage1: BigInt(pairState.priceAverage1),
      priceAverageLastTimestamp: pairState.priceAverageLastTimestamp,
      exchange: pair.exchange,
      feesLP: BigInt(pairState.feesLP),
      feesPool: BigInt(pairState.feesPool),
    };
  }

  getWETHAddress(srcToken: Address, destToken: Address, weth?: Address) {
    if (!isETHAddress(srcToken) && !isETHAddress(destToken))
      return NULL_ADDRESS;
    return weth || this.dexHelper.config.data.wrappedNativeTokenAddress;
  }

  getAdapterParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    toAmount: NumberAsString,
    data: SmardexData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          path: 'address[]',
          receiver: 'address',
        },
      },
      {
        path: data.path,
        receiver: data.receiver,
      },
    );
    return {
      targetExchange: data.router,
      payload,
      networkFee: '0',
    };
  }

  async getSimpleParam(
    src: Address,
    dest: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: SmardexData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    let routerMethod: any;
    let routerArgs: any;
    if (side === SwapSide.SELL) {
      routerMethod = isETHAddress(src)
        ? SmardexRouterFunctions.sellExactEth
        : SmardexRouterFunctions.swapExactIn;
      routerMethod = isETHAddress(dest)
        ? SmardexRouterFunctions.sellExactToken
        : routerMethod;

      routerArgs = isETHAddress(src)
        ? [destAmount, data.path, data.receiver, data.deadline]
        : [srcAmount, destAmount, data.path, data.receiver, data.deadline];
    } else {
      routerMethod = isETHAddress(src)
        ? SmardexRouterFunctions.buyExactToken
        : SmardexRouterFunctions.swapExactOut;
      routerMethod = isETHAddress(dest)
        ? SmardexRouterFunctions.buyExactEth
        : routerMethod;

      routerArgs = isETHAddress(src)
        ? [destAmount, data.path, data.receiver, data.deadline]
        : [destAmount, srcAmount, data.path, data.receiver, data.deadline];
    }

    const swapData = this.exchangeRouterInterface.encodeFunctionData(
      routerMethod,
      routerArgs,
    );
    return this.buildSimpleParamWithoutWETHConversion(
      src,
      srcAmount,
      dest,
      destAmount,
      swapData,
      data.router,
    );
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    tokenAddress = tokenAddress.toLowerCase();
    const liquidityPromises = Object.values(this.pairs)
      .filter(
        pair =>
          pair.token0.address.toLowerCase() === tokenAddress ||
          pair.token1.address.toLowerCase() === tokenAddress,
      )
      .filter(pair => pair.exchange)
      .map(async pair => {
        const usdReserve = await this.usdReserves.getUSDReserveForPair(
          pair.exchange!,
        );
        return {
          exchange: this.dexKey,
          address: pair.exchange!,
          liquidityUSD: usdReserve,
          connectorTokens: [
            tokenAddress === pair.token0.address.toLowerCase()
              ? pair.token1
              : pair.token0,
          ],
        };
      });
    const resolvedLiquidity = await Promise.all(liquidityPromises);
    return resolvedLiquidity
      .sort((a, b) => b.liquidityUSD - a.liquidityUSD)
      .slice(0, limit);
  }
}
