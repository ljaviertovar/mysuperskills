// src/server/meal-plans/model.ts
// Domain types shared by every API version of this resource. No HTTP, no Zod, no data-layer imports, so v1 and v2
// contracts, the service and any repository implementation can all depend on it without depending on each other.
export const MEAL_PLAN_STATUSES = ['draft', 'active', 'completed'] as const;
export type MealPlanStatus = (typeof MEAL_PLAN_STATUSES)[number];

export const MEAL_PLAN_SORTS = ['created_at', '-created_at'] as const; // '-' = descending
export type MealPlanSort = (typeof MEAL_PLAN_SORTS)[number];

// A stored record as the API layer needs it: public identifier (never the internal one), no tenant or audit columns.
export type MealPlanRow = {
  public_id: string;
  name: string;
  status: MealPlanStatus;
  starts_on: string; // YYYY-MM-DD
  notes: string | null;
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  version: number; // bumps on every update; backs ETag / If-Match
};

export type MealPlanFilter = { status?: MealPlanStatus; sort: MealPlanSort; limit: number };

// Keyset cursor: the last row's sort value + unique id, plus the sort it was issued for.
export type MealPlanCursor = { sort: MealPlanSort; created_at: string; id: string };

export type NewMealPlan = Pick<MealPlanRow, 'name' | 'starts_on' | 'notes' | 'status'>;
export type MealPlanPatch = Partial<Pick<MealPlanRow, 'name' | 'starts_on' | 'notes'>>;
