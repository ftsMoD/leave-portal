// Email notifications over SMTP (Google Workspace, Resend, SendGrid, … all speak SMTP).
// If SMTP isn't configured, emails are skipped and the app keeps working.

const nodemailer = require('nodemailer');
const { formatRange } = require('./format');

let transport;
let testTransport;
let lastError = '';

const smtpConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const emailConfigured = () => Boolean(testTransport) || smtpConfigured();

// Links in emails always use the configured URL, never the request's Host header
// (prevents password-reset link poisoning).
function appUrl() {
  const url = process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return url.replace(/\/+$/, '');
}

function getTransport() {
  if (testTransport) return testTransport;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 8000,
    });
  }
  return transport;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(lines, link, linkLabel) {
  const text = [...lines, ...(link ? ['', `${linkLabel}: ${link}`] : [])].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;line-height:1.5">
${lines.map((l) => (l ? `<p style="margin:0 0 8px">${escapeHtml(l)}</p>` : '')).join('\n')}
${link ? `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(linkLabel)}</a></p>` : ''}
<p style="margin-top:24px;font-size:12px;color:#94a3b8">Leave Portal · automated message</p></div>`;
  return { text, html };
}

// Returns true (sent), false (failed) or null (email not configured). Never throws.
async function send({ to, subject, lines, link, linkLabel }) {
  if (!emailConfigured() || !to?.length) return null;
  try {
    await getTransport().sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      ...layout(lines, link, linkLabel),
    });
    lastError = '';
    return true;
  } catch (err) {
    lastError = String(err.message || err).slice(0, 300);
    console.error('Email send failed:', lastError);
    return false;
  }
}

function requestLines(r) {
  return [
    `Employee: ${r.employee_name}`,
    `Leave type: ${r.leave_type}${r.details ? ` — ${r.details}` : ''}`,
    `Dates: ${formatRange(r.start_date, r.end_date)} (${r.total_days} working day${r.total_days === 1 ? '' : 's'})`,
    ...(r.reason ? [`Reason: ${r.reason}`] : []),
  ];
}

function sendNewRequest(recipients, request) {
  const base = appUrl();
  return send({
    to: recipients.map((u) => u.email),
    subject: `Leave request to review: ${request.employee_name} — ${request.leave_type}`,
    lines: [
      `${request.employee_name} has requested leave and it is waiting for your approval.`,
      '',
      ...requestLines(request),
    ],
    link: base ? `${base}/?view=approvals&request=${request.id}` : '',
    linkLabel: 'Review request',
  });
}

function sendDecision(employee, request) {
  const base = appUrl();
  const verb = request.status === 'Approved' ? 'approved' : 'rejected';
  return send({
    to: [employee.email],
    subject: `Your leave request was ${verb}: ${request.leave_type}, ${formatRange(request.start_date, request.end_date)}`,
    lines: [
      `Hi ${employee.name}, your leave request has been ${verb} by ${request.decided_by_name}.`,
      '',
      ...requestLines(request),
      ...(request.decision_note ? [`Comment: ${request.decision_note}`] : []),
    ],
    link: base ? `${base}/?view=mine` : '',
    linkLabel: 'Open Leave Portal',
  });
}

function sendPasswordLink(user, token, kind) {
  const base = appUrl();
  const setup = kind === 'setup';
  return send({
    to: [user.email],
    subject: setup ? 'Set up your Leave Portal password' : 'Reset your Leave Portal password',
    lines: setup
      ? [`Hi ${user.name}, an account has been created for you on the Leave Portal.`, 'Use the button below to choose your password. The link expires in 72 hours.']
      : [`Hi ${user.name}, we received a request to reset your Leave Portal password.`, 'Use the button below within 1 hour. If you did not ask for this, ignore this email.'],
    link: `${base}/?reset=${encodeURIComponent(token)}`,
    linkLabel: setup ? 'Set my password' : 'Reset my password',
  });
}

const setTestTransport = (t) => { testTransport = t; };
const lastEmailError = () => lastError;

module.exports = { emailConfigured, appUrl, sendNewRequest, sendDecision, sendPasswordLink, setTestTransport, lastEmailError };
