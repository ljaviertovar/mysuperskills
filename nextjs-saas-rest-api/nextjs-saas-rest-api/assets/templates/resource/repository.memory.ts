// src/server/meal-plans/repository.memory.ts
// Reference implementation of MealPlanRepository over an array. It follows every rule in repository.ts, so the
// route tests exercise real pagination, tenant isolation and optimistic concurrency without a database.
// Tests and examples ONLY: never wire this into a deployed route.
import type { Principal } from '@/lib/api/auth';
import type { MealPlanCursor, MealPlanFilter, MealPlanPatch, MealPlanRow, NewMealPlan } from './model';
import type { MealPlanRepository } from './repository';

type StoredRow = MealPlanRow & { tenant_id: string; created_by: string; deleted_at: string | null };

export const memoryStore = {
  rows: [] as StoredRow[],
  failNext: null as Error | null, // makes the next repository call throw (dependency-failure tests)
  reset() {
    this.rows = [];
    this.failNext = null;
  },
};

function maybeFail(): void {
  if (memoryStore.failNext) {
    const err = memoryStore.failNext;
    memoryStore.failNext = null;
    throw err;
  }
}

const compare = (a: { created_at: string; public_id: string }, b: { created_at: string; public_id: string }): number =>
  a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0;

const toRow = ({ tenant_id: _t, created_by: _c, deleted_at: _d, ...row }: StoredRow): MealPlanRow => row;

export function createMemoryMealPlanRepository(principal: Principal): MealPlanRepository {
  const visible = (): StoredRow[] => memoryStore.rows.filter((r) => r.tenant_id === principal.tenantId && r.deleted_at === null);
  const find = (id: string): StoredRow | undefined => visible().find((r) => r.public_id === id);

  return {
    async list(filter: MealPlanFilter, cursor: MealPlanCursor | null) {
      maybeFail();
      const dir = filter.sort === 'created_at' ? 1 : -1;
      let rows = visible()
        .filter((r) => !filter.status || r.status === filter.status)
        .sort((a, b) => dir * compare(a, b));
      if (cursor) rows = rows.filter((r) => dir * compare(r, { created_at: cursor.created_at, public_id: cursor.id }) > 0);
      return rows.slice(0, filter.limit + 1).map(toRow);
    },

    async findById(id: string) {
      maybeFail();
      const row = find(id);
      return row ? toRow(row) : null;
    },

    async insert(input: NewMealPlan) {
      maybeFail();
      const now = new Date().toISOString();
      const row: StoredRow = {
        ...input,
        public_id: crypto.randomUUID(),
        tenant_id: principal.tenantId,
        created_by: principal.userId,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      memoryStore.rows.push(row);
      return toRow(row);
    },

    async updateIfVersion(id: string, patch: MealPlanPatch, expectedVersion: number) {
      maybeFail();
      const row = find(id);
      if (!row || row.version !== expectedVersion) return null;
      Object.assign(row, patch, { version: row.version + 1, updated_at: new Date().toISOString() });
      return toRow(row);
    },

    async softDelete(id: string) {
      maybeFail();
      const row = find(id);
      if (!row) return false;
      row.deleted_at = new Date().toISOString();
      return true;
    },
  };
}
