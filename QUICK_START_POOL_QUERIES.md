# Quick Start: Pool Query Optimization

## TL;DR

Use `lib/db/pools.ts` functions instead of direct Supabase queries for all pool operations.

## Function Reference

### Fetch Paginated Pools
```typescript
import { fetchPools } from '@/lib/db/pools';

// With filters and pagination
const result = await fetchPools(supabase, {
  status: 'active',
  limit: 20,
  offset: 0,
  orderBy: 'created_at',
  orderDirection: 'desc'
});

console.log(result.pools); // Pool[]
console.log(result.hasMore); // boolean
console.log(result.estimatedTotalCount); // number
```

### Fetch Single Pool
```typescript
import { fetchPoolById } from '@/lib/db/pools';

const pool = await fetchPoolById(supabase, 'pool-uuid');
if (pool) {
  console.log(pool.name);
}
```

### Fetch Active Pools (Auto-Matching)
```typescript
import { fetchActivePoolsWithLiquidity } from '@/lib/db/pools';

// Get pools sorted by available liquidity
const pools = await fetchActivePoolsWithLiquidity(supabase, 0);
// Optional: minimum liquidity threshold
const richPools = await fetchActivePoolsWithLiquidity(supabase, 50000);
```

### Fetch Admin Dashboard Data
```typescript
import { fetchAdminDashboardPools } from '@/lib/db/pools';

const { pools, pendingLoans } = await fetchAdminDashboardPools(supabase);
```

## API Endpoint

GET `/api/pools`

**Query Parameters**:
- `status`: 'active' | 'paused' | 'closed' (optional)
- `limit`: 1-100 (default: 10)
- `offset`: number (default: 0)
- `orderBy`: 'created_at' | 'available_liquidity' (default: 'created_at')
- `orderDirection`: 'asc' | 'desc' (default: 'desc')

**Response**:
```json
{
  "success": true,
  "pools": [
    {
      "id": "uuid",
      "name": "Pool Name",
      "description": "...",
      "status": "active",
      "apr_bps": 1500,
      "total_liquidity": 100000,
      "available_liquidity": 50000,
      "total_borrowed": 50000,
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "hasMore": true,
    "estimatedTotal": 45
  }
}
```

## Do's and Don'ts

### ✅ DO
```typescript
// Use the optimized functions
const pools = await fetchPools(supabase);

// Explicit columns in custom queries
.select("id, name, status, apr_bps")

// Parallel queries
await Promise.all([
  fetchPools(supabase),
  fetchAdminDashboardPools(supabase)
])
```

### ❌ DON'T
```typescript
// Don't use SELECT *
.select("*")

// Don't make sequential/waterfall queries
const pools = await fetchPools(supabase);
const loans = await fetchLoans(supabase); // Wait, should be parallel

// Don't bypass the module
supabase.from("lending_pools").select("*")...
```

## Common Patterns

### List All Active Pools
```typescript
const { pools } = await fetchPools(supabase, {
  status: 'active',
  limit: 100
});
```

### Pagination
```typescript
const page1 = await fetchPools(supabase, { limit: 20, offset: 0 });
const page2 = await fetchPools(supabase, { limit: 20, offset: 20 });
```

### Sort by Liquidity
```typescript
const pools = await fetchPools(supabase, {
  orderBy: 'available_liquidity',
  orderDirection: 'desc'
});
```

### Auto-Matching
```typescript
const activePools = await fetchActivePoolsWithLiquidity(supabase, 0);
// Pre-sorted by available_liquidity DESC
```

## Performance Checklist

- [ ] Using `lib/db/pools.ts` functions?
- [ ] No `SELECT *` in queries?
- [ ] Parallel queries where applicable?
- [ ] Pagination applied for large lists?
- [ ] Explicit column selection?

## Debugging

### Check Query Count
```typescript
// Browser DevTools → Network tab
// Should see 1-2 requests for pool operations
// NOT multiple sequential requests
```

### Verify Query Performance
```typescript
const start = performance.now();
const result = await fetchPools(supabase);
console.log(`Query took ${performance.now() - start}ms`);
// Should be <100ms for typical queries
```

### Test Pagination
```typescript
const result = await fetchPools(supabase, { limit: 10, offset: 0 });
console.log(result.hasMore); // true if more results available
console.log(result.pools.length); // 10 (or less if last page)
```

## Type Reference

```typescript
interface Pool {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'closed';
  apr_bps: number;
  total_liquidity: number;
  available_liquidity: number;
  total_borrowed: number;
  created_at: string;
  updated_at: string;
}

interface PoolFetchOptions {
  status?: 'active' | 'paused' | 'closed';
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'available_liquidity';
  orderDirection?: 'asc' | 'desc';
}

interface PoolFetchResult {
  pools: Pool[];
  totalCount: number;
  estimatedTotalCount: number;
  hasMore: boolean;
}
```

## Need Help?

1. Check `lib/db/pools.ts` for detailed JSDoc comments
2. Read `POOL_OPTIMIZATION.md` for deep dive
3. Run tests: `npm test -- pools.test.ts`
4. Check browser DevTools network tab

## Examples

### React Component
```typescript
'use client';
import { useEffect, useState } from 'react';
import { getServiceRoleClient } from '@/lib/supabase/server';
import { fetchPools } from '@/lib/db/pools';

export function PoolList() {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const supabase = getServiceRoleClient();
        if (!supabase) return;
        
        const result = await fetchPools(supabase, {
          status: 'active',
          limit: 10
        });
        setPools(result.pools);
      } catch (err) {
        console.error('Failed to load pools:', err);
      } finally {
        setLoading(false);
      }
    };
    
    load();
  }, []);

  if (loading) return <div>Loading...</div>;
  return (
    <div>
      {pools.map(pool => (
        <div key={pool.id}>{pool.name}</div>
      ))}
    </div>
  );
}
```

### API Route
```typescript
import { fetchPools } from '@/lib/db/pools';
import { getServiceRoleClient } from '@/lib/supabase/server';

export async function GET(request) {
  const supabase = getServiceRoleClient();
  if (!supabase) {
    return Response.json({ error: 'Service unavailable' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const result = await fetchPools(supabase, {
    status: searchParams.get('status'),
    limit: parseInt(searchParams.get('limit') || '10'),
    offset: parseInt(searchParams.get('offset') || '0')
  });

  return Response.json(result);
}
```

### Server Action
```typescript
'use server';
import { fetchPoolById } from '@/lib/db/pools';
import { getServerSupabaseClient } from '@/lib/supabase/server';

export async function approvePoolFunding(poolId: string) {
  const supabase = await getServerSupabaseClient();
  if (!supabase) throw new Error('Service unavailable');

  const pool = await fetchPoolById(supabase, poolId);
  if (!pool) throw new Error('Pool not found');
  if (pool.available_liquidity <= 0) throw new Error('Insufficient liquidity');

  // Approve funding...
}
```

---

For questions, see `POOL_OPTIMIZATION.md` or run tests.
