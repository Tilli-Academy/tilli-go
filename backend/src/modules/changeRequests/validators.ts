import { z } from 'zod';
import { CHANGE_TYPES, LEVELS, PRIORITIES, PRODUCTS, RELEASE_TYPES } from './options';
import { CR_STATUSES } from './workflow';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

export const createChangeSchema = z.object({
  title: z.string().trim().min(5, 'Title needs at least 5 characters').max(150),
  description: z.string().trim().min(10, 'Describe what changes and why (10+ characters)').max(5000),
  product: z.enum(PRODUCTS),
  changeType: z.enum(CHANGE_TYPES),
  releaseType: z.enum(RELEASE_TYPES),
  priority: z.enum(PRIORITIES),
  impact: z.enum(LEVELS),
  risk: z.enum(LEVELS),
  customer: z.string().trim().max(100).optional().transform((v) => v || undefined),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  plannedGoLive: dateOnly,
  dueDate: dateOnly.optional(),
  needsCutover: z.boolean().default(true),
  assigneeId: z.string().uuid('Choose an assignee'),
  reporterId: z.string().uuid('Choose a reporter'),
});
export type CreateChangeDTO = z.infer<typeof createChangeSchema>;

export const transitionSchema = z.object({
  to: z.enum(CR_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

export const commentSchema = z.object({
  message: z.string().trim().min(1, 'Comment is empty').max(5000),
});
