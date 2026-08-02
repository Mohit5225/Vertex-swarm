import type { ContextPolicyData } from './contextPolicyTypes'

export type { ContextPolicyData, ContextPolicyFieldRange } from './contextPolicyTypes'

export const DEFAULT_CONTEXT_POLICY: ContextPolicyData = {
  version: 1,
  budget: {
    max_total_tokens: 100_000,
    reserve_for_reply_tokens: 8_000,
  },
  text: {
    compaction_enabled: true,
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
} as const

export const formatMegabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`

export const formatTokenCount = (tokens: number): string =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

export const getImageSaveLimits = (policy: ContextPolicyData) => ({
  maxAttachments: policy.images.save_max_count,
  maxAttachmentBytes: policy.images.save_max_bytes,
})
