import type { RemotePullRequest } from './types';

function revisionTime(record: RemotePullRequest): number {
  const updated = Date.parse(record.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) ? created : -Infinity;
}

/** One current snapshot per PR; removed files from older snapshots are not evidence. */
export function latestPullRequests(records: readonly RemotePullRequest[]): RemotePullRequest[] {
  const latest = new Map<string, RemotePullRequest>();
  for (const record of records) {
    const previous = latest.get(record.id);
    if (!previous) { latest.set(record.id, record); continue; }
    const currentTime = revisionTime(record), previousTime = revisionTime(previous);
    if (currentTime > previousTime || (currentTime === previousTime
      && (!record.filesTruncated || previous.filesTruncated))) {
      latest.set(record.id, record);
    }
  }
  return [...latest.values()];
}
