/** The order the conversation reads in, which is not always the order it
 *  happened in.
 *
 *  The log is append-only and stamped in real time, and that is right: it is the
 *  record of the review. But a batch sent while the agent is still on an earlier
 *  one lands *between* that question and its answer, so a log rendered verbatim
 *  puts the agent's reply under a question it is not answering - and puts the new
 *  question above output that started before it was even typed. Neither reading
 *  of "chronological" survives that.
 *
 *  So an answer is drawn under the question it answers, and a question sent
 *  mid-turn sits below, where the user can be told it is waiting. Entries that
 *  answer nothing - the session notices - stay exactly where the log put them,
 *  because for those the timeline *is* the meaning. */

/** Only what the ordering depends on, so the shell's own wire type satisfies it
 *  without this module having to know the rest of it. */
export interface ThreadEntry {
  role: 'user' | 'agent' | 'system'
  /** For a user entry, the batch it sent. For an agent or turn-end system entry,
   *  the batch it answers. Absent on anything that belongs to no batch. */
  batchId?: string
}

export function threadOrder<T extends ThreadEntry>(entries: T[]): T[] {
  // Everything that answers a batch, grouped, keeping log order within a batch -
  // a turn can leave a reply and a note about how it stopped, and those two have
  // to stay together and in that order.
  const answers = new Map<string, T[]>()
  for (const entry of entries) {
    if (entry.role === 'user' || !entry.batchId) continue
    const group = answers.get(entry.batchId)
    if (group) group.push(entry)
    else answers.set(entry.batchId, [entry])
  }

  const out: T[] = []
  const placed = new Set<T>()
  for (const entry of entries) {
    if (placed.has(entry)) continue
    // Held back for its question to emit, below.
    if (entry.role !== 'user' && entry.batchId && answers.has(entry.batchId)) continue
    out.push(entry)
    placed.add(entry)
    if (entry.role !== 'user' || !entry.batchId) continue
    for (const answer of answers.get(entry.batchId) ?? []) {
      out.push(answer)
      placed.add(answer)
    }
    answers.delete(entry.batchId)
  }

  // An answer whose question is not here at all - `/new` windowed it away, or the
  // log has been trimmed. Nothing claimed it, and dropping it would lose the
  // agent's words, so it goes last, in log order.
  for (const group of answers.values()) out.push(...group)
  return out
}
