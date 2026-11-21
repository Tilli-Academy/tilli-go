import { z } from 'zod';

/** A real IANA zone name (e.g. America/Chicago), as the email and Timeline need. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z.string().max(64).refine(isValidTimeZone, 'timeZone must be a valid zone such as America/Chicago');

export const createProjectSchema = z.object({
  name: z.string().min(1, 'name is required').max(100),
  code: z
    .string()
    .min(1, 'code is required')
    .max(20)
    .regex(
      /^[A-Z0-9][A-Z0-9_-]*$/,
      'code must contain only uppercase letters, digits, hyphens, and underscores',
    ),
  description: z.string().max(1000).optional(),
  timeZone: timeZone.optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(1000).nullable().optional(),
    timeZone: timeZone.optional(),
  })
  .strict();
