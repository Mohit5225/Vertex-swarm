import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ContextPolicyData } from '../lib/contextPolicyTypes'
import {
  CONTEXT_POLICY_RANGES,
  formatMegabytes,
  formatTokenCount,
} from '../lib/contextPolicy'

interface Props {
  policy: ContextPolicyData
  onChange: (policy: ContextPolicyData) => void
}

interface RangeFieldProps {
  label: string
  value: number
  range: { min: number; max: number; step: number }
  formatValue?: (value: number) => string
  onChange: (value: number) => void
}

const RangeField: React.FC<RangeFieldProps> = ({
  label,
  value,
  range,
  formatValue = (v) => String(v),
  onChange,
}) => (
  <div className="context-policy-field">
    <div className="context-policy-field-header">
      <span className="context-policy-field-label">{label}</span>
      <span className="context-policy-field-value">{formatValue(value)}</span>
    </div>
    <input
      type="range"
      min={range.min}
      max={range.max}
      step={range.step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="context-policy-range"
    />
  </div>
)

const ContextPolicySection: React.FC<Props> = ({ policy, onChange }) => {
  const [showAdvanced, setShowAdvanced] = useState(false)

  const patch = (partial: Partial<ContextPolicyData>) => {
    onChange({
      ...policy,
      ...partial,
      budget: { ...policy.budget, ...(partial.budget ?? {}) },
      text: { ...policy.text, ...(partial.text ?? {}) },
      images: { ...policy.images, ...(partial.images ?? {}) },
      files: { ...policy.files, ...(partial.files ?? {}) },
    })
  }

  return (
    <div className="context-policy-section">
      <p className="popover-section-label">Configure context</p>

      <RangeField
        label="Max total context"
        value={policy.budget.max_total_tokens}
        range={CONTEXT_POLICY_RANGES.max_total_tokens}
        formatValue={formatTokenCount}
        onChange={(max_total_tokens) =>
          patch({ budget: { ...policy.budget, max_total_tokens } })
        }
      />

      <label className="context-policy-toggle">
        <input
          type="checkbox"
          checked={policy.text.compaction_enabled}
          onChange={(event) =>
            patch({ text: { ...policy.text, compaction_enabled: event.target.checked } })
          }
        />
        <span>Compact long chats (trim old messages sent to model)</span>
      </label>

      <RangeField
        label="Max upload size"
        value={policy.images.save_max_bytes}
        range={CONTEXT_POLICY_RANGES.save_max_bytes}
        formatValue={formatMegabytes}
        onChange={(save_max_bytes) =>
          patch({ images: { ...policy.images, save_max_bytes } })
        }
      />

      <RangeField
        label="Max images per message"
        value={policy.images.save_max_count}
        range={CONTEXT_POLICY_RANGES.save_max_count}
        onChange={(save_max_count) =>
          patch({ images: { ...policy.images, save_max_count } })
        }
      />

      <button
        type="button"
        className="context-policy-advanced-toggle"
        onClick={() => setShowAdvanced((open) => !open)}
      >
        {showAdvanced ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <span>Advanced</span>
      </button>

      {showAdvanced && (
        <div className="context-policy-advanced">
          <RangeField
            label="Reserve for reply"
            value={policy.budget.reserve_for_reply_tokens}
            range={CONTEXT_POLICY_RANGES.reserve_for_reply_tokens}
            formatValue={formatTokenCount}
            onChange={(reserve_for_reply_tokens) =>
              patch({ budget: { ...policy.budget, reserve_for_reply_tokens } })
            }
          />

          <RangeField
            label="Target tokens per image"
            value={policy.images.target_tokens_per_image}
            range={CONTEXT_POLICY_RANGES.target_tokens_per_image}
            formatValue={formatTokenCount}
            onChange={(target_tokens_per_image) =>
              patch({ images: { ...policy.images, target_tokens_per_image } })
            }
          />

          <RangeField
            label="Max image tokens (total)"
            value={policy.images.max_tokens_for_images_total}
            range={CONTEXT_POLICY_RANGES.max_tokens_for_images_total}
            formatValue={formatTokenCount}
            onChange={(max_tokens_for_images_total) =>
              patch({ images: { ...policy.images, max_tokens_for_images_total } })
            }
          />

          <RangeField
            label="Max image dimension (send)"
            value={policy.images.send_max_long_edge_px}
            range={CONTEXT_POLICY_RANGES.send_max_long_edge_px}
            formatValue={(v) => `${v}px`}
            onChange={(send_max_long_edge_px) =>
              patch({ images: { ...policy.images, send_max_long_edge_px } })
            }
          />

          <RangeField
            label="Max images sent"
            value={policy.images.send_max_count}
            range={CONTEXT_POLICY_RANGES.send_max_count}
            onChange={(send_max_count) =>
              patch({ images: { ...policy.images, send_max_count } })
            }
          />

          <RangeField
            label="Image turns in context"
            value={policy.images.max_turns_in_context}
            range={CONTEXT_POLICY_RANGES.max_turns_in_context}
            onChange={(max_turns_in_context) =>
              patch({ images: { ...policy.images, max_turns_in_context } })
            }
          />

          <RangeField
            label="LLM rounds with images"
            value={policy.images.max_llm_rounds_with_images}
            range={CONTEXT_POLICY_RANGES.max_llm_rounds_with_images}
            onChange={(max_llm_rounds_with_images) =>
              patch({ images: { ...policy.images, max_llm_rounds_with_images } })
            }
          />
        </div>
      )}
    </div>
  )
}

export default ContextPolicySection
