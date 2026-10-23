/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 *
 * Preview and confirmation receipts. They live in this process only: nothing is
 * written to disk, and a restart forgets every preview and receipt. Creations
 * still carry the requestId as the native Idempotency-Key, which OpenAI uses to
 * avoid a duplicate when the same approved creation is sent again.
 */
import { adsHash } from "./schema.js";
import { OpenAIAdsError } from "./client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AdsMutationState = "PREVIEW" | "APPLYING" | "APPLIED" | "REJECTED" | "UNKNOWN";
export type AdsMutationRow = { id: string; requestId: string; accountId: string; tool: string; fingerprint: string; before: unknown; state: AdsMutationState; expiresAt: string; createdAt: number; result?: any };

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_ROWS = 2000;

/** Process-local store. Claims are synchronous, so two confirmations cannot both apply. */
export class MemoryMutationStore {
  private readonly rows = new Map<string, AdsMutationRow>();
  private readonly byRequest = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now) {}

  preview(input: Omit<AdsMutationRow, "id" | "state" | "expiresAt" | "createdAt">): AdsMutationRow {
    const existing = this.byRequest.get(input.requestId);
    if (existing && this.rows.has(existing)) return this.rows.get(existing)!;
    this.evict();
    const row: AdsMutationRow = { ...input, id: crypto.randomUUID(), state: "PREVIEW", createdAt: this.now(), expiresAt: new Date(this.now() + PREVIEW_TTL_MS).toISOString() };
    this.rows.set(row.id, row);
    this.byRequest.set(row.requestId, row.id);
    return row;
  }
  read(id: string): AdsMutationRow | null { return this.rows.get(id) ?? null; }
  claim(id: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.state !== "PREVIEW" || Date.parse(row.expiresAt) <= this.now()) return false;
    row.state = "APPLYING";
    return true;
  }
  finish(id: string, state: AdsMutationState, result: unknown): void {
    const row = this.rows.get(id);
    if (!row || row.state !== "APPLYING") throw new OpenAIAdsError(503, "RECEIPT_NOT_SAVED", "The mutation receipt could not be recorded. Inspect the provider before any replacement.");
    row.state = state; row.result = result;
  }
  /** Drops expired previews first, then the oldest settled receipts. Uncertain receipts are kept. */
  private evict(): void {
    if (this.rows.size < MAX_ROWS) return;
    const now = this.now();
    const drop = (row: AdsMutationRow) => { this.rows.delete(row.id); if (this.byRequest.get(row.requestId) === row.id) this.byRequest.delete(row.requestId); };
    for (const row of [...this.rows.values()]) if (row.state === "PREVIEW" && Date.parse(row.expiresAt) <= now) drop(row);
    const settled = [...this.rows.values()].filter(r => r.state === "APPLIED" || r.state === "REJECTED" || r.state === "PREVIEW").sort((a, b) => a.createdAt - b.createdAt);
    while (this.rows.size >= MAX_ROWS && settled.length) drop(settled.shift()!);
  }
}

export class OpenAIAdsMutations {
  constructor(private readonly runtime: { store: MemoryMutationStore; authorize(accountId: string, apply: boolean): void; now?: () => number }) {}

  status(accountId: string, id: string): AdsMutationRow {
    this.runtime.authorize(accountId, false);
    const row = this.runtime.store.read(id);
    if (!row || row.accountId !== accountId) throw new OpenAIAdsError(404, "MUTATION_NOT_FOUND", "No preview or receipt with this ID exists in this server process. Receipts are kept in memory and a restart forgets them.");
    return row;
  }

  async run(accountId: string, tool: string, requestId: string, args: unknown, confirm: boolean, token: string | undefined, capture: () => Promise<unknown>, apply: () => Promise<any>, verify: (r: any) => Promise<unknown>, extra: Record<string, unknown> = {}) {
    this.runtime.authorize(accountId, confirm);
    const fingerprint = await adsHash({ accountId, tool, requestId, args });
    const now = () => this.runtime.now?.() ?? Date.now();
    if (!confirm) {
      const before = await capture();
      const r = token ? this.status(accountId, token) : this.runtime.store.preview({ accountId, tool, requestId, fingerprint, before });
      if (r.fingerprint !== fingerprint || r.tool !== tool) throw new OpenAIAdsError(409, "PREVIEW_CHANGED", "This requestId belongs to different arguments. Use a new requestId for a different change.");
      return { applied: false, action: tool, change: args, before: r.before, requestId, confirmationToken: r.id, expiresAt: r.expiresAt, state: r.state, ...extra, nextAction: "Show this exact preview. Apply only after explicit approval, with the same requestId, arguments and confirmationToken. Never retry a write automatically." };
    }
    if (!token) throw new OpenAIAdsError(400, "CONFIRMATION_REQUIRED", "Call once without confirm to obtain a preview and its confirmationToken, then confirm that exact preview.");
    const r = this.status(accountId, token);
    if (r.fingerprint !== fingerprint || r.tool !== tool) throw new OpenAIAdsError(409, "PREVIEW_CHANGED", "The approved arguments changed. Obtain a fresh preview.");
    if (r.state === "APPLIED") {
      // A later confirmation reconciles the acknowledged write through reads only, never another submission.
      let verification: unknown;
      try { verification = await verify(r.result.result); } catch { verification = { confirmed: false, reason: "Native reconciliation unavailable. The acknowledged write was not resubmitted." }; }
      const incomplete = (verification as { confirmed?: boolean } | undefined)?.confirmed === false;
      return { ...r.result, applied: true, replayedReceipt: true, mutationId: r.id, originalVerification: r.result.verification, verification, reconciledAtUtc: new Date(now()).toISOString(), reconciliationRequired: incomplete, message: incomplete ? "Native verification remains incomplete. Keep the acknowledged ID; no write was resubmitted." : "The acknowledged receipt was reconciled through native reads only." };
    }
    if (r.state !== "PREVIEW") return { applied: false, mutationId: r.id, state: r.state, reconciliationRequired: true, nextAction: "Read the receipt with openai_ads_get_mutation and the native state. This mutation cannot be replayed." };
    if (Date.parse(r.expiresAt) <= now()) throw new OpenAIAdsError(409, "PREVIEW_EXPIRED", "This preview expired after 30 minutes. Preview the change again with a new requestId.");
    if (!this.runtime.store.claim(r.id)) throw new OpenAIAdsError(409, "MUTATION_BUSY", "This mutation was already claimed. Read its receipt.");
    let submitted = false;
    try {
      this.runtime.authorize(accountId, true);
      if (await adsHash(await capture()) !== await adsHash(r.before)) throw new OpenAIAdsError(409, "STALE_PREVIEW", "The native state changed after the preview. No write was submitted.");
      submitted = true;
      const result = await apply();
      let verification: unknown;
      try { verification = await verify(result); } catch { verification = { confirmed: false, reason: "Native readback unavailable. Keep the acknowledged IDs and reconcile before continuing." }; }
      const incomplete = (verification as { confirmed?: boolean } | undefined)?.confirmed === false;
      const receipt = { applied: true, action: tool, requestId, mutationId: r.id, result, verification, ...(incomplete ? { reconciliationRequired: true, message: "The provider acknowledged the write, but native verification is incomplete. Keep the IDs and inspect the receipt; never create a replacement automatically." } : {}) };
      this.runtime.store.finish(r.id, "APPLIED", receipt);
      return receipt;
    } catch (error) {
      const e = error instanceof OpenAIAdsError ? error : new OpenAIAdsError(502, "SUBMISSION_UNCERTAIN", "The provider may have accepted the write. Inspect native state; do not repeat it.");
      const rejected = !submitted || e.status >= 400 && e.status < 500;
      const state = rejected ? "REJECTED" : "UNKNOWN";
      try { this.runtime.store.finish(r.id, state, { code: e.code, submitted }); } catch { /* An APPLYING receipt stays non-replayable. */ }
      if (rejected) throw e;
      return { applied: false, action: tool, mutationId: r.id, requestId, state: "UNKNOWN", reconciliationRequired: true, nextAction: "The write may have succeeded. Read native state and this receipt; do not resubmit or create a replacement automatically." };
    }
  }
}
