// GET /api/status — what history the model is running on, and whether snapshots are saved.
const { dataStatus, snapshotStatus } = require('../lib/store');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, { history: await dataStatus(), snapshots: await snapshotStatus() }); } catch (err) { fail(res, err); }
};
