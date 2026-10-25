function sameValue(left, right) {
  if (left === right) return true;
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecord(left, right) {
  if (!left || !right) return false;
  const keys = Object.keys(right);
  return Object.keys(left).length === keys.length && keys.every((key) => sameValue(left[key], right[key]));
}

function reuseRows(previous = [], next = []) {
  const byId = new Map(previous.map((row) => [row.id, row]));
  const rows = next.map((row) => sameRecord(byId.get(row.id), row) ? byId.get(row.id) : row);
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}

export function reconcileSnapshot(previous, next) {
  if (!previous || previous === next) return next;
  const result = { ...next, online: reuseRows(previous.online, next.online), local: reuseRows(previous.local, next.local),
    settings: sameRecord(previous.settings, next.settings) ? previous.settings : next.settings,
    task: sameRecord(previous.task, next.task) ? previous.task : next.task };
  return sameRecord(previous, result) ? previous : result;
}
