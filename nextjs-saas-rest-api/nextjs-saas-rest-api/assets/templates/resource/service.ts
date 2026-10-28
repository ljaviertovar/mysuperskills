// src/server/meal-plans/service.ts
// Version-agnostic business logic. It owns the rules (new plans start as drafts, which failure means 404 versus 412)
// and talks to storage only through MealPlanRepository. Throws DomainError, never HTTP errors.
import { DomainError } from '@/server/domain-errors';
import type { MealPlanCursor, MealPlanFilter, MealPlanPatch, MealPlanRow } from './model';
import type { MealPlanRepository } from './repository';

export type CreateMealPlanInput = { name: string; starts_on: string; notes?: string | null };

export function listMealPlans(repo: MealPlanRepository, filter: MealPlanFilter, cursor: MealPlanCursor | null): Promise<MealPlanRow[]> {
  return repo.list(filter, cursor);
}

export async function getMealPlan(repo: MealPlanRepository, id: string): Promise<MealPlanRow> {
  const row = await repo.findById(id); // null when missing OR owned by another tenant: indistinguishable on purpose
  if (!row) throw new DomainError('not_found', 'Meal plan not found.', 'NOT_FOUND');
  return row;
}

export function createMealPlan(repo: MealPlanRepository, input: CreateMealPlanInput): Promise<MealPlanRow> {
  // Built field by field from validated input; the repository adds tenant and author from the principal.
  return repo.insert({ name: input.name, starts_on: input.starts_on, notes: input.notes ?? null, status: 'draft' });
}

export async function updateMealPlan(
  repo: MealPlanRepository,
  id: string,
  patch: MealPlanPatch,
  expectedVersion: number,
): Promise<MealPlanRow> {
  const updated = await repo.updateIfVersion(id, patch, expectedVersion);
  if (updated) return updated;
  // Nothing matched: decide why. The write never depended on this read, so there is no race to lose.
  await getMealPlan(repo, id); // throws not_found if it doesn't exist or isn't visible
  throw new DomainError('precondition_failed', 'The meal plan was modified by someone else. Fetch it again and retry.', 'PRECONDITION_FAILED');
}

export async function deleteMealPlan(repo: MealPlanRepository, id: string): Promise<void> {
  // Repeating a DELETE yields 404, which keeps it idempotent in effect.
  if (!(await repo.softDelete(id))) throw new DomainError('not_found', 'Meal plan not found.', 'NOT_FOUND');
}
