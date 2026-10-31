// Resolve optional spreadsheet fields at delivery time, without guessing facts
// about the recipient or requiring an AI provider to send a saved template.
const placeholders = /{{\s*([^{}]+?)\s*}}/g;
const keyOf = key => key.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
const groups = [
  ['firstname', 'givenname', 'forename'], ['lastname', 'surname', 'familyname'],
  ['name', 'fullname', 'contactname'], ['company', 'companyname', 'organization', 'organisation', 'employer'],
  ['jobtitle', 'designation', 'position', 'role', 'title'], ['email', 'emailaddress'],
];
const absent = value => value == null || !String(value).trim() || /^(?:n\s*\/?\s*a|not\s+(?:available|provided|applicable|known)|unknown|null|undefined|none|[-–—])$/i.test(String(value).trim());
const signoff = /^(?:best regards|kind regards|warm regards|regards|sincerely|yours sincerely|best wishes|thank you|thanks|respectfully)[,!.'\s]*$/i;
const greeting = /^(?:dear|hello|hi|greetings|good morning|good afternoon|good evening)\b[^.!?\n]*[,!:]?\s*$/i;
const identityKeys = new Set(groups.flat());
const tidy = value => value.replace(/[ \t]+/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1').trim();

function createPersonalizer(recipient, sender = {}) {
  const values = new Map();
  for (const [key, value] of Object.entries(recipient.data || {})) {
    if (!absent(value)) values.set(keyOf(key), String(value).trim());
  }
  if (!absent(recipient.email)) values.set('email', recipient.email.trim());
  for (const aliases of groups) {
    const value = aliases.map(key => values.get(key)).find(Boolean);
    if (value) for (const key of aliases) if (!values.has(key)) values.set(key, value);
  }
  if (!values.has('name')) {
    const name = [values.get('firstname'), values.get('lastname')].filter(Boolean).join(' ');
    if (name) for (const key of ['name', 'fullname', 'contactname']) values.set(key, name);
  }
  // Sender identity comes from configuration, never from a recipient's name.
  for (const [key, value] of [['sendername', sender.name], ['senderemail', sender.email]]) {
    values.delete(key);
    if (!absent(value)) values.set(key, String(value).trim());
  }
  function resolve(expression) {
    const [key, ...fallback] = expression.split('|');
    return values.get(keyOf(key.trim())) || fallback.join('|').trim() || '';
  }
  const missingFields = new Set();
  return {
    missingFields,
    inspect(text) {
      for (const [, expression] of text.matchAll(placeholders)) if (!resolve(expression)) missingFields.add(expression.split('|')[0].trim());
    },
    missing: text => [...text.matchAll(placeholders)].some(([, expression]) => !resolve(expression)),
    render: text => text.replace(placeholders, (_match, expression) => resolve(expression)),
    name: values.get('firstname') || values.get('name'),
  };
}

function sentences(line) {
  const result = [];
  let start = 0;
  for (const match of line.matchAll(/[.!?]+(?=\s|$)/g)) {
    const end = match.index + match[0].length;
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|e\.g|i\.e)\.$/i.test(line.slice(start, end))) continue;
    result.push(line.slice(start, end)); start = end;
  }
  if (line.slice(start).trim()) result.push(line.slice(start));
  return result;
}

function cleanBody(template, p) {
  const lines = template.replace(/\r\n?/g, '\n').split('\n').map(line => {
    if (greeting.test(line.trim())) {
      if (p.missing(line) || /^(?:dear|hello|hi|greetings)[\s,!:.]*$/i.test(p.render(line))) return p.name ? `Hello ${p.name},` : 'Hello,';
      return tidy(p.render(line));
    }
    return sentences(line).filter(sentence => !p.missing(sentence)).map(sentence => tidy(p.render(sentence))).join(' ');
  });
  let body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Email/Email aliases often appear twice in old generated templates.
  body = body.replace(/([^\s<>()[\],;]+@[^\s<>()[\],;]+\.[a-z]{2,})\s+(?:or|and)\s+\1\b/gi, '$1');
  if (!body.split('\n').some(line => line.trim() && !greeting.test(line))) {
    body = `${body || (p.name ? `Hello ${p.name},` : 'Hello,')}\n\nI'm reaching out to connect. Please let me know if you'd like to discuss this further.`;
  }
  return body;
}

function cleanSubject(template, p) {
  template = template.replace(/[\r\n]/g, ' ');
  if (!p.missing(template)) return tidy(p.render(template).replace(/[\r\n]/g, ' '));
  // Keep a complete subject prefix; never leave "for  at" or raw tokens.
  const missing = [...template.matchAll(placeholders)].find(([, expression]) => p.missing(`{{${expression}}}`));
  let prefix = tidy(p.render(template.slice(0, missing.index)).replace(/[\r\n]/g, ' '));
  let previous;
  do {
    previous = prefix;
    prefix = prefix.replace(/[\s,;:|–—-]+$/, '').replace(/\b(?:for|at|to|from|with|regarding|about|the|dear|hello|hi|and|or)$/i, '').trim();
  } while (previous !== prefix);
  return prefix || 'A quick introduction';
}

function cleanClosing(template, p, sender) {
  const lines = template.replace(/\r\n?/g, '\n').split('\n');
  const hasSignoff = signoff.test(lines[0].trim());
  const closing = lines.filter((line, index) => {
    if (!hasSignoff || index === 0) return true;
    const tokens = [...line.matchAll(placeholders)];
    // Old AI templates incorrectly signed off with recipient identity fields.
    return !(tokens.length && !line.replace(placeholders, '').replace(/[\s,|–—-]/g, '') && tokens.every(([, expression]) => identityKeys.has(keyOf(expression.split('|')[0].trim()))));
  }).filter(line => !p.missing(line)).map(line => tidy(p.render(line))).filter(Boolean);
  if (!closing.length) closing.push('Best regards,');
  if (closing.length === 1 && signoff.test(closing[0])) closing.push(...[sender.name, sender.email].filter(value => !absent(value)));
  return closing.join('\n');
}

function renderEmail(template, recipient, sender = {}) {
  const p = createPersonalizer(recipient, sender);
  for (const value of [template.emailTemplateSubject, template.emailTemplateBody, template.emailTemplateClosing]) p.inspect(value);
  return {
    subject: cleanSubject(template.emailTemplateSubject, p),
    body: cleanBody(template.emailTemplateBody, p),
    closing: cleanClosing(template.emailTemplateClosing, p, sender),
    missingFields: [...p.missingFields],
  };
}

const personalize = (template, recipient) => createPersonalizer(recipient).render(template);
module.exports = { renderEmail, personalize };
