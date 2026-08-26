// Archived pre-migration NestJS entrypoint; not part of the Phase 1 build.
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { OddsModule } from "./odds/odds.module";
import { RedisModule } from "./redis/redis.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({
  imports: [
    RedisModule,
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL ?? "redis://localhost:6379",
      },
    }),
    WalletModule,
    OddsModule,
  ],
})
export class AppModule {}
