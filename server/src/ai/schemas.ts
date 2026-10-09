import { z } from 'zod';

/** Validated shape of Claude's market analysis. Anything that does not match is discarded. */
export const MarketAnalysisSchema = z.object({
  symbol: z.string(),
  signal: z.enum(['LONG', 'SHORT', 'HOLD', 'EXIT']),
  confidence: z.number().min(0).max(1),
  marketRegime: z.enum(['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'ABNORMAL']),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  reason: z.string(),
  keyRisks: z.array(z.string()),
  dataQualityConcerns: z.array(z.string()),
  newsSentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL', 'NONE']).default('NONE'),
});
export type AIMarketAnalysis = z.infer<typeof MarketAnalysisSchema>;

/** JSON schema sent as output_config.format (structured outputs). */
export const MarketAnalysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'signal', 'confidence', 'marketRegime', 'riskLevel', 'reason', 'keyRisks', 'dataQualityConcerns', 'newsSentiment'],
  properties: {
    symbol: { type: 'string' },
    signal: { type: 'string', enum: ['LONG', 'SHORT', 'HOLD', 'EXIT'] },
    confidence: { type: 'number', description: 'Probability-like confidence between 0 and 1' },
    marketRegime: { type: 'string', enum: ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'ABNORMAL'] },
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    reason: { type: 'string' },
    keyRisks: { type: 'array', items: { type: 'string' } },
    dataQualityConcerns: { type: 'array', items: { type: 'string' } },
    newsSentiment: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL', 'NONE'], description: 'Aggregate sentiment of the provided headlines for this symbol; NONE when no news was provided' },
  },
} as const;

export const StrategyReviewSchema = z.object({
  summary: z.string(),
  observations: z.array(z.string()),
  proposals: z.array(
    z.object({
      kind: z.enum(['PARAMETER_CHANGE', 'RISK_ADJUSTMENT', 'NEW_STRATEGY', 'DISABLE_STRATEGY']),
      description: z.string(),
      params: z.record(z.string(), z.number()),
      rationale: z.string(),
      expectedImpact: z.string(),
    }),
  ),
  caveats: z.array(z.string()),
});
export type AIStrategyReview = z.infer<typeof StrategyReviewSchema>;

export const StrategyReviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'observations', 'proposals', 'caveats'],
  properties: {
    summary: { type: 'string' },
    observations: { type: 'array', items: { type: 'string' } },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'description', 'params', 'rationale', 'expectedImpact'],
        properties: {
          kind: { type: 'string', enum: ['PARAMETER_CHANGE', 'RISK_ADJUSTMENT', 'NEW_STRATEGY', 'DISABLE_STRATEGY'] },
          description: { type: 'string' },
          params: { type: 'object', additionalProperties: { type: 'number' } },
          rationale: { type: 'string' },
          expectedImpact: { type: 'string' },
        },
      },
    },
    caveats: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * Deriv market analyst output. Validated before it is shown or used; the bot only treats it as an
 * optional confirmation, and the deterministic risk engine always has the final say.
 */
const REGIMES = ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'ABNORMAL'] as const;
export const DerivAnalysisSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  regime: z.enum(REGIMES),
  assessment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  summary: z.string().max(1500),
  entryConditions: z.array(z.string().max(300)).max(8),
  invalidationConditions: z.array(z.string().max(300)).max(8),
  exitConditions: z.array(z.string().max(300)).max(8),
  confidence: z.number().min(0).max(1),
  confidenceExplanation: z.string().max(600),
  riskReward: z.object({ available: z.boolean(), ratio: z.number().min(0).max(20).nullable(), basis: z.string().max(400) }),
  keyLevels: z.object({ support: z.array(z.number()).max(5), resistance: z.array(z.number()).max(5) }),
  avoidTrading: z.boolean(),
  reasonsToAvoid: z.array(z.string().max(300)).max(8),
  dataQualityWarnings: z.array(z.string().max(300)).max(8),
  strategyNotes: z.array(z.string().max(300)).max(8),
});
export type DerivAnalysis = z.infer<typeof DerivAnalysisSchema>;

const strArr = { type: 'array', items: { type: 'string' } } as const;
export const DerivAnalysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'timeframe', 'regime', 'assessment', 'summary', 'entryConditions', 'invalidationConditions', 'exitConditions', 'confidence', 'confidenceExplanation', 'riskReward', 'keyLevels', 'avoidTrading', 'reasonsToAvoid', 'dataQualityWarnings', 'strategyNotes'],
  properties: {
    symbol: { type: 'string' },
    timeframe: { type: 'string' },
    regime: { type: 'string', enum: [...REGIMES] },
    assessment: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
    summary: { type: 'string', description: '2-5 sentences citing the specific data points' },
    entryConditions: { ...strArr, description: 'Concrete, checkable conditions that would justify an entry (may be empty)' },
    invalidationConditions: { ...strArr, description: 'Conditions that would invalidate the assessment' },
    exitConditions: { ...strArr, description: 'Exit conditions relevant to the product and timeframe' },
    confidence: { type: 'number', description: 'Subjective 0-1 score; NOT a calibrated probability' },
    confidenceExplanation: { type: 'string', description: 'Why this score, and its limitations' },
    riskReward: {
      type: 'object',
      additionalProperties: false,
      required: ['available', 'ratio', 'basis'],
      properties: { available: { type: 'boolean' }, ratio: { type: ['number', 'null'] }, basis: { type: 'string', description: 'How it was computed from the provided levels, or why it cannot be computed responsibly' } },
    },
    keyLevels: { type: 'object', additionalProperties: false, required: ['support', 'resistance'], properties: { support: { type: 'array', items: { type: 'number' } }, resistance: { type: 'array', items: { type: 'number' } } } },
    avoidTrading: { type: 'boolean' },
    reasonsToAvoid: strArr,
    dataQualityWarnings: strArr,
    strategyNotes: { ...strArr, description: 'Comments on the deterministic strategy signals and their historical performance' },
  },
} as const;
