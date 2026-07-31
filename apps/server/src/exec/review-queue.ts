import type { Db } from '../db/client.js'
import { drainReviews } from '../db/interaction-repo.js'
import type { ReviewQueue } from './interaction.js'

/**
 * DB üzərində rəy növbəsi (Faza 5B).
 *
 * Boşaltma DƏRHAL `applied_at` yazır (bax `drainReviews`): əks halda review
 * route rəyi hələ də "tətbiq olunmayıb" sayıb PARALEL ikinci icra başladardı.
 */
export class DbReviewQueue implements ReviewQueue {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  drain(taskId: string): string[] {
    return drainReviews(this.db, taskId).map((r) => r.text)
  }
}
