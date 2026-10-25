const STATUS_ORDER = { synced: 0, pending: 1, paused: 2, offline: 3 };

export function sortRows(rows, sort) {
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    const comparison = typeof av === 'string' ? av.localeCompare(bv, 'zh-CN') : av - bv;
    return comparison * sort.direction;
  });
}

export function sortValue(row, key) {
  if (key === 'status') return STATUS_ORDER[row.status] ?? 4;
  if (key === 'updateCount') return (row.addedCount ?? row.added?.length ?? 0) + (row.removedCount ?? row.removed?.length ?? 0);
  return row[key] ?? '';
}
