import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";

export const REDIS = Symbol("REDIS");

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () =>
        new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
          // BullMQ requires this to be null (it blocks on BRPOPLPUSH and
          // friends); ioredis's default of 20 retries would abort those.
          maxRetriesPerRequest: null,
        }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
