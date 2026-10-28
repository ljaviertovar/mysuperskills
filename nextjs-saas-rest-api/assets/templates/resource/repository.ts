// src/server/meal-plans/repository.ts
// The seam between business logic and the data layer. The interface and the contract below are fixed; the body of
// `createMealPlanRepository` is PROJECT-OWNED: implement it with whatever the project uses (ORM, SQL driver, SDK,
// another service). `repository.memory.ts` is a reference implementation used by the tests.
import type { Principal } from '@/lib/api/auth';
import type { MealPlanCursor, MealPlanFilter, MealPlanPatch, MealPlanRow, NewMealPlan } from './model';

export type { MealPlanFilter, MealPlanPatch, NewMealPlan };

// Every implementation MUST:
//  1. Scope EVERY query by `principal.tenantId` (list, find, update, delete). The tenant never comes from callers.
//  2. Return only the columns of MealPlanRow: select an explicit list, never the whole record.
//  3. list(): order by (created_at, public_id) in the filter's direction, honor the keyset `cursor` on BOTH columns,
//     return up to `filter.limit + 1` rows (the extra row tells the service whether another page exists), and pass
//     every value to the data layer as a bound parameter, never spliced into a query string.
//  4. updateIfVersion(): apply the patch only when the stored version equals `expectedVersion`, in ONE atomic
//     statement (UPDATE ... WHERE version = $n), bump the version, and return null when nothing matched.
//  5. Treat soft-deleted records as absent. Never expose the internal primary key.
//  6. Translate data-layer failures into DomainError: unique violation -> 'conflict', foreign key / check
//     violation -> 'invalid', connection or timeout -> 'unavailable'. Anything unexpected is rethrown (logged 500).
//  7. Back every list order with a composite index that matches it column for column and direction for direction:
//     (tenant, [each equality filter such as status], created_at DESC, public_id DESC), partial on "not deleted"
//     when soft delete is used. Without it keyset pagination degrades into a scan as the table grows. Also a unique
//     index on public_id and on any natural key the API treats as unique (see patterns, "Indexes").
//  8. Accept and forward the request's AbortSignal (ApiContext.signal) when the data layer supports cancellation.
//  9. The tenant filter in rule 1 is the first wall. Add a second one in the database (row-level security, schema
//     or credentials per tenant) or state why the store can't have one: see patterns, "Database-level tenant
//     isolation". Say which in the reply.
export interface MealPlanRepository {
  list(filter: MealPlanFilter, cursor: MealPlanCursor | null): Promise<MealPlanRow[]>;
  findById(id: string): Promise<MealPlanRow | null>;
  insert(input: NewMealPlan): Promise<MealPlanRow>; // stamps tenant and author from the principal
  updateIfVersion(id: string, patch: MealPlanPatch, expectedVersion: number): Promise<MealPlanRow | null>;
  softDelete(id: string): Promise<boolean>; // false when nothing matched
}

export function createMealPlanRepository(_principal: Principal): MealPlanRepository {
  // Fails closed until implemented.
  throw new Error('createMealPlanRepository is not implemented: write it against the project data layer (see rules above).');
}
