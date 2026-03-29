import { Test, TestingModule } from "@nestjs/testing";

import { WalletService } from "./wallet.service";
import { RedisService } from "../redis/redis.service";
import { Web3Provider } from "../blockchain/providers/web3.provider";
import { EvmProvider } from "../blockchain/providers/evm.provider";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ConfigService } from "@nestjs/config";

import * as formatUtils from "../utils/decimal.utils";

jest.mock("../utils/decimal.utils.ts", () => ({
  formatBalance: jest.fn(),
}));

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

describe("WalletService - getBalance", () => {
  let service: WalletService;

  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
  };

  const mockWeb3 = {
    isAvailable: jest.fn(),
    instance: {
      eth: {
        getBalance: jest.fn(),
      },
    },
  };

  const mockEvm = {
    isEvmNetwork: jest.fn(),
    config: {
      symbol: "ETH",
      decimals: 18,
    },
  };

  const mockEventEmitter = {
    emit: jest.fn(),
    emitAsync: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === "SOME_KEY") return "some_value";
      return null;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: RedisService, useValue: mockRedis },
        { provide: Web3Provider, useValue: mockWeb3 },
        { provide: EvmProvider, useValue: mockEvm },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    (service as any).network = "ethereum";
  });

  afterEach(() => jest.clearAllMocks());

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should throw an error if the provider is unavailable", async () => {
    mockWeb3.isAvailable.mockReturnValue(false);

    await expect(service.getBalance("0x123")).rejects.toThrow(
      "Provider is not initialized for network: ethereum"
    );
  });

  it("should retrieve and format wallet balance", async () => {
    const address = "0x123";

    mockWeb3.isAvailable.mockReturnValue(true);
    mockEvm.isEvmNetwork.mockReturnValue(true);
    mockRedis.get.mockResolvedValue("1.5");

    const result = await service.getBalance(address);

    expect(result).toEqual({
      address,
      balance: "1.5",
      symbol: "ETH",
      network: "ethereum",
      cached: true,
    });
    expect(mockWeb3.instance.eth.getBalance).not.toHaveBeenCalled();
  });

  it("should request Web3 and save to Redis if it is empty", async () => {
    const address = "0x123";
    const mockWei = "1000000000000000000";
    const formatted = "1.0";

    mockWeb3.isAvailable.mockReturnValue(true);
    mockEvm.isEvmNetwork.mockReturnValue(true);
    mockRedis.get.mockResolvedValue(null);
    mockWeb3.instance.eth.getBalance.mockResolvedValue(mockWei);
    (formatUtils.formatBalance as jest.Mock).mockReturnValue(formatted);

    const result = await service.getBalance(address);

    expect(mockWeb3.instance.eth.getBalance).toHaveBeenCalledWith(address);
    expect(mockRedis.set).toHaveBeenCalledWith(
      CACHE_KEYS.balance(address),
      formatted,
      CACHE_TTL.balance * 1000
    );
    expect(result.balance).toBe(formatted);
    expect(result.cached).toBe(false);
  });

  it("should handle RPC request errors via try/catch", async () => {
    mockWeb3.isAvailable.mockReturnValue(true);
    mockEvm.isEvmNetwork.mockReturnValue(true);
    mockRedis.get.mockResolvedValue(null);
    mockWeb3.instance.eth.getBalance.mockRejectedValue(
      new Error("RPC Timeout")
    );

    await expect(service.getBalance("0x123")).rejects.toThrow(
      "Unable to get balance: RPC Timeout"
    );
  });
});
