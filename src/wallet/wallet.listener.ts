import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { RedisService } from "../redis/redis.service";
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from "./events/wallet-balance-changed.event";

const ALERTS_KEY = "wallet:alerts";
const MAX_ALERTS = 50;

@Injectable()
export class WalletListener {
  private readonly logger = new Logger(WalletListener.name);

  constructor(private readonly redis: RedisService) {}

  @OnEvent(WALLET_BALANCE_CHANGED)
  async handleBalanceChanged(event: WalletBalanceChangedEvent): Promise<void> {
    try {
      this.logger.log(
        `Processing Balance changed for: ${event.address}: ${event.previousBalance} -> ${event.currentBalance}`
      );

      const payload = JSON.stringify(event);

      await this.redis.lpush(ALERTS_KEY, payload);
      await this.redis.ltrim(ALERTS_KEY, 0, MAX_ALERTS - 1);

      this.logger.debug(`Alert persisted. Key: ${ALERTS_KEY}`);
    } catch (error) {
      this.logger.error(`Failed to persist balance alert: ${error.message}`);

      if (error.message.includes("WRONGTYPE")) {
        await this.redis.del(ALERTS_KEY);
      }
    }
  }
}
