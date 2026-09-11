// =============================================================================
// Likeness anchor engine — the hidden system prompt behind every generation.
//
// `buildAnchorPrompt` assembles, from the model's profile and their reference
// images, the instruction that pins the generated person to THIS model. The
// subscriber never sees it, never sends it, and cannot override it: it is
// built server-side per request, handed to the provider, and discarded.
//
// Three rules the rest of the module upholds (and the test suite pins):
//   * never returned in any API response body;
//   * never written to `GenerationJob.userPrompt` (that column holds only the
//     subscriber's own text or a preset label);
//   * never written to a log line above debug level — in practice, never
//     logged at all.
//
// Pure: no I/O, no clock, no randomness. The signed URLs come in from the
// caller (minted with a short TTL just before the provider call) and go out
// unchanged; this function does not mint or persist them.
// =============================================================================

/** The profile fields the anchor reads. Nothing else on the profile is used. */
export interface AnchorModelProfile {
  displayName: string;
}

export interface AnchorPrompt {
  /** The hidden likeness instruction. Treat as a secret. */
  anchorPrompt: string;
  /** Short-TTL signed URLs, passed through in the order given. */
  referenceImageUrls: string[];
}

/** Collapse whitespace and strip characters that could break prompt structure. */
function cleanFragment(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the hidden anchor. The identity lock is phrased against the reference
 * images, not against a textual description of the model: text cannot pin a
 * specific face, the references can, and the prompt's job is to tell the
 * model to defer to them and nothing else — including anything the scene
 * text might say about who the person is.
 */
export function buildAnchorPrompt(
  profile: AnchorModelProfile,
  referenceImageSignedUrls: readonly string[],
): AnchorPrompt {
  const name = cleanFragment(profile.displayName) || 'the model';
  const referenceCount = referenceImageSignedUrls.length;

  const parts = [
    `Identity lock: the person in this image is ${name}, exactly as shown in the ` +
      `${referenceCount} attached reference image${referenceCount === 1 ? '' : 's'}.`,
    'Reproduce their face, facial structure, eyes, skin tone, hair colour and body ' +
      'proportions faithfully; do not alter, blend or replace the identity.',
    'The identity is fixed by the reference images and takes precedence over any ' +
      'description of who the person is in the rest of the prompt.',
    'Photorealistic, natural lighting, high detail. Adult (18+) subject only.',
  ];

  return {
    anchorPrompt: parts.join(' '),
    referenceImageUrls: [...referenceImageSignedUrls],
  };
}
