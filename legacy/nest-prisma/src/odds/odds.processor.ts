import { Processor, WorkerHost } from "@nestjs/bullmq";
import { OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Job, Queue } from "bullmq";
import { OddsSyncWorker } from "./syncWorker";

export const ODDS_QUEUE = "odds-sync";

export type OddsJobName = "fixtures" | "odds-delta" | "live-tick";

/**
 * Schedules and runs the three sync jobs. BullMQ repeatable jobs are keyed by
 * name + cron, so re-registering on every boot is idempotent — no duplicate
 * schedules across restarts or across multiple app instances.
 *
 * concurrency stays at 1: these jobs share one upstream budget, and running
 * two at once just races them into the rate limiter for no gain.
 */
@Processor(ODDS_QUEUE, { concurrency: 1 })
export class OddsProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    // Not `worker` — WorkerHost already owns that name for the BullMQ Worker.
    private readonly sync: OddsSyncWorker,
    @InjectQueue(ODDS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.queue.add("fixtures", {}, { repeat: { pattern: "*/30 * * * *" }, removeOnComplete: 50, removeOnFail: 100 });
    await this.queue.add("odds-delta", {}, { repeat: { pattern: "*/5 * * * *" }, removeOnComplete: 50, removeOnFail: 100 });
    await this.queue.add("live-tick", {}, { repeat: { pattern: "* * * * *" }, removeOnComplete: 50, removeOnFail: 100 });
  }

  async process(job: Job): Promise<void> {
    switch (job.name as OddsJobName) {
      case "fixtures":
        return this.sync.syncFixtures();
      case "odds-delta":
        return this.sync.syncOddsDelta();
      case "live-tick":
        return this.sync.syncLiveOdds();
      default:
        throw new Error(`unknown odds job: ${job.name}`);
    }
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
