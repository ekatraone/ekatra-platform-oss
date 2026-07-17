/**
 * SM-2 Spaced Repetition Algorithm
 *
 * A faithful implementation of the SM-2 algorithm (Supermemo 2).
 * Quality grades:
 *   0 — complete blackout (reset)
 *   1 — wrong, but remembered once shown
 *   2 — wrong, but easy to recall
 *   3 — correct with serious difficulty
 *   4 — correct with some hesitation
 *   5 — perfect recall
 *
 * Any grade < 3 is treated as a "lapse" — the card is reset.
 */

export interface SM2Input {
  quality: number;         // 0-5 rating from the learner
  interval: number;        // current interval in days (0 for new cards)
  easeFactor: number;      // current ease factor (default 2.5)
  reps: number;            // number of consecutive successful reviews
  lapses: number;          // total times the card was forgotten
}

export interface SM2Result {
  interval: number;        // new interval in days
  easeFactor: number;      // new ease factor
  reps: number;            // new rep count
  lapses: number;          // new lapse count
  dueDate: Date;           // absolute date for next review
}

/**
 * Run one SM-2 review cycle and return the updated card state.
 */
export function sm2Review(input: SM2Input): SM2Result {
  const q = Math.max(0, Math.min(5, Math.round(input.quality)));
  let { interval, easeFactor, reps, lapses } = input;

  if (q < 3) {
    // Lapse — reset rep streak
    reps = 0;
    lapses = lapses + 1;
    interval = 1;
    easeFactor = Math.max(1.3, easeFactor - 0.2);
  } else {
    // Correct review
    reps = reps + 1;

    if (reps === 1) {
      interval = 1;
    } else if (reps === 2) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }

    // SM-2 ease factor update formula
    easeFactor = easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
    easeFactor = Math.max(1.3, easeFactor);
  }

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + interval);

  return { interval, easeFactor: parseFloat(easeFactor.toFixed(2)), reps, lapses, dueDate };
}

/**
 * Map a WhatsApp button label to an SM-2 quality grade.
 * We expose three buttons to keep the UX simple:
 *   "😊 Easy"  → quality 5
 *   "😐 Hard"  → quality 3
 *   "😓 Forgot" → quality 1
 */
export function labelToQuality(label: string): number {
  const l = label.toLowerCase();
  if (l.includes('easy') || l === 'rating_5' || l === 'rating_4') return 5;
  if (l.includes('hard') || l === 'rating_3') return 3;
  return 1; // forgot / anything else
}
