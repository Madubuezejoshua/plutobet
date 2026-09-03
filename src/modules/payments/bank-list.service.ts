import { redis } from "@/db/redis";
import type { BankOption, PaymentProvider } from "./provider";
import { paymentProvider } from "./factory";

/**
 * The list of banks a withdrawal can be paid to.
 *
 * WHY THIS EXISTS AT ALL. The withdrawal form asked the customer to type a NIP
 * bank code from memory. A wrong code does not bounce — it sends real money to
 * a real account at a different institution, and the first anyone hears of it
 * is a support ticket about a missing withdrawal.
 *
 * WHY THE LIST IS NEVER WRITTEN DOWN HERE. Nigerian bank codes change: banks
 * merge, microfinance banks appear and are delisted. A list typed into source is
 * wrong from the day it is written and gets quietly worse. The provider is the
 * only source that is right by construction, because it is the same party that
 * will refuse or accept the transfer.
 *
 * CACHING, AND WHY IT IS LONG. A bank list changes a few times a year, and the
 * provider call costs a network round trip on a page a customer is waiting on.
 * Twelve hours is far shorter than the rate of change and long enough that the
 * provider is asked twice a day rather than once per withdrawal page view.
 *
 * WHAT HAPPENS WHEN THE PROVIDER IS DOWN. The cached list is served past its
 * TTL rather than showing an empty form — a stale list of banks is materially
 * better than no list, since the codes in it were valid twelve hours ago and
 * the transfer itself re-validates. With no cache at all the route says so
 * honestly and the form falls back to accepting a typed code, which is what it
 * did before this existed.
 */

/** Twelve hours. See the note above on why this is deliberately long. */
const FRESH_MS = 12 * 60 * 60_000;

/**
 * Seven days.
 *
 * The window in which a cached list may still be served after it has gone
 * stale, when the provider cannot be reached. Beyond this the data is old
 * enough that offering it is a worse answer than admitting the list is
 * unavailable.
 */
const STALE_MS = 7 * 24 * 60 * 60_000;

const KEY = "payments:banks:v1";

export interface BankListResult {
  banks: BankOption[];
  /** True when the provider was not reached and this came from cache. */
  stale: boolean;
  /** True when neither the provider nor a cache could supply a list. */
  unavailable: boolean;
}

interface CachedList {
  fetchedAt: number;
  banks: BankOption[];
}

export class BankListService {
  constructor(private readonly provider: () => PaymentProvider = paymentProvider) {}

  async list(): Promise<BankListResult> {
    const cached = await this.readCache();

    if (cached && Date.now() - cached.fetchedAt < FRESH_MS) {
      return { banks: cached.banks, stale: false, unavailable: false };
    }

    try {
      const banks = await this.provider().listBanks();

      /*
       * An empty list is treated as a provider failure, not as "there are no
       * banks". Replacing a good cached list with an empty one because a
       * provider had a bad minute would leave every customer unable to
       * withdraw until the next refresh.
       */
      if (banks.length === 0) throw new Error("provider returned no banks");

      await this.writeCache({ fetchedAt: Date.now(), banks });
      return { banks, stale: false, unavailable: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[payments] bank list unavailable from provider: ${reason}`);

      if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
        // Better than an empty form: these codes were valid recently, and the
        // transfer re-validates whichever one is chosen.
        return { banks: cached.banks, stale: true, unavailable: false };
      }
      return { banks: [], stale: false, unavailable: true };
    }
  }

  /**
   * Is this a code the provider will accept?
   *
   * Called on the server before a withdrawal is created. The form supplies a
   * code from the list, but a form is a suggestion — the request is what
   * arrives, and a caller posting directly can put anything in the field.
   *
   * Returns true when the list cannot be established, and that is deliberate.
   * Refusing every withdrawal because a bank list could not be fetched would
   * turn a provider outage into an inability to take money out; the transfer
   * itself still validates the code, and the provider refuses an unknown one.
   * This check exists to catch a typo early with a clear message, not to be the
   * only thing standing between a customer and a wrong bank.
   */
  async isPayableBankCode(bankCode: string): Promise<boolean> {
    const result = await this.list();
    if (result.unavailable || result.banks.length === 0) return true;
    return result.banks.some((bank) => bank.code === bankCode);
  }

  private async readCache(): Promise<CachedList | null> {
    try {
      const raw = await redis.get(KEY);
      if (typeof raw !== "string") return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as CachedList).fetchedAt !== "number" ||
        !Array.isArray((parsed as CachedList).banks)
      ) {
        return null;
      }
      return parsed as CachedList;
    } catch {
      // Redis down, or a value written by something else. Either way there is
      // no usable cache and the provider is the next thing to try.
      return null;
    }
  }

  private async writeCache(value: CachedList): Promise<void> {
    try {
      await redis.set(KEY, JSON.stringify(value), "PX", STALE_MS);
    } catch {
      // A list we could not cache is still a list we can serve.
    }
  }
}

export const bankListService = new BankListService();
export const BANK_LIST_FRESH_MS = FRESH_MS;
export const BANK_LIST_STALE_MS = STALE_MS;
