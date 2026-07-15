/** Serial staggered redeem queue — one relayer action at a time per deposit wallet. */

import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { Settings } from "../config.js";
import { formatUtcIsoZ } from "../timeUtils.js";
import { resolveDepositWalletAddress } from "./depositWallet.js";
import { redeemPositionsBatch } from "./redeem.js";

export const REDEEM_SYMBOL_ORDER = ["btc", "eth"] as const;

export function symbolRedeemSlot(symbol: string): number {
  const sym = symbol.toLowerCase().trim();
  const idx = REDEEM_SYMBOL_ORDER.indexOf(sym as (typeof REDEEM_SYMBOL_ORDER)[number]);
  return idx >= 0 ? idx : REDEEM_SYMBOL_ORDER.length;
}

interface HeapEntry {
  scheduledAt: Date;
  seq: number;
  job: RedeemJob;
}

export interface RedeemJobFields {
  conditionId: string;
  adapterAddress: string;
  collateral: string;
  symbol: string;
  epoch: string;
  tag: string;
  marketIndex: number;
  epochEnd: Date;
  slug: string;
  summary: Record<string, unknown>;
  exportPath: string | null;
  yesToken: string;
  noToken: string;
  pollInterval: number;
  clobUrl: string;
  paperTrading: boolean;
  dryRun: boolean;
}

export class RedeemJob {
  conditionId: string;
  adapterAddress: string;
  collateral: string;
  symbol: string;
  epoch: string;
  tag: string;
  marketIndex: number;
  epochEnd: Date;
  slug: string;
  summary: Record<string, unknown>;
  exportPath: string | null;
  yesToken: string;
  noToken: string;
  pollInterval: number;
  clobUrl: string;
  paperTrading: boolean;
  dryRun: boolean;
  scheduledAt: Date | null = null;
  retryCount = 0;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;

  constructor(fields: RedeemJobFields) {
    this.conditionId = fields.conditionId;
    this.adapterAddress = fields.adapterAddress;
    this.collateral = fields.collateral;
    this.symbol = fields.symbol;
    this.epoch = fields.epoch;
    this.tag = fields.tag;
    this.marketIndex = fields.marketIndex;
    this.epochEnd = fields.epochEnd;
    this.slug = fields.slug;
    this.summary = fields.summary;
    this.exportPath = fields.exportPath;
    this.yesToken = fields.yesToken;
    this.noToken = fields.noToken;
    this.pollInterval = fields.pollInterval;
    this.clobUrl = fields.clobUrl;
    this.paperTrading = fields.paperTrading;
    this.dryRun = fields.dryRun;
  }

  wait(): Promise<void> {
    if (!this.donePromise) {
      this.donePromise = new Promise<void>((resolve) => {
        this.doneResolve = resolve;
      });
    }
    return this.donePromise;
  }

  markDone(): void {
    this.doneResolve?.();
  }
}

async function postRedeemMonitorOrderbooks(
  clobBaseUrl: string,
  yesTokenId: string,
  noTokenId: string,
  durationS: number,
  tag: string,
  pollIntervalS: number,
): Promise<void> {
  if (durationS <= 0) return;
  const base = clobBaseUrl.replace(/\/$/, "");
  const end = performance.now() / 1000 + durationS;
  console.log(`  ${tag} POST_REDEEM monitor ${durationS}s`);

  async function bestAsk(tokenId: string): Promise<number> {
    const resp = await fetch(`${base}/book?token_id=${encodeURIComponent(tokenId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return 0;
    const book = (await resp.json()) as { asks?: Array<{ price: string }> };
    const asks = book.asks ?? [];
    if (!asks.length) return 0;
    return Number(asks[0]?.price ?? 0);
  }

  while (performance.now() / 1000 < end) {
    try {
      const [ay, an] = await Promise.all([bestAsk(yesTokenId), bestAsk(noTokenId)]);
      console.log(
        `  ${tag} [POST_REDEEM] YES best_ask=${ay.toFixed(4)} NO best_ask=${an.toFixed(4)} sum=${(ay + an).toFixed(4)}`,
      );
    } catch (e) {
      console.log(`  ${tag} [POST_REDEEM] book error: ${e}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalS * 1000));
  }
}

export class RedeemScheduler {
  private readonly settings: Settings;
  private readonly heap: HeapEntry[] = [];
  private seq = 0;
  private workerRunning = false;
  private wake = false;
  private worker: Promise<void> | null = null;
  private running = false;
  private pendingCount = 0;
  private readonly walletAddr: string;
  private serial: Promise<void> = Promise.resolve();

  constructor(settings: Settings) {
    this.settings = settings;
    const exe = settings.execution;
    if ((exe.private_key || "").trim()) {
      this.walletAddr = resolveDepositWalletAddress({
        privateKey: exe.private_key,
        chainId: exe.chain_id,
        configuredFunder: exe.funder || "",
      });
    } else {
      this.walletAddr = "";
    }
  }

  start(): void {
    if (!this.worker) {
      this.running = true;
      this.worker = this.workerLoop();
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.wake = true;
    if (this.worker) {
      await this.worker.catch(() => undefined);
      this.worker = null;
    }
  }

  get pending(): number {
    return this.pendingCount + this.heap.length;
  }

  private scheduleAt(job: RedeemJob): Date {
    const lm = this.settings.liquidity_maker;
    const gap = lm.redeem_per_symbol_gap_seconds ?? 10;
    const delay = lm.redeem_delay_seconds ?? 120;
    const slot = symbolRedeemSlot(job.symbol);
    return new Date(job.epochEnd.getTime() + (delay + slot * gap) * 1000);
  }

  async schedule(job: RedeemJob, options?: { wait?: boolean }): Promise<void> {
    if (options?.wait) {
      void job.wait();
    }
    job.scheduledAt = this.scheduleAt(job);
    this.seq += 1;
    this.heap.push({ scheduledAt: job.scheduledAt, seq: this.seq, job });
    this.heap.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.seq - b.seq);
    this.pendingCount += 1;
    this.start();
    this.wake = true;
    if (options?.wait) await job.wait();
  }

  async drain(): Promise<void> {
    while (this.pending > 0) {
      this.wake = true;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async workerLoop(): Promise<void> {
    while (this.running || this.heap.length > 0) {
      if (this.heap.length === 0) {
        this.wake = false;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          const check = setInterval(() => {
            if (this.wake) {
              clearTimeout(t);
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
        if (!this.running) break;
        continue;
      }

      const entry = this.heap[0]!;
      const now = new Date();
      if (entry.scheduledAt > now) {
        const waitMs = Math.min(1000, entry.scheduledAt.getTime() - now.getTime());
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      this.heap.shift();
      const job = entry.job;
      this.pendingCount = Math.max(0, this.pendingCount - 1);

      const prev = this.serial;
      let release!: () => void;
      this.serial = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        await this.executeJob(job);
      } finally {
        release();
        job.markDone();
      }
    }
    this.running = false;
  }

  private async executeJob(job: RedeemJob): Promise<void> {
    const { tag, summary } = job;
    const lm = this.settings.liquidity_maker;
    const exe = this.settings.execution;

    summary.phase = "REDEEM";

    if (job.paperTrading) {
      summary.redeem_tx = "paper";
      summary.phase = "IDLE";
      return;
    }

    const now = new Date();
    if (job.scheduledAt && job.scheduledAt > now) {
      const waitS = (job.scheduledAt.getTime() - now.getTime()) / 1000;
      console.log(
        `  ${tag} REDEEM waiting ${Math.floor(waitS)}s (stagger slot=${symbolRedeemSlot(job.symbol)})...`,
      );
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }

    if (job.retryCount > 0) {
      console.log(`  ${tag} REDEEM retry #${job.retryCount} condition=${job.conditionId.slice(0, 18)}...`);
    }

    if (job.dryRun) {
      summary.redeem_tx = "dry_run";
      summary.phase = "IDLE";
      return;
    }

    const redeemResult = await redeemPositionsBatch({
      conditionIds: [job.conditionId],
      privateKey: exe.private_key,
      rpcUrl: exe.rpc_url,
      chainId: exe.chain_id,
      useRelayer: true,
      credIndex: job.marketIndex,
      ctfAddress: job.adapterAddress,
      collateralToken: job.collateral,
      apiKey: process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_KEY || null,
      apiSecret: process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_SECRET || null,
      apiPassphrase: process.env.POLYBOT5MBES_EXECUTION__BUILDER_API_PASSPHRASE || null,
      builderCredRotationSeconds: exe.builder_cred_rotation_seconds ?? 0,
      builderCredRotationStaggerMarkets: exe.builder_cred_rotation_stagger_markets ?? false,
      depositWalletAddress: this.walletAddr,
    });

    const err = redeemResult.error;
    if (err) {
      summary.error = `Redeem failed: ${err}`;
      console.log(`  ${tag} REDEEM ERROR: ${err}`);
      const maxRetries = lm.redeem_max_retries ?? 5;
      if (job.retryCount < maxRetries) {
        job.retryCount += 1;
        const retryGap = lm.redeem_retry_delay_seconds ?? 10;
        job.scheduledAt = new Date(Date.now() + retryGap * 1000);
        this.seq += 1;
        this.heap.push({ scheduledAt: job.scheduledAt, seq: this.seq, job });
        this.heap.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.seq - b.seq);
        this.pendingCount += 1;
        this.wake = true;
        console.log(`  ${tag} REDEEM re-queued in ${retryGap}s (attempt ${job.retryCount}/${maxRetries})`);
      }
    } else {
      summary.redeem_tx = redeemResult.txHash;
      console.log(`  ${tag} REDEEM OK tx=${summary.redeem_tx}`);
    }

    const postRedeemS = lm.post_redeem_monitor_seconds ?? 0;
    if (postRedeemS > 0 && !err) {
      await postRedeemMonitorOrderbooks(
        job.clobUrl,
        job.yesToken,
        job.noToken,
        postRedeemS,
        tag,
        job.pollInterval,
      );
    }

    if (job.exportPath) {
      try {
        let rows: Record<string, unknown>[] = [];
        try {
          const raw = await readFile(job.exportPath, "utf8");
          if (raw.trim()) rows = JSON.parse(raw) as Record<string, unknown>[];
        } catch {
          rows = [];
        }
        rows.push({
          ts_utc: formatUtcIsoZ(new Date()),
          type: "redeem",
          symbol: job.symbol,
          epoch: job.epoch,
          slug: job.slug,
          condition_id: job.conditionId,
          adapter: job.adapterAddress,
          tx_hash: summary.redeem_tx,
          error: summary.error,
          retry_count: job.retryCount,
        });
        await mkdir(job.exportPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
        await writeFile(job.exportPath, JSON.stringify(rows, null, 2));
      } catch (e) {
        console.log(`  Export write error: ${e}`);
      }
    }

    summary.phase = "IDLE";
  }
}
