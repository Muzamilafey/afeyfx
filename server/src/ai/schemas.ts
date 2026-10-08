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
