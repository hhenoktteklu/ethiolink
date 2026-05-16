// EthioLink — scheduled featuring sweep Lambda.
//
// Phase 9 Track 6. EventBridge-driven Lambda invoked every 15
// minutes. Each run:
//
//   * Expires ACTIVE featuring subscriptions whose `ends_at` is
//     in the past → flips them to `EXPIRED`.
//   * Purges PENDING_PAYMENT rows older than the 10-minute TTL
//     (abandoned checkout sessions).
//   * Recomputes `business_profiles.featured_until` for every
//     affected business → MAX(ends_at) across remaining ACTIVE
//     rows, or NULL when none.
//
// The runtime is independent of `config.featuring.enabled` — even
// when the public opt-in is off, ACTIVE rows (admin-comp'd or
// previously-paid) still need to expire on schedule.
//
// Return value: a `FeaturingSweepSummary` echoed back to
// CloudWatch + the manual `aws lambda invoke` test path.

import type { ScheduledEvent } from 'aws-lambda';

import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgFeaturingRepository } from '../../shared/domains/featuring/featuringRepository.js';
import {
    FeaturingService,
    type ExpireSweepResult,
} from '../../shared/domains/featuring/featuringService.js';
import { createLogger } from '../../shared/logging/logger.js';

export interface FeaturingSweepSummary {
    readonly expiredCount: number;
    readonly purgedPendingCount: number;
    readonly recomputedCount: number;
}

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
const featuringService = new FeaturingService({
    featuringRepo: new PgFeaturingRepository(pool),
    businessRepo: new PgBusinessRepository(pool),
    // The sweep never authorizes anything — it only flips status
    // columns and recomputes `featured_until`. CashGateway is
    // wired as a no-op placeholder so the service constructor
    // doesn't need a different shape.
    paymentGateway: new CashGateway(),
    config: config.featuring,
});

export const handler = async (
    event: ScheduledEvent,
): Promise<FeaturingSweepSummary> => {
    const logger = baseLogger.child({
        handler: 'scheduled.featuringSweep',
        ruleArn: event.resources?.[0],
    });

    const result: ExpireSweepResult = await featuringService.expireSweep();

    const summary: FeaturingSweepSummary = Object.freeze({
        expiredCount: result.expiredBusinessIds.length,
        purgedPendingCount: result.purgedPendingCount,
        recomputedCount: result.recomputedBusinessIds.length,
    });

    logger.info('Featuring sweep complete.', summary);
    return summary;
};
