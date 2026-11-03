// GET /api/grades — graded pre-game snapshots (the Accuracy tab's live record).
const { listGrades } = require('../lib/grading');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await listGrades()); } catch (err) { fail(res, err); }
};
