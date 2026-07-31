export interface ContextPolicyData {
  version: number
  budget: {
    max_total_tokens: number
    reserve_for_reply_tokens: number
  }
  text: {
    compaction_enabled: boolean
    max_history_tokens: number | null
  }
  images: {
    save_max_bytes: number
    save_max_count: number
    send_max_long_edge_px: number
    send_max_bytes_per_image: number
    send_max_count: number
    max_turns_in_context: number
    max_llm_rounds_with_images: number
    target_tokens_per_image: number
    max_tokens_for_images_total: number
  }
  files: {
    enabled: boolean
  }
}

export interface ContextPolicyFieldRange {
  min: number
  max: number
  step: number
}
