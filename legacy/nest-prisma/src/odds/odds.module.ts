import { BullModule } from "@nestjs/bullmq";
import { Inject, Module } from "@nestjs/common";
import type Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { ApiBudget, FREE_TIER } from "./budget";
import { OddsApiIoProvider } from "./oddsApiIo";
import { OddsProcessor, ODDS_QUEUE } from "./odds.processor";
import { OddsService } from "./odds.service";
import type { OddsProvider } from "./provider";
import { OddsSyncWorker, type SyncConfig } from "./syncWorker";

export const ODDS_PROVIDER = Symbol("ODDS_PROVIDER");
export const SYNC_CONFIG = Symbol("SYNC_CONFIG");

@Module({
  imports: [BullModule.registerQueue({ name: ODDS_QUEUE })],
  providers: [
    PrismaService,
    OddsService,
    OddsProcessor,
    {
      provide: SYNC_CONFIG,
      useValue: {
        sport: "football",
        // Free tier allows exactly 2; order matters — the first one with data
        // for an event becomes the canonical price. Correct these against
        // /bookmakers/selected (see probe.ts) before going anywhere near prod.
        bookmakers: ["bet365", "1xbet"],
      } satisfies SyncConfig,
    },
    {
      provide: ApiBudget,
      useFactory: (redis: Redis) => new ApiBudget(redis, FREE_TIER),
      inject: [REDIS],
    },
    {
      // The single swap point when we outgrow the free tier: implement
      // OddsProvider elsewhere and change this factory. Nothing else in the
      // app imports a vendor type.
      provide: ODDS_PROVIDER,
      useFactory: (budget: ApiBudget) => new OddsApiIoProvider(process.env.ODDS_API_KEY ?? "", budget),
      inject: [ApiBudget],
    },
    {
      provide: OddsSyncWorker,
      useFactory: (provider: OddsProvider, prisma: PrismaService, redis: Redis, cfg: SyncConfig) =>
        new OddsSyncWorker(provider, prisma, redis, cfg),
      inject: [ODDS_PROVIDER, PrismaService, REDIS, SYNC_CONFIG],
    },
  ],
  exports: [OddsService, OddsSyncWorker],
})
export class OddsModule {}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
