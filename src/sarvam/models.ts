export const SARVAM_MODELS = [
  "sarvam-105b",
  "sarvam-105b-32k",
  "sarvam-30b",
  "sarvam-30b-16k"
] as const;

export type SarvamModel = (typeof SARVAM_MODELS)[number];
