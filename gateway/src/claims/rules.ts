import type { Category } from '../terminology/fee-schedule';

// Fund rules the agent enforces. Step 5 adds writing these in plain language (parsed by the LLM).
export interface FundRules {
  allowedCategories: Category[];
  weeklyCapPerPatient: number; // USD
  evidenceWindowDays: number;  // how far back a visit record can back a claim
}

const DEFAULT_RULES: FundRules = {
  allowedCategories: ['wound-care', 'medication', 'hygiene', 'transport'],
  weeklyCapPerPatient: 50,
  evidenceWindowDays: 3,
};

const BY_FUND: Record<string, Partial<FundRules>> = {
  'Organization/riverside-fund': {},
};

export function rulesForFund(fundRef?: string): FundRules {
  return { ...DEFAULT_RULES, ...(fundRef ? BY_FUND[fundRef] ?? {} : {}) };
}
