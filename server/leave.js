// Leave workflow rules. Storage-agnostic: runs against memory or Postgres.

const { parseISODate, countBusinessDays, rangeLengthDays, MAX_RANGE_DAYS } = require('./dates');
const { httpError } = require('./errors');

const MAX_REASON_LENGTH = 500;
const DECISIONS = ['Approved', 'Rejected'];

async function applyForLeave(store, user, body = {}) {
  const leaveType = typeof body.leave_type === 'string' ? body.leave_type.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const start = parseISODate(body.start_date);
  const end = parseISODate(body.end_date);

  if (!leaveType) throw httpError(400, 'Leave type is required.');
  if (!start || !end) throw httpError(400, 'Start and end dates must be valid dates (YYYY-MM-DD).');
  if (end < start) throw httpError(400, 'End date cannot be before start date.');
  if (rangeLengthDays(start, end) > MAX_RANGE_DAYS) throw httpError(400, 'A single request cannot span more than a year.');
  if (reason.length > MAX_REASON_LENGTH) throw httpError(400, `Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);

  // Server is the source of truth for day counts (the original blueprint trusted the client).
  const totalDays = countBusinessDays(start, end);
  if (totalDays === 0) throw httpError(400, 'The selected dates fall entirely on a weekend.');

  return store.transaction(async (tx) => {
    const balance = await tx.getBalanceForUpdate(user.id, leaveType);
    if (!balance) throw httpError(400, `You have no "${leaveType}" leave entitlement.`);

    if (await tx.hasOverlap(user.id, body.start_date, body.end_date)) {
      throw httpError(409, 'These dates overlap with another pending or approved request.');
    }

    // Pending requests count against the balance so employees can't stack requests beyond it.
    const pending = await tx.pendingDays(user.id, leaveType);
    const available = balance.total_days - balance.used_days - pending;
    if (totalDays > available) {
      throw httpError(400, `Insufficient ${leaveType} balance: requesting ${totalDays} day(s), ${Math.max(available, 0)} available after pending requests.`);
    }

    return tx.insertRequest({
      user_id: user.id,
      leave_type: leaveType,
      start_date: body.start_date,
      end_date: body.end_date,
      total_days: totalDays,
      reason,
    });
  });
}

async function decideRequest(store, actor, requestId, status) {
  if (actor.role !== 'manager') throw httpError(403, 'Only managers can approve or reject requests.');
  if (!DECISIONS.includes(status)) throw httpError(400, 'Status must be "Approved" or "Rejected".');

  return store.transaction(async (tx) => {
    const request = await tx.getRequestForUpdate(requestId);
    if (!request) throw httpError(404, 'Request not found.');
    if (request.user_id === actor.id) throw httpError(403, 'You cannot approve or reject your own request.');
    if (request.status !== 'Pending') throw httpError(409, `This request is already ${request.status.toLowerCase()}.`);

    if (status === 'Approved') {
      const balance = await tx.getBalanceForUpdate(request.user_id, request.leave_type);
      if (!balance) throw httpError(409, 'Employee no longer has this leave entitlement.');
      if (balance.total_days - balance.used_days < request.total_days) {
        throw httpError(409, 'Approving would exceed the employee\'s remaining balance.');
      }
      await tx.addUsedDays(balance.id, request.total_days);
    }
    return tx.setRequestStatus(requestId, status, actor.id);
  });
}

async function cancelRequest(store, actor, requestId) {
  return store.transaction(async (tx) => {
    const request = await tx.getRequestForUpdate(requestId);
    if (!request) throw httpError(404, 'Request not found.');
    if (request.user_id !== actor.id) throw httpError(403, 'You can only cancel your own requests.');
    if (request.status !== 'Pending') throw httpError(409, 'Only pending requests can be cancelled.');
    return tx.setRequestStatus(requestId, 'Cancelled', actor.id);
  });
}

module.exports = { applyForLeave, decideRequest, cancelRequest, MAX_REASON_LENGTH };
