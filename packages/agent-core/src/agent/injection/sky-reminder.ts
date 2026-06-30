import { DynamicInjector } from './injector';

const SKY_REMINDER = [
  'REMINDER: You MUST end every assistant response with a <sky>...</sky> block containing your updated memory summary. This is required even on the first turn and even if you have nothing new to remember — use <sky></sky> (empty) if so.',
].join('\n');

/**
 * Injects a system reminder before every LLM step reminding the model to
 * include a <sky> block when sky_mode is active. Does not deduplicate —
 * the reminder is short and repeating it across tool-loop steps reinforces
 * the behaviour rather than wasting tokens.
 */
export class SkyReminderInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'sky_reminder';

  getInjection(): string | undefined {
    // Sky mode is disabled for local provider (no system prompt context)
    const isLocal = this.agent.config.provider.name === 'local';
    if (isLocal || !this.agent.experimentalFlags.enabled('sky_mode')) return undefined;
    return SKY_REMINDER;
  }
}
