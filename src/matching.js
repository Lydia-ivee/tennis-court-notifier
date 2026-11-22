// Pure matching logic, kept free of I/O so it is easy to test.

export const slotId = (date, start) => `${date}T${start}`;

// Every open slot on a day and at a time the subscriber asked for.
export function findMatches(subscriber, horizon, slotsByDate) {
  const days = subscriber.days || [];
  const times = subscriber.times || [];
  const matches = [];
  for (const { date, weekday } of horizon) {
    if (!days.includes(weekday)) continue;
    for (const slot of slotsByDate[date] || []) {
      if (times.includes(slot.start)) matches.push({ date, weekday, ...slot });
    }
  }
  return matches;
}

// Drop slots this subscriber has already been emailed about.
export function unseen(matches, seenIds) {
  const seen = new Set(seenIds);
  return matches.filter((m) => !seen.has(slotId(m.date, m.start)));
}

// Merge newly emailed slots into the seen list, forgetting dates now in the past.
export function updateSeen(seenIds, sentMatches, today) {
  const kept = seenIds.filter((id) => id.slice(0, 10) >= today);
  const added = sentMatches.map((m) => slotId(m.date, m.start));
  return [...new Set([...kept, ...added])];
}
