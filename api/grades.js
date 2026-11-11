// GET /api/grades?page=0 — graded pre-game snapshots (the Accuracy tab's live record): totals over
// every graded game, the games themselves 60 to a page, newest first.
const { listGrades } = require('../lib/grading');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await listGrades({ page: numParam(req, 'page', 0, { min: 0, max: 1000 }) })); } catch (err) { fail(res, err); }
};
