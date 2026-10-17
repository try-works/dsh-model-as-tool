import assert from 'node:assert/strict'
import test from 'node:test'

import { mayRepairTitle, recordRepairLineage, SECTION_TITLE_LIMITS } from '../src/title-proposal.ts'

test('CODE-11: the repair lineage records which repair, budget before/after, and the outcome', () => {
  const lineage = []
  // Attempt 1: a rejection consumes one repair.
  const first = mayRepairTitle(SECTION_TITLE_LIMITS, 0, { kind: 'rejected', reason: 'no content overlap' })
  recordRepairLineage(lineage, first, 'rejected', 1)
  // Attempt 2: the budget is exhausted.
  const second = mayRepairTitle(SECTION_TITLE_LIMITS, 1, { kind: 'rejected', reason: 'still no overlap' })
  recordRepairLineage(lineage, second, 'rejected', 1)
  assert.deepEqual(lineage, [
    // The budget AFTER the decision is the remaining budget: a repair that ran
    // lowers it by one (CODE-11's "one lower when a repair ran"), so a 1-budget
    // shows 0 after the first repair and stays 1 when nothing was consumed.
    { repairIndex: 1, budgetBefore: 1, budgetAfter: 0, previousKind: 'rejected', outcome: 'repaired' },
    { repairIndex: 2, budgetBefore: 1, budgetAfter: 1, previousKind: 'rejected', outcome: 'exhausted' },
  ])
  // A proposed outcome never consumes budget and is recorded as not-needed.
  const third = mayRepairTitle(SECTION_TITLE_LIMITS, 1, { kind: 'proposed', title: 't', description: 'd', repairs: 0 })
  recordRepairLineage(lineage, third, 'proposed', 1)
  assert.equal(lineage[2]!.outcome, 'not-needed')
})
