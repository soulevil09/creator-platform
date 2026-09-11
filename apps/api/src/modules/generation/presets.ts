// =============================================================================
// Preset prompt fragments — the server-side half of `GENERATION_PRESETS`.
//
// The shared catalog carries what a client needs (id, label, cost). The scene
// text each preset expands to lives here, API-side only: it is not a secret
// the way the anchor prompt is, but it is prompt engineering the browser has
// no reason to download, and keeping it out of `@creator-platform/shared`
// means a client cannot mistake it for something it may edit and send back.
//
// `Record<GenerationPresetId, string>` is keyed by the catalog's ids, so
// adding a preset to the shared catalog without a fragment here — or the
// reverse — fails typecheck rather than 400-ing at runtime.
// =============================================================================
import { GENERATION_PRESETS } from '@creator-platform/shared';

export type GenerationPresetId = (typeof GENERATION_PRESETS)[number]['id'];

export const PRESET_PROMPTS: Record<GenerationPresetId, string> = {
  hair_long_blonde: 'with long, flowing blonde hair, soft studio lighting, medium shot',
  hair_short_dark: 'with a short dark bob haircut, soft studio lighting, medium shot',
  outfit_red_dress: 'wearing an elegant red evening dress, standing, warm ambient light',
  outfit_black_lingerie:
    'wearing black lace lingerie, seated on the edge of a bed, soft bedroom light',
  pose_mirror_selfie: 'taking a mirror selfie with a phone, bathroom mirror, natural light',
  pose_lying_on_bed: 'lying on a bed on white sheets, relaxed pose, morning light through a window',
  scene_beach_sunset: 'on a beach at sunset, golden hour light, ocean in the background',
  scene_neon_city: 'on a city street at night, neon signs, shallow depth of field',
};

export function presetPromptFor(presetId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PRESET_PROMPTS, presetId)
    ? PRESET_PROMPTS[presetId as GenerationPresetId]
    : undefined;
}
