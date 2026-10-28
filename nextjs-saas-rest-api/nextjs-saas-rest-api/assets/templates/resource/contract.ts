// src/app/api/v1/meal-plans/contract.ts
// The contract of this API version, next to its routes: one Zod schema per input location, the response DTO, and the row -> DTO
// mapper. A v2 gets its own contract.ts under src/app/api/v2/...; the service and model are shared.
// These schemas are also the source of the OpenAPI document (z.toJSONSchema reads the .meta() ids/descriptions).
import { z } from 'zod';
import { cursorParamSchema, limitSchema } from '@/lib/api/pagination';
import {
  MEAL_PLAN_SORTS,
  MEAL_PLAN_STATUSES,
  type MealPlanCursor,
  type MealPlanRow,
} from '@/server/meal-plans/model';

// Path params
export const mealPlanParamsSchema = z.strictObject({ id: z.uuid() });

// Query params: allowlisted filters and sort, bounded limit, opaque cursor. Unknown params are rejected.
export const listMealPlansQuerySchema = z.strictObject({
  status: z.enum(MEAL_PLAN_STATUSES).optional(),
  sort: z.enum(MEAL_PLAN_SORTS).default('-created_at'),
  limit: limitSchema,
  cursor: cursorParamSchema,
});

// Decoded cursor: every field strictly typed because the values end up in a keyset condition.
export const mealPlanCursorSchema = z.strictObject({
  sort: z.enum(MEAL_PLAN_SORTS),
  created_at: z.iso.datetime({ offset: true }),
  id: z.uuid(),
}) satisfies z.ZodType<MealPlanCursor>;

// Request bodies: strict, so unknown fields (tenant_id, status, version...) are rejected, not mass-assigned.
// Field schemas are shared; object schemas are not.
const name = z.string().trim().min(1).max(120).meta({ description: 'Display name.', examples: ['Week 1'] });
const startsOn = z.iso.date().meta({ description: 'First day of the plan (YYYY-MM-DD).' });
const notes = z.string().trim().max(2000).nullable().meta({ description: 'Free text; null clears it.' });

export const createMealPlanBodySchema = z
  .strictObject({ name, starts_on: startsOn, notes: notes.optional() })
  .meta({ id: 'CreateMealPlanV1' });

// PATCH schema is written explicitly instead of createSchema.partial(): in Zod 4 a field with .default() keeps
// applying its default inside .partial(), so a PATCH that omits it would silently reset the stored value.
export const updateMealPlanBodySchema = z
  .strictObject({ name: name.optional(), starts_on: startsOn.optional(), notes: notes.optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field to update.' })
  .meta({ id: 'UpdateMealPlanV1' });

// Response DTO: the public shape. Clients must ignore fields they don't know.
export const mealPlanDtoSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(MEAL_PLAN_STATUSES),
    starts_on: z.iso.date(),
    notes: z.string().nullable(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'MealPlanV1' });
export type MealPlanDto = z.output<typeof mealPlanDtoSchema>;

export function toMealPlanDto(row: MealPlanRow): MealPlanDto {
  return {
    id: row.public_id,
    name: row.name,
    status: row.status,
    starts_on: row.starts_on,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
