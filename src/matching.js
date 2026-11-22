// Pure matching logic, kept free of I/O so it is easy to test.

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
