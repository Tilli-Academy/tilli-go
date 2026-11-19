import { z } from 'zod';
import { CR_STATUSES, DECISION_KEYS, LEVEL_KEYS } from './workflow';
import { createProjectSchema } from '../../validators/projectValidator';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));
const id = z.string().uuid();
const level = z.enum(LEVEL_KEYS);

// Fields a CR can be created with; editing uses the same rules, all optional.
const fields = {
  title: z.string().trim().min(5, 'Title needs at least 5 characters').max(150),
  description: z.string().trim().min(10, 'Describe what changes and why (10+ characters)').max(5000),
  // Managed-list values (ids from /api/lists)
  changeTypeId: id,
  releaseTypeId: id,
  priorityId: id,
  teamId: id.nullable(),
  productIds: z.array(id).min(1, 'Choose at least one product').max(20),
  risk: level,
  impact: level.nullable(),
  customer: z.string().trim().max(100).nullable().transform((v) => v || null),
  labels: z.array(z.string().trim().min(1).max(30)).max(10),
  plannedGoLive: dateOnly,
  dueDate: dateOnly.nullable(),
  datePresented: dateOnly.nullable(),
  codeFreezeDate: dateOnly.nullable(),
  downtimeHours: z.number().min(0).max(1000).nullable(),
  needsCutover: z.boolean(),
  assigneeId: z.string().uuid('Choose an assignee'),
};

export const createChangeSchema = z.object({
  ...fields,
  teamId: fields.teamId.optional(),
  impact: fields.impact.optional(),
  customer: fields.customer.optional(),
  labels: fields.labels.default([]),
  dueDate: fields.dueDate.optional(),
  datePresented: fields.datePresented.optional(),
  codeFreezeDate: fields.codeFreezeDate.optional(),
  downtimeHours: fields.downtimeHours.optional(),
  needsCutover: fields.needsCutover.default(true),
  reporterId: z.string().uuid('Choose a reporter'),
  /** Optional: the project (e.g. release) this change belongs to. */
  projectId: z.string().uuid().optional(),
});
export type CreateChangeDTO = z.infer<typeof createChangeSchema>;

export const updateChangeSchema = z
  .object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>;
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
export type UpdateChangeDTO = z.infer<typeof updateChangeSchema>;

export const transitionSchema = z.object({
  to: z.enum(CR_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

export const decisionSchema = z.object({
  decision: z.enum(DECISION_KEYS as [string, ...string[]]),
  reason: z.string().trim().max(2000).optional(),
  /** Deferred: the later CAB date it moves to */
  datePresented: dateOnly.optional(),
});

export const commentSchema = z.object({
  message: z.string().trim().min(1, 'Comment is empty').max(5000),
});

/** Pick an existing project (null = none), or create a new one. */
export const setProjectSchema = z.union([
  z.object({ projectId: z.string().uuid().nullable() }).strict(),
  z.object({ create: createProjectSchema }).strict(),
]);

/** A supporting document: an uploaded attachment of this CR, or a link. */
export const documentSchema = z.union([
  z.object({ attachmentId: z.string().uuid() }).strict(),
  z.object({ url: z.string().trim().url('Enter a full link (https://…)').max(1000).refine((u) => /^https?:\/\//i.test(u), 'Links must start with http(s)://') }).strict(),
]);

export const linkSchema = z.object({ number: z.number().int().positive() }).strict();
