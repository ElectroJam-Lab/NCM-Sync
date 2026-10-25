const { parseJson } = require('./utils.cjs');

function buildSyncPlan(row, localTracks, choices, deleteRemoved) {
  const candidates = new Map([...parseJson(row.online_tracks_json, []), ...parseJson(row.added_json, [])]
    .map((track) => [String(track.id), { ...track, local: false }]));
  const remoteRemoved = new Set(parseJson(row.removed_json, []).map((track) => String(track.id)));
  for (const track of localTracks) candidates.set(String(track.id), { ...track, local: true });
  const decisions = new Map(choices.map((choice) => [String(choice.track_id), choice]));
  const plan = { added: [], removed: [], existing: [] };
  for (const [id, track] of candidates) {
    const fallback = track.local ? (remoteRemoved.has(id) && deleteRemoved ? 'remove' : 'keep') : 'add';
    const choice = decisions.get(id);
    const action = choice?.action || fallback;
    const syncSelected = choice?.enabled !== undefined ? Boolean(choice.enabled) : track.local || action === 'add';
    plan[{ add: 'added', remove: 'removed', keep: 'existing' }[action]].push({ ...track, id, action, syncSelected, remoteRemoved: remoteRemoved.has(id) });
  }
  plan.needsSync = plan.added.some((track) => track.syncSelected && !track.local) || plan.removed.some((track) => track.syncSelected && track.local);
  return plan;
}

module.exports = { buildSyncPlan };
