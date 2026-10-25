export function createPlanHistory(targets, enabled = {}) {
  return { targets, enabled: Object.fromEntries(Object.keys(targets).map((id) => [id, enabled[id] ?? true])), past: [], future: [] };
}

function applyChanges(state, changes, direction) {
  const targets = { ...state.targets };
  const enabled = { ...state.enabled };
  for (const change of changes) {
    targets[change.id] = change[direction].action;
    enabled[change.id] = change[direction].enabled;
  }
  return { targets, enabled };
}

export function planHistory(state, event) {
  if (event.type === 'toggle-remove') event = { type: 'move', id: event.id, to: state.targets[event.id] === 'remove' ? 'keep' : 'remove', enabled: true };
  if (event.type === 'move' || event.type === 'batch') {
    const changes = (event.type === 'move' ? [{ id: event.id, to: event.to, enabled: event.enabled }] : event.changes).flatMap((entry) => {
      const from = { action: state.targets[entry.id], enabled: state.enabled[entry.id] };
      const to = { action: entry.to ?? from.action, enabled: entry.enabled ?? from.enabled };
      if (!from.action || !['add', 'remove', 'keep'].includes(to.action) || (from.action === to.action && from.enabled === to.enabled)) return [];
      return [{ id: entry.id, from, to }];
    });
    if (!changes.length) return state;
    return { ...applyChanges(state, changes, 'to'), past: [...state.past.slice(-99), changes], future: [] };
  }
  if (event.type === 'undo' && state.past.length) {
    const changes = state.past.at(-1);
    return { ...applyChanges(state, changes, 'from'), past: state.past.slice(0, -1), future: [...state.future, changes] };
  }
  if (event.type === 'redo' && state.future.length) {
    const changes = state.future.at(-1);
    return { ...applyChanges(state, changes, 'to'), past: [...state.past, changes], future: state.future.slice(0, -1) };
  }
  return state;
}
