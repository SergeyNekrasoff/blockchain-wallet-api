import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RedisService } from "../redis/redis.service";
import { EvmProvider } from "../blockchain/providers/evm.provider";
import { Web3Provider } from "../blockchain/providers/web3.provider";
import { WatchWalletDto } from "./dto/watch-wallet.dto";
import {
  WalletBalance,
  Transaction,
  TransactionList,
  WatchedWalletWithBalance,
  WatchedWallet,
  BalanceAlert,
  TokenBalance,
  NftItem,
} from "../blockchain/types/blockchain.types";
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from "./events/wallet-balance-changed.event";
import { formatBalance, hasBalanceChanged } from "../utils/decimal.utils";

const CACHE_KEYS = {
  balance: (address: string) => `balance:${address}`,
  transactions: (address: string, limit: number) => `txs:${address}:${limit}`,
  tokens: (address: string) => `tokens:${address}`,
  nfts: (address: string) => `nfts:${address}`,
  lastBalance: (address: string) => `last_balance:${address}`,
  watchlist: "watchlist",
  alerts: "wallet:alerts",
};

const CACHE_TTL = {
  balance: 30, // seconds
  transactions: 60, // seconds
  tokens: 120, // seconds
  nfts: 300, // seconds
};

@Injectable()
export class WalletService {
  private readonly network: string;
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly evm: EvmProvider,
    private readonly web3: Web3Provider,
    private readonly configService: ConfigService,
    private readonly events: EventEmitter2
  ) {
    this.network = this.configService.get<string>(
      "NETWORK",
      process.env.NETWORK
    );
  }

  async getBalance(address: string): Promise<WalletBalance> {
    if (!this.web3.isAvailable() || !this.evm.isEvmNetwork()) {
      throw new Error(
        `Provider is not initialized for network: ${this.network}`
      );
    }

    try {
      const cacheKey = CACHE_KEYS.balance(address);
      const cached = await this.redis.get(cacheKey);

      if (cached) {
        return {
          address: address,
          balance: cached,
          symbol: this.evm.config.symbol,
          network: this.network,
          cached: true,
        };
      }

      const rawBalance = await this.web3.instance.eth.getBalance(address);
      const balance = formatBalance(rawBalance, this.evm.config.decimals);

      await this.redis.set(cacheKey, balance, CACHE_TTL.balance * 1000);

      return {
        address: address,
        balance: balance,
        symbol: this.evm.config.symbol,
        network: this.network,
        cached: false,
      };
    } catch (error) {
      throw new Error(`Unable to get balance: ${error.message}`);
    }
  }

  async getTransactions(address: string, limit = 10): Promise<TransactionList> {
    if (!this.web3.isAvailable() || !this.evm.isEvmNetwork()) {
      throw new Error(
        `Provider instance is not initialized for network: ${this.network}`
      );
    }

    try {
      const cacheKey = CACHE_KEYS.transactions(address, limit);
      const cached = await this.redis.get(cacheKey);

      if (cached) {
        return {
          address: address,
          transactions: JSON.parse(cached),
          network: this.network,
          cached: true,
        };
      }

      const params = new URLSearchParams({
        module: "account",
        action: "txlist",
        chainid: "1",
        address: address,
        sort: "desc",
        page: "1",
        offset: limit.toString(),
        apikey: this.evm.config.explorerApiKeyEnv,
      });

      try {
        const response = await fetch(
          `${this.evm.config.explorerApiUrl}?${params}`
        );

        if (!response.ok) {
          throw new Error(
            `Failed to complete request for retrieve Transactions: ${response.status}`
          );
        }

        const data = await response.json();
        const transactionList: Transaction[] = data.result.map((tx) => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value
            ? formatBalance(tx.value, this.evm.config.decimals)
            : "0",
          timestamp: tx.timestamp,
          status: tx.txreceipt_status === 1 ? "success" : "failed",
        }));

        await this.redis.set(
          cacheKey,
          JSON.stringify(transactionList),
          CACHE_TTL.transactions * 1000
        );

        return {
          address: address,
          transactions: transactionList,
          network: this.network,
          cached: false,
        };
      } catch (error) {
        this.logger.error(`Failed to get transactions: ${error.message}`);
      }
    } catch (error) {
      throw new Error(`Failed to get transactions: ${error.message}`);
    }
  }

  async watchWallet(
    dto: WatchWalletDto
  ): Promise<{ success: boolean; address: string }> {
    try {
      const walletData = JSON.stringify({
        address: dto.address,
        label: dto.label,
        addedAt: Date.now(),
      });

      await this.redis.hset(CACHE_KEYS.watchlist, dto.address, walletData);

      return {
        success: true,
        address: dto.address,
      };
    } catch (error) {
      throw new Error(
        `Unable to watch Wallet by ${dto.address}, ${dto?.label}: ${error.message}`
      );
    }
  }

  async getWatchedWallets(): Promise<WatchedWalletWithBalance[]> {
    try {
      const cachedWallets = await this.redis.hgetall(CACHE_KEYS.watchlist);
      const watchedList = cachedWallets ? Object.values(cachedWallets) : [];

      if (watchedList.length === 0) return [];

      const result = await Promise.all(
        watchedList.map(async (wallet): Promise<WatchedWalletWithBalance> => {
          try {
            const currentWallet: WatchedWallet = JSON.parse(wallet);

            const rawBalance = await this.web3.instance.eth.getBalance(
              currentWallet.address
            );
            const balanceFormatted = formatBalance(
              rawBalance,
              this.evm.config.decimals
            );
            const lastBalance = await this.redis.get(
              CACHE_KEYS.lastBalance(currentWallet.address)
            );

            if (hasBalanceChanged(lastBalance, balanceFormatted)) {
              this.events.emit(WALLET_BALANCE_CHANGED, {
                address: currentWallet.address,
                network: this.network,
                symbol: this.evm.config.symbol,
                previousBalance: lastBalance ?? "0",
                currentBalance: balanceFormatted,
                detectedAt: Date.now(),
              } as WalletBalanceChangedEvent);

              await this.redis.set(
                CACHE_KEYS.lastBalance(currentWallet.address),
                balanceFormatted
              );
            }

            return {
              address: currentWallet.address,
              label: currentWallet.label,
              addedAt: currentWallet.addedAt,
              balance: balanceFormatted,
              symbol: this.evm.config.symbol,
            } as WatchedWalletWithBalance;
          } catch (error) {
            this.logger.error(
              `Error processing wallet ${wallet}: ${error.message}`
            );
            return null;
          }
        })
      );

      return result.filter(
        (wallet) => (wallet as WatchedWalletWithBalance) !== null
      );
    } catch (error) {
      throw new Error(`Failed to fetch watched wallets: ${error.message}`);
    }
  }

  async getAlerts(): Promise<BalanceAlert[]> {
    const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1);

    if (!raw) {
      throw new Error(`Unable to get balance changed alerts`);
    }

    return raw.map((item) => JSON.parse(item) as BalanceAlert);
  }
}
