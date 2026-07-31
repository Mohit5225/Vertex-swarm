import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const CONTEXT_POLICY_VERSION = 1;
export const CONTEXT_POLICY_FILENAME = 'context-policy.json';

export interface ContextPolicyBudget {
  max_total_tokens: number;
  reserve_for_reply_tokens: number;
}

export interface ContextPolicyText {
  compaction_enabled: boolean;
  max_history_tokens: number | null;
}

export interface ContextPolicyImages {
  save_max_bytes: number;
  save_max_count: number;
  send_max_long_edge_px: number;
  send_max_bytes_per_image: number;
  send_max_count: number;
  max_turns_in_context: number;
  max_llm_rounds_with_images: number;
  target_tokens_per_image: number;
  max_tokens_for_images_total: number;
}

export interface ContextPolicyFiles {
  enabled: boolean;
}

export interface ContextPolicy {
  version: number;
  budget: ContextPolicyBudget;
  text: ContextPolicyText;
  images: ContextPolicyImages;
  files: ContextPolicyFiles;
}

export interface ContextPolicyFieldRange {
  min: number;
  max: number;
  step: number;
}

export const CONTEXT_POLICY_RANGES = {
  max_total_tokens: { min: 8_000, max: 200_000, step: 1_000 },
  reserve_for_reply_tokens: { min: 1_000, max: 32_000, step: 500 },
  save_max_bytes: { min: 1 * 1024 * 1024, max: 20 * 1024 * 1024, step: 512 * 1024 },
  save_max_count: { min: 1, max: 16, step: 1 },
  send_max_long_edge_px: { min: 512, max: 2048, step: 64 },
  send_max_bytes_per_image: { min: 256 * 1024, max: 10 * 1024 * 1024, step: 256 * 1024 },
  send_max_count: { min: 1, max: 16, step: 1 },
  max_turns_in_context: { min: 1, max: 10, step: 1 },
  max_llm_rounds_with_images: { min: 1, max: 50, step: 1 },
  target_tokens_per_image: { min: 200, max: 4_000, step: 100 },
  max_tokens_for_images_total: { min: 500, max: 32_000, step: 500 },
} as const satisfies Record<string, ContextPolicyFieldRange>;

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  version: CONTEXT_POLICY_VERSION,
  budget: {
    max_total_tokens: 100_000,
    reserve_for_reply_tokens: 8_000,
  },
  text: {
    compaction_enabled: false,
    max_history_tokens: null,
  },
  images: {
    save_max_bytes: 10 * 1024 * 1024,
    save_max_count: 8,
    send_max_long_edge_px: 1568,
    send_max_bytes_per_image: 4 * 1024 * 1024,
    send_max_count: 8,
    max_turns_in_context: 1,
    max_llm_rounds_with_images: 10,
    target_tokens_per_image: 1100,
    max_tokens_for_images_total: 8_000,
  },
  files: {
    enabled: false,
  },
};

const clamp = (value: number, range: ContextPolicyFieldRange): number => {
  const stepped =
    range.step > 0
      ? Math.round(value / range.step) * range.step
      : value;
  return Math.min(range.max, Math.max(range.min, stepped));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readNumber = (
  source: Record<string, unknown>,
  key: string,
  range: ContextPolicyFieldRange,
  fallback: number,
): number => {
  const raw = source[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return clamp(raw, range);
};

export const normalizeContextPolicy = (input: unknown): ContextPolicy => {
  const base = DEFAULT_CONTEXT_POLICY;
  if (!isRecord(input)) {
    return structuredClone(base);
  }

  const budget = isRecord(input.budget) ? input.budget : {};
  const text = isRecord(input.text) ? input.text : {};
  const images = isRecord(input.images) ? input.images : {};
  const files = isRecord(input.files) ? input.files : {};

  const maxHistoryRaw = text.max_history_tokens;
  const maxHistoryTokens =
    maxHistoryRaw === null
      ? null
      : typeof maxHistoryRaw === 'number' && Number.isFinite(maxHistoryRaw)
        ? clamp(maxHistoryRaw, { min: 1_000, max: 200_000, step: 1_000 })
        : base.text.max_history_tokens;

  return {
    version: CONTEXT_POLICY_VERSION,
    budget: {
      max_total_tokens: readNumber(
        budget,
        'max_total_tokens',
        CONTEXT_POLICY_RANGES.max_total_tokens,
        base.budget.max_total_tokens,
      ),
      reserve_for_reply_tokens: readNumber(
        budget,
        'reserve_for_reply_tokens',
        CONTEXT_POLICY_RANGES.reserve_for_reply_tokens,
        base.budget.reserve_for_reply_tokens,
      ),
    },
    text: {
      compaction_enabled:
        typeof text.compaction_enabled === 'boolean'
          ? text.compaction_enabled
          : base.text.compaction_enabled,
      max_history_tokens: maxHistoryTokens,
    },
    images: {
      save_max_bytes: readNumber(
        images,
        'save_max_bytes',
        CONTEXT_POLICY_RANGES.save_max_bytes,
        base.images.save_max_bytes,
      ),
      save_max_count: readNumber(
        images,
        'save_max_count',
        CONTEXT_POLICY_RANGES.save_max_count,
        base.images.save_max_count,
      ),
      send_max_long_edge_px: readNumber(
        images,
        'send_max_long_edge_px',
        CONTEXT_POLICY_RANGES.send_max_long_edge_px,
        base.images.send_max_long_edge_px,
      ),
      send_max_bytes_per_image: readNumber(
        images,
        'send_max_bytes_per_image',
        CONTEXT_POLICY_RANGES.send_max_bytes_per_image,
        base.images.send_max_bytes_per_image,
      ),
      send_max_count: readNumber(
        images,
        'send_max_count',
        CONTEXT_POLICY_RANGES.send_max_count,
        base.images.send_max_count,
      ),
      max_turns_in_context: readNumber(
        images,
        'max_turns_in_context',
        CONTEXT_POLICY_RANGES.max_turns_in_context,
        base.images.max_turns_in_context,
      ),
      max_llm_rounds_with_images: readNumber(
        images,
        'max_llm_rounds_with_images',
        CONTEXT_POLICY_RANGES.max_llm_rounds_with_images,
        base.images.max_llm_rounds_with_images,
      ),
      target_tokens_per_image: readNumber(
        images,
        'target_tokens_per_image',
        CONTEXT_POLICY_RANGES.target_tokens_per_image,
        base.images.target_tokens_per_image,
      ),
      max_tokens_for_images_total: readNumber(
        images,
        'max_tokens_for_images_total',
        CONTEXT_POLICY_RANGES.max_tokens_for_images_total,
        base.images.max_tokens_for_images_total,
      ),
    },
    files: {
      enabled:
        typeof files.enabled === 'boolean' ? files.enabled : base.files.enabled,
    },
  };
};

export class ContextPolicyStore {
  private readonly policyPath: string;

  constructor(baseDir?: string) {
    this.policyPath = path.join(
      baseDir ?? path.join(os.homedir(), '.vertex-swarm'),
      CONTEXT_POLICY_FILENAME,
    );
  }

  getPolicyPath(): string {
    return this.policyPath;
  }

  async load(): Promise<ContextPolicy> {
    try {
      const raw = await fs.readFile(this.policyPath, 'utf8');
      return normalizeContextPolicy(JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_CONTEXT_POLICY);
    }
  }

  async save(policy: ContextPolicy): Promise<ContextPolicy> {
    const normalized = normalizeContextPolicy(policy);
    await fs.mkdir(path.dirname(this.policyPath), { recursive: true });
    await fs.writeFile(
      this.policyPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8',
    );
    return normalized;
  }
}
