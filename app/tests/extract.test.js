// Run: node app/tests/extract.test.js  — checks the on-device extraction against sample notes.
const assert = require('assert');
const X = require('../src/extract.js');
const base = new Date('2026-11-12T10:00:00').getTime();
const mk = (arr) => arr.map((text, i) => ({ id: 'n' + i, t: base + i * 120000, text }));

const r = X.extract(mk([
  'הוזעקנו בשל כאבים בחזה. גבר כבן 60 יושב על כיסא במטבח, חיוור ומזיע.',
  'מתלונן על כאב לוחץ במרכז החזה עם הקרנה ליד שמאל מלפני כחצי שעה',
  'דופק 112 לא סדיר, ל"ד 150/95, סט׳ 91 באוויר, נשימות 24 מאומצות',
  'לדברי אשתו ידוע כסוכרתי ויל"ד, נוטל אספירין 100 מ"ג קבוע. עבר צנתור לפני 3 שנים',
  'שמו יוסי לוי, בן 62, ת.ז. 123456782 מבוטח בכללית',
  'ניתן חמצן 4 ליטר במשקפיים. ניתן אספירין 300 מ"ג בלעיסה. סוכר 145',
  'סטורציה 96 עם חמצן, דופק 98 סדיר',
  'פונה לשערי צדק בליווי נט"ן במצב יציב',
]));
assert.deepStrictEqual(r.demo, { first: 'יוסי', last: 'לוי', age: '62', sex: 'זכר', idnum: '123456782', hmo: 'כללית' });
assert.ok(r.warnings.some((w) => w.field === 'demo.age'), 'conflicting ages are flagged');
assert.strictEqual(r.complaint, 'כאבים בחזה', 'chief complaint = reason for the call');
assert.ok(r.history.anamnesis.includes('מתלונן על כאב לוחץ'), "the patient's own words stay in the anamnesis");
const narrative = Object.values(r.history).join(' ');
assert.ok(!/דופק \d|ל"ד \d|סט׳ \d|סוכר \d/.test(narrative), 'no measurements in the anamnesis: ' + narrative);
assert.deepStrictEqual(r.vitals[0].values, { pulse: '112', pulseRhythm: 'לא סדיר', bp: '150/95', spo2Air: '91', rr: '24', rrQuality: 'מאומצות' });
assert.ok(r.vitals.some((v) => v.values.spo2O2 === '96' && v.values.pulse === '98'));
assert.ok(r.vitals.some((v) => v.values.glucose === '145'));
assert.ok(r.treatments.meds.includes('אספירין 300'));
assert.ok(!r.treatments.meds.includes('100 מ"ג קבוע'), 'home medication is history, not treatment');
assert.ok(r.treatments.oxygen.includes('4 ליטר'));
assert.ok(r.history.anamnesis.includes('לדברי אשתו') && r.history.anamnesis.includes('עבר צנתור'), 'medical history is part of the anamnesis');
assert.ok(r.history.anamnesis.includes('פונה'));
assert.deepStrictEqual(Object.keys(r.history), ['anamnesis'], 'one anamnesis field');
assert.ok(!('dressings' in r.treatments), 'nothing invented');

const r2 = X.extract(mk([
  'ללא דופק וללא נשימה, התחלנו החייאה ב-10:01',
  'חובר AED, ניתן שוק אחד',
  'חזר דופק 10:12. דופק 60 סדיר',
  'סוכר 45, ניתן ג\'ל סוכר 15 גרם. ת"ז 012345678',
  'לא ניתן אספירין בשל אלרגיה',
]));
assert.strictEqual(r2.vitals[0].values.pulse, 'ללא דופק');
assert.ok(r2.vitals.some((v) => v.values.pulse === '60' && new Date(v.t).getMinutes() === 12), 'explicit time carries over');
assert.ok(r2.vitals.some((v) => v.values.glucose === '45') && !r2.vitals.some((v) => v.values.glucose === '15'));
assert.ok(r2.warnings.some((w) => w.field === 'demo.idnum'), 'bad ID check digit is flagged');
assert.ok(!r2.treatments.meds || !r2.treatments.meds.includes('אספירין'), 'negated drug is not listed as given');
assert.ok(r2.history.anamnesis.includes('לא ניתן אספירין'));
console.log('extract tests passed');

// case suggestions from the organisation's list
const cases = require('../../cases/cases.he-IL.json').cases;
const top = (notes) => X.extract(mk(notes), { cases }).caseSuggestions.map((s) => s.id);
assert.strictEqual(top(['מתלונן על כאב לוחץ בחזה עם הקרנה ליד שמאל'])[0], '16');
assert.strictEqual(top(['ללא דופק וללא נשימה, התחלנו החייאה, חובר AED'])[0], '10');
assert.ok(top(['דופק 80 סדיר, ירידת מים לפני שעה, צירים כל 3 דקות']).includes('52'));
assert.ok(!top(['דופק 80 סדיר']).includes('210'), '"סדיר" must not suggest limb injury');
const one = X.extract(mk(['הוזעקנו בשל כאבים בחזה', 'מתלונן על כאב לוחץ עם הקרנה ליד שמאל']), { cases });
assert.strictEqual(one.caseId, '16'); assert.strictEqual(one.caseAuto, true);
const many = X.extract(mk(['נפל מסולם, חבלת ראש, שבר פתוח ביד']), { cases });
assert.strictEqual(many.caseId, '', 'no single clear case → nothing chosen');
assert.ok(many.caseSuggestions.length >= 2, 'several candidates offered');
const t2 = X.extract(mk(['חום גוף 39.5, סוכר 145 מ"ג/ד"ל בבדיקה']), { cases });
assert.ok(t2.vitals.some((v) => v.values.temp === '39.5' && v.values.glucose === '145'));
assert.ok(!t2.history.anamnesis, 'measurement-only note adds nothing to the anamnesis');
// dictated note: one run, no punctuation
const d = X.extract(mk(['\u200fמתלוננת על כאבים חזקים בבטן אין שלשולים אין הקאות אכלה פעם אחרונה לפני כמה שעות לקחה אקמול לפני שעה לחץ דם 150 על 100 סטורציה 98 אין היסטוריה רפואית דומה', 'סוכר 110, דופק מהיר וסדיר']), { cases });
assert.strictEqual(d.complaint, 'כאבים חזקים בבטן');
const dn = Object.values(d.history).join(' ');
assert.ok(dn.includes('אין שלשולים') && dn.includes('לקחה אקמול') && dn.includes('אין היסטוריה רפואית דומה'), dn);
assert.ok(!/150|98|110|דופק|סטורציה|לחץ דם/.test(dn), 'measurements stay out of the anamnesis: ' + dn);
assert.ok(d.vitals.some((v) => v.values.bp === '150/100' && v.values.pulse === 'מהיר'));
assert.strictEqual(d.caseId, '70');
console.log('case suggestion tests passed');
