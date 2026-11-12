/* BLS event notes → report draft. Runs entirely on the device.
 *
 * Principles
 * - Only what the medic wrote: values and text are copied from the notes, never inferred
 *   from general knowledge. Narrative fields are the medic's own sentences, verbatim.
 * - Every extracted value keeps the IDs of the notes it came from, so it can be checked.
 * - A field with nothing in the notes is left out of the draft.
 * - When the notes give different values for the same detail, the latest is used and a
 *   warning is raised so the medic confirms it.
 */
(function (root) {
  'use strict';

  var HB = '\\u05D0-\\u05EA';
  var NOT_BEFORE = '(?<![' + HB + 'A-Za-z0-9])';      // start of a word
  var NOT_AFTER = '(?![' + HB + 'A-Za-z])';           // end of a word
  var Q = '["\\u05F4\\u05F3\\u201C\\u201D\'\\u2019]?'; // optional geresh / gershayim
  var PFX = '(?:[\\u05D5\\u05D4\\u05D1\\u05DC\\u05E9\\u05DE\\u05DB]{0,2})'; // ו ה ב ל ש מ כ

  function words(list, opts) {
    opts = opts || {};
    return new RegExp(NOT_BEFORE + (opts.prefix === false ? '' : PFX) + '(?:' + list.join('|') + ')' + (opts.open ? '' : NOT_AFTER), opts.flags || 'i');
  }
  var q = function (s) { return s.replace(/"/g, Q); }; // allow ל"ד, ל״ד, לד

  /* ---------- sentence splitting ---------- */
  function splitSentences(text) {
    var out = [], cur = '', s = String(text || '');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '\n' || c === '\r') { push(); continue; }
      cur += c;
      if ('.!?;'.indexOf(c) !== -1 && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
        if (c === '.') {
          var m = cur.slice(0, -1).match(/([^\s.]*)$/);
          if (m && m[1].length === 1 && /[^\d]/.test(m[1]) && cur.trim().length > 1) continue; // ת.ז. / מ.ז.
        }
        push();
      }
    }
    push();
    return out;
    function push() { var t = cur.trim(); if (t) out.push(t); cur = ''; }
  }

  /* ---------- time ---------- */
  var RE_TIME = /(?:^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/;
  function timeIn(sentence, noteTime) {
    var m = sentence.match(RE_TIME);
    if (!m) return { t: noteTime, explicit: false };
    var d = new Date(noteTime);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return { t: d.getTime(), explicit: true };
  }

  /* ---------- Israeli ID check digit ---------- */
  function validIsraeliId(id) {
    if (!/^\d{5,9}$/.test(id)) return false;
    id = ('000000000' + id).slice(-9);
    var sum = 0;
    for (var i = 0; i < 9; i++) { var n = +id[i] * ((i % 2) + 1); sum += n > 9 ? n - 9 : n; }
    return sum % 10 === 0;
  }

  /* ---------- patterns ---------- */
  var FAMILY_BEFORE = /(בנו|בתו|בנה|בתה|אשתו|בעלה|אחיו|אחותו|אחיה|אחותה|אביו|אמו|אביה|אמה|נכדו|נכדתו|נכדה|נכדתה|הבן|הבת|הורים|אח|אחות)\s*$/;
  var RE_AGE = new RegExp(NOT_BEFORE + '[הו]?(כבן|כבת|בן|בת|בגיל|גיל)\\s*:?\\s*[~-]?\\s*(\\d{1,3})(?!\\d)(?:\\s*(שנים|שנה|חודשים|חודש|שבועות|שבוע|ימים|יום)' + NOT_AFTER + ')?', 'g');
  var SEX_M = ['גבר', 'זכר', 'נער', 'קשיש'];
  var SEX_F = ['אישה', 'אשה', 'נקבה', 'ילדה', 'נערה', 'תינוקת', 'פעוטה', 'יולדת', 'מטופלת', 'קשישה', 'בהריון', 'הרה'];
  var RE_SEX_M = new RegExp(NOT_BEFORE + '[הו]?(' + SEX_M.join('|') + ')' + NOT_AFTER, 'g');
  var RE_SEX_F = new RegExp(NOT_BEFORE + '[הו]?(' + SEX_F.join('|') + ')' + NOT_AFTER, 'g');
  var RE_ID = new RegExp(NOT_BEFORE + '(?:ת\\.?\\s?ז\\.?|ת' + Q + 'ז|תעודת זהות|מספר זהות|מס' + Q + ' זהות|מ\\.?ז\\.?)\\s*[:\\-]?\\s*(\\d[\\d\\- ]{3,12}\\d)', 'g');
  var HMOS = { 'כללית': 'כללית', 'מכבי': 'מכבי', 'מאוחדת': 'מאוחדת', 'לאומית': 'לאומית' };
  var RE_HMO_CTX = new RegExp('(?:קופ[הת](?:\\s*ה?חולים)?|קופ' + Q + 'ח|מבוטח(?:ת)?)\\s*:?\\s*[בו]?(כללית|מכבי|מאוחדת|לאומית)' + NOT_AFTER, 'g');
  var RE_HMO_BARE = new RegExp(NOT_BEFORE + '[בו]?(מכבי|מאוחדת|לאומית)' + NOT_AFTER, 'g');
  var NAME_TOKEN = '([' + HB + '][' + HB + '\'"\\u05F3\\u05F4\\-]*)';
  var RE_FIRST = new RegExp('שם\\s*פרטי\\s*:?\\s*' + NAME_TOKEN, 'g');
  var RE_LAST = new RegExp('שם\\s*(?:ה)?משפחה\\s*:?\\s*' + NAME_TOKEN, 'g');
  var RE_NAME = new RegExp(NOT_BEFORE + '(?:שמו|שמה|שם המטופל(?:ת)?|שם מלא\\s*:?|קוראים לו|קוראים לה|שם\\s*:)\\s*' + NAME_TOKEN + '(?:\\s+' + NAME_TOKEN + ')?', 'g');
  var NAME_STOP = /^(בן|בת|כבן|כבת|גיל|בגיל|ת"?ז|תז|מטופל|מטופלת|נמצא|נמצאה|ידוע|ידועה|הוא|היא|של|עם|ללא|פרטי|משפחה|המשפחה|מלא)$/;

  var RE_PULSE = new RegExp(NOT_BEFORE + PFX + '(?:דופק|HR)\\s*:?\\s*(\\d{2,3})(?!\\d|:\\d)', 'gi');
  var RE_NO_PULSE = /(?:ללא|אין|בלי)\s+דופק|דופק\s+(?:לא\s+)?(?:נמוש|נמושש|לא נמצא|לא נמוש|לא נמושש)/g;
  var RE_RHYTHM = /(לא\s*סדיר|לא-סדיר|אי[\s-]?סדיר|סדיר)/;
  var RE_RR = new RegExp(NOT_BEFORE + PFX + '(?:נשימות|נשימה|קצב\\s+נשימ(?:ה|ות)|RR)\\s*:?\\s*(\\d{1,2})(?!\\d|:\\d)', 'gi');
  var RE_RR_QUALITY = /(מאומצ(?:ת|ות|ים)?|תקינ(?:ה|ות|ים)?|תקין|שטחי(?:ת|ות)?|רדוד(?:ה|ות)?|רועש(?:ת|ות)?)/;
  var RE_RR_WORD = /(?:^|[^א-ת])(?:[וה]?(?:נשימה|נשימות|נושם|נושמת))\s+(מאומצ(?:ת|ות)?|תקינ(?:ה|ות)?|תקין|שטחי(?:ת|ות)?|רדוד(?:ה|ות)?|רועש(?:ת|ות)?)/g;
  var RE_NO_BREATH = /(?:ללא|אין)\s+נשימה|לא\s+נושמ(?:ת)?|(?:^|[^א-ת])דום\s+נשימה/g;
  var RE_BP = new RegExp(NOT_BEFORE + PFX + '(?:' + q('ל"ד') + '|לחץ\\s*דם|BP)\\s*:?\\s*(\\d{2,3})\\s*(?:/|\\\\|על)\\s*(\\d{2,3})(?!\\d)', 'gi');
  var RE_SPO2 = new RegExp(NOT_BEFORE + PFX + '(?:סטורציה|סטורציות|סטו' + Q + '|סט' + Q + '|סאטורציה|סאט' + Q + '|ריווי(?:\\s+חמצן)?|SpO2|SPO2|SAT)\\s*:?\\s*(\\d{2,3})(?!\\d|:\\d)\\s*%?', 'gi');
  var RE_O2_AIR = /(באוויר|באויר|אוויר החדר|אויר החדר|ללא חמצן|בלי חמצן|לפני חמצן|לפני מתן חמצן|room air|RA)/i;
  var RE_O2_ON = /((?:עם|על|תחת|לאחר|אחרי|במתן)\s+חמצן|בחמצן|על O2|עם O2|O2)/i;
  var RE_GLU = new RegExp(NOT_BEFORE + PFX + '(?:סוכר(?:\\s+בדם)?|רמת\\s+סוכר|גלוקוז(?:ה)?|דקסטרו|BGL|גלוקומטר)\\s*:?\\s*(\\d{2,3}|HI|LO|HIGH|LOW)(?![\\d' + HB + 'A-Za-z])', 'gi');
  var RE_GLU_GEL_BEFORE = /(ג['"\u05F3\u05F4]?ל|ג'ל|ג׳ל)\s*$/;
  var RE_GLU_UNIT_AFTER = /^\s*(גרם|גר'|ג'|ג׳)(?![א-ת])/; // grams = sugar given, not a reading
  var RE_TEMP = new RegExp(NOT_BEFORE + PFX + '(?:חום(?:\\s+גוף)?|טמפרטורה|טמפ' + Q + ')\\s*:?\\s*(\\d{2}(?:[.,]\\d)?)(?!\\d)\\s*(?:מעלות)?', 'gi');
  var RE_FAST = /(BE[-\s]?FAST|FAST|פאסט|בי\s*פאסט)\s*[:\-]?\s*(.*)$/i;

  var DRUGS = ['אספירין', 'אספירן', 'אדרנלין', 'אפינפרין', 'אפיפן', 'אפי פן', 'EpiPen', 'נלוקסון', 'נרקן', 'נרקאן', 'Naloxone',
    'ונטולין', 'משאף', 'ניטרו', 'ניטרוגליצרין', 'גלוקוז', 'גלוקוזה', 'דקסטרוז', 'ג' + Q + 'ל\\s*סוכר', 'ג' + Q + 'ל\\s*גלוקוז', 'סוכר בפה',
    'אקמול', 'פרמין', 'אנטיהיסטמין', 'פנרגן', 'אופטלגין', 'Aspirin'];
  var RE_DRUG = words(DRUGS, { prefix: true });
  var RE_DOSE = /\d+(?:[.,]\d+)?\s*(?:מ["\u05F4]?ג|mg|מיקרוגרם|mcg|מ["\u05F4]?ל|ml|יח['\u05F3]|פאפים|לחיצות)/i;
  var RE_TX_VERB = words(['ניתן', 'ניתנה', 'ניתנו', 'נתתי', 'נתנו', 'נתן', 'הוזרק', 'הוזרקה', 'הזרקתי', 'הזרקנו', 'הזרקה', 'מתן', 'סיוע', 'סייעתי', 'סייענו',
    'בלעיסה', 'לעס', 'לעסה', 'הוחל', 'הוחלה', 'בוצע', 'בוצעה', 'בוצעו', 'ביצעתי', 'ביצענו', 'חובר', 'חוברה', 'חיברתי', 'חיברנו', 'הופעל', 'הופעלה', 'הפעלתי', 'הפעלנו',
    'התחלתי', 'התחלנו', 'קיבל', 'קיבלה', 'הונשם', 'הונשמה', 'הנשמתי', 'הנשמנו', 'הושם', 'הושמה', 'הוספתי', 'העליתי', 'הורדתי']);
  var RE_HISTORY_MED = words(['נוטל', 'נוטלת', 'קבוע', 'קבועה', 'קבועות', 'כרוני', 'כרונית', 'באופן קבוע', 'תרופות בבית', 'מרשם']);
  var RE_OXYGEN = words(['חמצן', 'O2'], { prefix: true });
  var RE_O2_FLOW = /\d+\s*(?:ליטר|ל['\u05F3]|ל\/ד|ל\/דקה|lpm|LPM|L)(?![א-ת])/;
  var RE_O2_DEVICE = words(['מסכה', 'מסיכה', 'מסכת', 'משקפיים', 'משקפי חמצן', 'קנולה', 'אמבו', 'BVM', 'שקית', 'מסכה עם שקית', 'NRB']);
  var RE_DRESS = words(['חבישה', 'חבישות', 'חבשתי', 'חבשנו', 'נחבש', 'נחבשה', 'נחבשו', 'תחבושת', 'תחבושות', 'תחבושת לחץ', 'גאזה', 'גזה', 'פדים',
    'חסם עורקים', 'ח' + Q + 'ע', 'טורניקט', 'לחץ ישיר', 'אריזת פצע', 'ארזתי', 'ארזנו', 'חבישה אישית', 'תחבושת אישית', 'פלסטר', 'כוויות?\\s+נקרר', 'חבישת כוויה']);
  var RE_PROC = words(['החייאה', 'החייאת', 'עיסוי', 'עיסויים', 'עיסויי חזה', 'CPR', 'AED', 'דפיברילטור', 'מכה חשמלית', 'מכת חשמל', 'הנשמה', 'הנשמות', 'הנשמתי',
    'אמבו', 'BVM', 'היימליך', 'דחיפות בטן', 'לחיצות בטן', 'טפיחות גב', 'טפיחות', 'קיבוע', 'קיבעתי', 'קיבענו', 'קובע', 'קובעה', 'סד', 'סדים', 'צווארון', 'מקבע', 'לוח גב',
    'קרש', 'השכבה', 'הושכב', 'הושכבה', 'השכבתי', 'תנוחת', 'תנוחה', 'תנוחה מוטה', 'הרמת רגליים', 'קירור', 'קיררתי', 'קיררנו', 'שאיבה', 'שאבתי', 'פתיחת נתיב', 'ניקוי דרכי',
    'דחיקת לסת', 'הטיית ראש', 'קבלת לידה', 'חבל הטבור', 'חבל טבור', 'ייבוש', 'חימום', 'כיסוי', 'שמיכה', 'מדבקות', 'שטיפה', 'שטפתי', 'הושב', 'הושבה', 'הושבתי'], {});
  var RE_SHOCK = /(?:^|[^א-ת])(?:ו)?(?:שוק|שוקים)(?![א-ת])/;
  var RE_NEG_TX = /(?:^|[^א-ת])(?:לא|ללא|בלי)\s+(?:ניתן|ניתנה|ניתנו|נדרש|נדרשה|בוצע|בוצעה|בוצעו|הותאם|הומלץ)(?![א-ת])/;

  // Chief complaint = the reason we were called. An explicit "תלונה עיקרית:" wins, then the reason for the call,
  // then the patient's own complaint. Everything else stays in the anamnesis.
  var RE_COMPLAINT = [
    /(?:תלונה(?:\s+עיקרית)?|סיבת\s+(?:ה)?(?:קריאה|הזנקה|פנייה))\s*[:\-]\s*(.+)$/,
    /(?:הזעיק|הזעיקה|הזעיקו|הוזעקנו|הוזעקתי|הוזנקנו|הוזנקתי|הוקפצנו|הוקפצתי|נקראנו|נקראתי|הוזמנו|הזמינו|התקשר|התקשרה|התקשרו|פנה|פנתה|פנו|קריאה|קריאת|הזנקה)\s+(?:בשל|עקב|בגלל|בעקבות|על|ל|אל)\s*(.+)$/,
    /מתלונ(?:ן|נת|נים|נות)\s+(?:על\s+)?(.+)$/
  ];

  var BUCKETS = [
    ['followup', words(['פונה', 'פונתה', 'פונו', 'פינוי', 'פינינו', 'פיניתי', 'יפונה', 'הועבר', 'הועברה', 'נמסר', 'נמסרה', 'מסירה', 'לבית החולים', 'לבית חולים',
      'בי' + Q + 'ח', 'ביה' + Q + 'ח', 'מיון', 'נט' + Q + 'ן', 'אט' + Q + 'ן', 'ניידת', 'אמבולנס', 'סירב', 'סירבה', 'סירוב', 'מסרב', 'מסרבת', 'נשאר בביתו', 'נשארה בביתה',
      'נשאר בבית', 'נשארה בבית', 'הומלץ', 'המלצה', 'המשך טיפול', 'רופא משפחה', 'שוחרר', 'שוחררה'])],
    ['witnesses', words(['לדברי', 'לפי עדות', 'לפי עדים', 'עדות', 'עדים', 'עד ראייה', 'עדי ראייה', 'סיפר', 'סיפרה', 'סיפרו', 'מספר ש', 'מספרת ש', 'מספרים ש', 'מדווח', 'מדווחת', 'דיווח', 'דיווחה',
      'העיד', 'העידה', 'עובר אורח', 'עוברת אורח', 'עוברי אורח', 'בן משפחה', 'בני משפחה', 'בת משפחה', 'קרוב משפחה', 'אשתו', 'בעלה', 'בתו', 'בנו', 'בתה', 'בנה',
      'הוריו', 'הוריה', 'לפי האם', 'לפי האב', 'לפי ההורים', 'אמא שלו', 'אמא שלה', 'אבא שלו', 'אבא שלה', 'האמא', 'האבא', 'אמו', 'אמה', 'אביו', 'אביה', 'שכן', 'שכנה', 'שכנים', 'חברו', 'חברתו', 'חברה שלו', 'המשפחה', 'מטפלת', 'המטפלת', 'עובדת זרה', 'מורה', 'גננת'])],
    ['unusual', words(['חריג', 'חריגה', 'יוצא דופן', 'לא שגרתי', 'שים לב', 'לתשומת לב', 'הערה\\s*:', 'אלים', 'אלימה', 'אלימות', 'תוקפני', 'תוקפנית', 'סכנה', 'מסוכן',
      'נשק', 'משטרה', 'שוטר', 'שוטרים', 'מוזנח', 'מוזנחת', 'הזנחה', 'אלכוהול', 'שיכור', 'שיכורה', 'סמים', 'ריח אלכוהול', 'לבד בבית', 'נעול', 'פריצה'], { open: true })],
    ['background', words(['רקע', 'ידוע כ', 'ידועה כ', 'ידוע ב', 'ידועה ב', 'ידוע', 'ידועה', 'מחלות', 'סובל מ', 'סובלת מ', 'נוטל', 'נוטלת', 'תרופות', 'אלרגי', 'אלרגיה', 'אלרגית',
      'אלרגיות', 'רגיש ל', 'רגישה ל', 'רגישות', 'ניתוח', 'ניתוחים', 'אושפז', 'אושפזה', 'מעשן', 'מעשנת', 'סוכרת', 'סוכרתי', 'סוכרתית', 'יל' + Q + 'ד', 'יתר ל' + Q + 'ד',
      'לחץ דם גבוה', 'COPD', 'אסטמה', 'אסתמה', 'אי ספיקת', 'אי-ספיקת', 'אפילפסיה', 'אפילפטי', 'דמנציה', 'קוצב', 'צנתור', 'מחלת לב', 'כולסטרול', 'היסטוריה', 'בעבר',
      'שבוע', 'הריון', 'בהריון', 'לידה קודמת'], { open: true })],
    ['findings', words(['נמצא', 'נמצאה', 'נמצאו', 'בהגעה', 'בהגעתנו', 'בהגעתי', 'בבדיקה', 'בבדיקתו', 'בבדיקתה', 'ללא הכרה', 'בהכרה', 'מחוסר הכרה', 'מחוסרת הכרה',
      'מגיב', 'מגיבה', 'חיוור', 'חיוורת', 'חיוורון', 'מזיע', 'מזיעה', 'הזעה', 'כחלון', 'ציאנוטי', 'ציאנוטית', 'אישונים', 'פצע', 'פצעים', 'חתך', 'דימום', 'מדמם', 'מדממת',
      'נפיחות', 'עיוות', 'שבר', 'כוויה', 'כוויות', 'GCS', 'AVPU', 'מבולבל', 'מבולבלת', 'מתמצא', 'מתמצאת', 'ער', 'ערה', 'צניחת', 'חולשת', 'חולשה', 'הקאה', 'הקיא', 'הקיאה',
      'חרחורים', 'צפצופים', 'חם למגע', 'קר למגע', 'לח', 'פריחה', 'נפוח', 'נפוחה', 'שוכב', 'שוכבת', 'יושב', 'יושבת', 'עומד', 'נופל', 'נפל', 'נפלה'])]
  ];
  var BUCKET_ORDER = ['background', 'story', 'findings', 'unusual', 'witnesses', 'followup'];

  /* ---------- helpers ---------- */
  function addSpan(spans, start, end) { spans.push([start, end]); }
  function residualWords(sentence, spans) {
    var chars = sentence.split('');
    spans.forEach(function (s) { for (var i = s[0]; i < s[1] && i < chars.length; i++) chars[i] = ' '; });
    var rest = chars.join('').replace(RE_VITAL_CTX, ' ').replace(/[\d.,:;%\/\\\-–—()"'״׳]/g, ' ');
    var ws = rest.split(/\s+/).filter(function (w) { return w.length >= 2 && !/^(ו|וה|של|עם|על|ב|ה|גם|כן|לא|ו?הוא|ו?היא|מ|את)$/.test(w); });
    return ws.length;
  }
  var RE_VITAL_CTX = /(לא\s*סדיר|אי[\s-]?סדיר|סדיר|באוויר|באויר|אוויר החדר|(?:עם|על|תחת)\s+חמצן|בחמצן|מאומצ[א-ת]*|תקינ[א-ת]*|תקין|שטחי[א-ת]*|רדוד[א-ת]*|מ["\u05F4]?ג\/ד[״"]?ל)/g;
  // After a measurement, also take the words that qualify it (%, "סדיר", "באוויר", "עם חמצן", units).
  var RE_CTX_HEAD = /^\s*(?:%|לא\s*סדיר|לא-סדיר|אי[\s-]?סדיר|סדיר|באוויר|באויר|באוויר החדר|(?:עם|על|תחת|לאחר|אחרי)\s+חמצן|בחמצן|מאומצ[א-ת]*|תקינ[א-ת]*|תקין|שטחי[א-ת]*|רדוד[א-ת]*|רועש[א-ת]*|מ["\u05F4]?ג(?:\s*\/\s*ד["\u05F4]?ל)?|mg\/dl|מעלות|לדקה|בדקה|ממ["\u05F4]?כ|בבדיקה|במדידה|בגלוקומטר)(?![א-ת])/;
  function eatContext(s, end) {
    var m;
    while ((m = s.slice(end).match(RE_CTX_HEAD))) end += m[0].length;
    return end;
  }
  function withoutSpans(sen, spans) {
    if (!spans.length) return sen;
    var keep = sen.split('');
    spans.forEach(function (sp) { for (var i = sp[0]; i < sp[1]; i++) keep[i] = '\u0000'; });
    var out = keep.join('').replace(/\u0000+/g, '\u0000')
      .replace(/\s*[,;]?\s*\u0000\s*/g, ', ')                    // a removed measurement leaves one comma
      .replace(/(,\s*)+/g, ', ').replace(/\s+([,.;:!?])/g, '$1')
      .replace(/^[\s,;:\-–.]+/, '').replace(/[\s,;:\-–]+$/, '').replace(/,\s*\./g, '.')
      .replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    return /[א-תA-Za-z]{2}/.test(out) ? out : '';
  }
  function eachMatch(re, s, fn) { re.lastIndex = 0; var m; while ((m = re.exec(s))) { fn(m); if (!re.global) break; } }
  // Context of a measurement stays inside its clause: stop at a comma, and after it also at the next number.
  function windowAfter(s, from, len) {
    var w = s.slice(from, from + len);
    var cut = w.search(/[\d,;]/);
    return cut === -1 ? w : w.slice(0, cut);
  }
  function windowBefore(s, to, len) {
    var w = s.slice(Math.max(0, to - len), to);
    var i = Math.max(w.lastIndexOf(','), w.lastIndexOf(';'));
    return i === -1 ? w : w.slice(i + 1);
  }
  function endPunct(s) { return /[.!?…:]$/.test(s) ? s : s + '.'; }

  /* ---------- main ---------- */
  function extract(notes, opts) {
    opts = opts || {};
    notes = (notes || []).slice().sort(function (a, b) { return a.t - b.t; });

    var cand = { first: [], last: [], age: [], sex: [], idnum: [], hmo: [] };
    var vitals = [];
    var tx = { oxygen: [], dressings: [], meds: [], procedures: [] };
    var hist = { background: [], story: [], findings: [], unusual: [], witnesses: [], followup: [] };
    var warnings = [];

    /* chief complaint: an explicit complaint beats the dispatch reason; earliest wins */
    var best = null;
    notes.forEach(function (note) {
      splitSentences(note.text).forEach(function (sen) {
        for (var i = 0; i < RE_COMPLAINT.length; i++) {
          var cm = sen.match(RE_COMPLAINT[i]);
          if (cm && cm[1].trim() && (!best || i < best.idx)) best = { idx: i, value: cm[1].trim().replace(/[.;]\s*$/, ''), sen: sen, src: note.id };
        }
      });
    });
    var complaint = best ? { value: best.value, src: [best.src] } : null;

    notes.forEach(function (note) {
      var noteTime = null; // an explicit time carries on to the following sentences of the same note
      splitSentences(note.text).forEach(function (sen) {
        var spans = [], vspans = [], at = timeIn(sen, note.t), src = note.id;
        if (at.explicit) noteTime = at; else if (noteTime) at = noteTime;
        function v(field, value, m) {
          vitals.push({ field: field, value: value, t: at.t, explicit: at.explicit, src: src });
          if (m) { var end = eatContext(sen, m.index + m[0].length); addSpan(spans, m.index, end); addSpan(vspans, m.index, end); }
        }
        function c(field, value, m, extra) { cand[field].push({ value: value, src: src, t: note.t, extra: extra }); if (m) addSpan(spans, m.index, m.index + m[0].length); }

        /* demographics */
        eachMatch(RE_FIRST, sen, function (m) { if (!NAME_STOP.test(m[1])) c('first', m[1], m); });
        eachMatch(RE_LAST, sen, function (m) { if (!NAME_STOP.test(m[1])) c('last', m[1], m); });
        eachMatch(RE_NAME, sen, function (m) {
          if (NAME_STOP.test(m[1])) return;
          c('first', m[1], m);
          if (m[2] && !NAME_STOP.test(m[2])) c('last', m[2]);
        });
        eachMatch(RE_AGE, sen, function (m) {
          if (FAMILY_BEFORE.test(sen.slice(0, m.index))) return;
          var kw = m[1], n = m[2], unit = m[3];
          var value = (kw.indexOf('כ') === 0 ? 'כ-' : '') + n + (unit && !/^שנ/.test(unit) ? ' ' + unit : '');
          c('age', value, m);
          if (/^כ?בן$/.test(kw)) c('sex', 'זכר');
          if (/^כ?בת$/.test(kw)) c('sex', 'נקבה');
        });
        eachMatch(RE_SEX_M, sen, function (m) { if (!FAMILY_BEFORE.test(sen.slice(0, m.index))) c('sex', 'זכר'); });
        eachMatch(RE_SEX_F, sen, function (m) { if (!FAMILY_BEFORE.test(sen.slice(0, m.index))) c('sex', 'נקבה'); });
        eachMatch(RE_ID, sen, function (m) {
          var digits = m[1].replace(/\D/g, '');
          if (digits.length >= 5 && digits.length <= 9) c('idnum', digits, m, { valid: validIsraeliId(digits) });
        });
        var hmoFound = false;
        eachMatch(RE_HMO_CTX, sen, function (m) { hmoFound = true; c('hmo', HMOS[m[1]], m); });
        if (!hmoFound) eachMatch(RE_HMO_BARE, sen, function (m) { c('hmo', HMOS[m[1]], m); });

        /* vitals */
        eachMatch(RE_PULSE, sen, function (m) {
          v('pulse', m[1], m);
          var r = windowAfter(sen, m.index + m[0].length, 22).match(RE_RHYTHM);
          if (r) { vitals.push({ field: 'pulseRhythm', value: r[1].replace(/-/g, ' ').replace(/^אי\s?/, 'לא '), t: at.t, explicit: at.explicit, src: src }); }
        });
        eachMatch(RE_NO_PULSE, sen, function (m) { v('pulse', 'ללא דופק', m); });
        eachMatch(RE_RR, sen, function (m) {
          if (/קוצר\s*$/.test(sen.slice(0, m.index))) return;
          v('rr', m[1], m);
          var r = windowAfter(sen, m.index + m[0].length, 22).match(RE_RR_QUALITY);
          if (r) vitals.push({ field: 'rrQuality', value: r[1], t: at.t, explicit: at.explicit, src: src });
        });
        eachMatch(RE_RR_WORD, sen, function (m) {
          if (/קוצר\s*$/.test(sen.slice(0, m.index + 1))) return;
          if (!vitals.some(function (x) { return x.field === 'rrQuality' && x.src === src && x.t === at.t; })) v('rrQuality', m[1], m);
        });
        eachMatch(RE_NO_BREATH, sen, function (m) { v('rr', 'ללא נשימה', m); });
        eachMatch(RE_BP, sen, function (m) { v('bp', m[1] + '/' + m[2], m); });
        eachMatch(RE_SPO2, sen, function (m) {
          var after = windowAfter(sen, m.index + m[0].length, 30), before = windowBefore(sen, m.index, 45);
          var field = 'spo2';
          if (RE_O2_AIR.test(after) || (!RE_O2_ON.test(after) && RE_O2_AIR.test(before))) field = 'spo2Air';
          else if (RE_O2_ON.test(after) || RE_O2_ON.test(before)) field = 'spo2O2';
          v(field, m[1], m);
        });
        eachMatch(RE_GLU, sen, function (m) {
          if (RE_GLU_GEL_BEFORE.test(sen.slice(0, m.index))) return;
          if (RE_GLU_UNIT_AFTER.test(sen.slice(m.index + m[0].length))) return;
          v('glucose', m[1].toUpperCase() === m[1] ? m[1] : m[1], m);
        });
        eachMatch(RE_TEMP, sen, function (m) { var n = parseFloat(m[1].replace(',', '.')); if (n >= 30 && n <= 44) v('temp', m[1].replace(',', '.'), m); });
        var fm = sen.match(RE_FAST);
        if (fm) {
          var val = fm[2].replace(/^[\s:\-–]+/, '').replace(/[.;]\s*$/, '').trim();
          vitals.push({ field: 'fast', value: val || 'בוצע', t: at.t, explicit: at.explicit, src: src });
          addSpan(spans, fm.index, sen.length); addSpan(vspans, fm.index, sen.length);
        }

        /* chief complaint */
        var isComplaint = !!(best && best.sen === sen && best.src === src);

        /* treatments */
        var negated = RE_NEG_TX.test(sen);
        var isTx = false;
        if (!negated) {
          if (RE_OXYGEN.test(sen) && (RE_O2_FLOW.test(sen) || RE_O2_DEVICE.test(sen) || RE_TX_VERB.test(sen))) { tx.oxygen.push({ text: sen, src: src }); isTx = true; }
          if (RE_DRESS.test(sen)) { tx.dressings.push({ text: sen, src: src }); isTx = true; }
          if (RE_DRUG.test(sen) && !RE_HISTORY_MED.test(sen) && (RE_TX_VERB.test(sen) || RE_DOSE.test(sen))) { tx.meds.push({ text: sen, src: src }); isTx = true; }
          if (RE_PROC.test(sen) || RE_SHOCK.test(sen)) { tx.procedures.push({ text: sen, src: src }); isTx = true; }
        }

        /* narrative */
        var clean = withoutSpans(sen, vspans); // measurements live in "בדיקות שבוצעו", not in the narrative
        var item = { text: clean, src: src };
        if (!clean) return;
        if (BUCKETS[0][1].test(sen)) { hist.followup.push(item); return; }
        if (isTx || isComplaint) return;
        if (residualWords(sen, spans) < 1) return; // only demographics / measurements
        if (negated) { hist.unusual.push(item); return; }
        for (var b = 1; b < BUCKETS.length; b++) {
          if (BUCKETS[b][1].test(sen)) { hist[BUCKETS[b][0]].push(item); return; }
        }
        hist.story.push(item);
      });
    });

    /* resolve demographics: latest value wins, disagreement → warning */
    var LABEL = { first: 'שם פרטי', last: 'שם משפחה', age: 'גיל', sex: 'מין', idnum: 'ת״ז', hmo: 'קופת חולים' };
    var demo = {}, sources = {};
    Object.keys(cand).forEach(function (k) {
      var list = cand[k];
      if (!list.length) return;
      var distinct = [];
      list.forEach(function (x) { if (distinct.indexOf(x.value) === -1) distinct.push(x.value); });
      var chosen = list[list.length - 1];
      demo[k] = chosen.value;
      sources['demo.' + k] = uniq(list.filter(function (x) { return x.value === chosen.value; }).map(function (x) { return x.src; }));
      if (distinct.length > 1) warnings.push({ field: 'demo.' + k, text: LABEL[k] + ': בפתקים מופיעים כמה ערכים (' + distinct.join(', ') + '). נבחר האחרון — יש לוודא.' });
      if (k === 'idnum' && chosen.extra && !chosen.extra.valid) warnings.push({ field: 'demo.idnum', text: 'ת״ז ' + chosen.value + ': ספרת הביקורת אינה תקינה — יש לוודא את המספר.' });
    });

    /* vitals → rounds (same time ±3 min, no field repeated) */
    vitals.sort(function (a, b) { return a.t - b.t; });
    var rounds = [];
    vitals.forEach(function (x) {
      var r = rounds[rounds.length - 1];
      var base = x.field === 'pulseRhythm' ? 'pulse' : x.field === 'rrQuality' ? 'rr' : null;
      var fits = r && x.t - r.t <= 3 * 60000 && (base ? !r.values[x.field] : !r.values[x.field]);
      if (base && r && r.values[base] && !r.values[x.field] && r.src.indexOf(x.src) !== -1) fits = true;
      if (!fits) { r = { t: x.t, values: {}, src: [] }; rounds.push(r); }
      r.values[x.field] = x.value;
      if (r.src.indexOf(x.src) === -1) r.src.push(x.src);
    });

    /* narrative and treatments → verbatim text */
    var history = {};
    BUCKET_ORDER.forEach(function (k) {
      if (!hist[k].length) return;
      history[k] = hist[k].map(function (x) { return endPunct(x.text); }).join(' ');
      sources['hist.' + k] = uniq(hist[k].map(function (x) { return x.src; }));
    });
    var treatments = {};
    Object.keys(tx).forEach(function (k) {
      if (!tx[k].length) return;
      var seen = [];
      treatments[k] = tx[k].filter(function (x) { if (seen.indexOf(x.text) !== -1) return false; seen.push(x.text); return true; })
        .map(function (x) { return x.text; }).join('\n');
      sources['tx.' + k] = uniq(tx[k].map(function (x) { return x.src; }));
    });
    if (complaint) sources.complaint = complaint.src;

    var caseSuggestions = suggestCases(notes, opts.cases || []);
    // One case when it clearly fits best; otherwise leave it open and offer the candidates.
    var clear = caseSuggestions.length === 1 || (caseSuggestions.length > 1 && caseSuggestions[0].score >= 2 * caseSuggestions[1].score);

    return {
      generatedAt: Date.now(),
      demo: demo,
      caseId: clear ? caseSuggestions[0].id : '',
      caseAuto: !!clear,
      caseText: '',
      caseSuggestions: caseSuggestions,
      complaint: complaint ? complaint.value : '',
      history: history,
      vitals: rounds.map(function (r) { return { t: r.t, values: r.values, src: r.src }; }),
      treatments: treatments,
      sources: sources,
      warnings: warnings
    };
  }

  function uniq(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) === -1) o.push(x); }); return o; }

  /* ---------- case list (supplied by the organisation) ---------- */
  var FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  function norm(s) {
    return String(s || '').normalize('NFKD').replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, '').replace(/["'`\u05F3\u05F4\u201C\u201D]/g, '')
      .replace(/[ךםןףץ]/g, function (c) { return FINALS[c]; }).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  // Generic words in case titles that say nothing about the case on their own.
  var TITLE_STOP = {};
  ['חשד', 'בעיות', 'אחרות', 'לאחר', 'פגיעת', 'חבלת', 'חבלה', 'ביטול', 'מינונ', 'מינון', 'יתר', 'ידי', 'מקור', 'שאינו', 'במקומ', 'צורכ', 'בנוספימ',
    'קלה', 'קשה', 'משמעותי', 'ללא', 'המטופל', 'המקומ', 'יולדת', 'מצב', 'למצב', 'במצב', 'רפואיות', 'רפואי', 'לצוות', 'סיוע', 'אירוע', 'עצמי', 'יציאה',
    'נמצאה', 'כתובת', 'המוקד', 'משטרה', 'עזב', 'תגובת', 'כאבימ', 'כאבי']
    .forEach(function (w) { TITLE_STOP[w] = 1; });
  function suggestCases(notes, cases) {
    if (!cases || !cases.length) return [];
    var hay = ' ' + norm(notes.map(function (n) { return n.text; }).join(' ')) + ' ';
    return cases.map(function (cs) {
      var terms = (cs.keywords || []).concat(norm(cs.title).split(' ').filter(function (w) { return w.length >= 3 && !TITLE_STOP[w]; }));
      var hits = uniq(terms.map(norm).filter(function (t) { return t && hay.indexOf(t) !== -1; }));
      hits = hits.filter(function (h) { return !hits.some(function (o) { return o !== h && o.indexOf(h) !== -1; }); }); // "בחזה" inside "כאבים בחזה" counts once
      return { id: cs.id, score: hits.length, hits: hits };
    }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
  }

  /* ---------- plain-text report ---------- */
  var VITAL_LABELS = [
    ['pulse', 'דופק'], ['pulseRhythm', ''], ['rr', 'נשימות'], ['rrQuality', ''], ['bp', 'ל״ד'],
    ['spo2Air', 'סטורציה באוויר'], ['spo2O2', 'סטורציה עם חמצן'], ['spo2', 'סטורציה (לא צוין אם עם חמצן)'], ['glucose', 'סוכר'], ['temp', 'חום'], ['fast', 'FAST']
  ];
  var HISTORY_LABELS = { background: 'רקע רפואי', story: 'סיפור המקרה', findings: 'ממצאים', unusual: 'פרטים חריגים', witnesses: 'עדויות', followup: 'המשך טיפול' };
  var TX_LABELS = { oxygen: 'חמצן', dressings: 'חבישות', meds: 'תרופות', procedures: 'הליכים' };
  var DEMO_LABELS = { first: 'שם פרטי', last: 'שם משפחה', age: 'גיל', sex: 'מין', idnum: 'ת״ז', hmo: 'קופת חולים' };

  function vitalLine(values) {
    var parts = [];
    VITAL_LABELS.forEach(function (p) {
      var k = p[0], val = values[k];
      if (!val || k === 'pulseRhythm' || k === 'rrQuality') return;
      var s = /^ללא/.test(val) ? val : p[1] + ' ' + val;
      if (/^spo2/.test(k) && /^\d+$/.test(val)) s += '%';
      if (k === 'pulse' && values.pulseRhythm) s += ' ' + values.pulseRhythm;
      if (k === 'rr' && values.rrQuality) s += ' ' + values.rrQuality;
      if (k === 'fast') s = 'FAST: ' + val;
      parts.push(s);
    });
    if (!values.pulse && values.pulseRhythm) parts.unshift('דופק ' + values.pulseRhythm);
    if (!values.rr && values.rrQuality) parts.unshift('נשימה ' + values.rrQuality);
    return parts.join(' · ');
  }

  function toText(r, meta) {
    meta = meta || {};
    var L = [];
    var hhmm = function (t) { var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
    L.push('דוח אירוע — טיוטה');
    if (meta.start) { var d = new Date(meta.start); L.push('תאריך: ' + d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' · שעת פתיחה: ' + hhmm(meta.start)); }
    var demo = Object.keys(DEMO_LABELS).filter(function (k) { return r.demo && r.demo[k]; });
    if (demo.length) { L.push('', 'פרטים דמוגרפיים'); demo.forEach(function (k) { L.push(DEMO_LABELS[k] + ': ' + r.demo[k]); }); }
    var caseLine = [meta.caseTitle, r.caseText].filter(Boolean).join(' — ');
    if (caseLine) L.push('', 'המקרה שנמצא: ' + caseLine);
    if (r.complaint) L.push('', 'תלונה עיקרית: ' + r.complaint);
    var hk = Object.keys(HISTORY_LABELS).filter(function (k) { return r.history && r.history[k]; });
    if (hk.length) { L.push('', 'אנמנזה וסיפור המקרה'); hk.forEach(function (k) { L.push(HISTORY_LABELS[k] + ': ' + r.history[k]); }); }
    var vs = (r.vitals || []).filter(function (x) { return vitalLine(x.values); });
    if (vs.length) { L.push('', 'בדיקות שבוצעו'); vs.forEach(function (x) { L.push(hhmm(x.t) + ' — ' + vitalLine(x.values)); }); }
    var tk = Object.keys(TX_LABELS).filter(function (k) { return r.treatments && r.treatments[k]; });
    if (tk.length) { L.push('', 'טיפולים שניתנו'); tk.forEach(function (k) { L.push(TX_LABELS[k] + ': ' + r.treatments[k].split('\n').join(' | ')); }); }
    return L.join('\n');
  }

  var api = {
    extract: extract, toText: toText, splitSentences: splitSentences, validIsraeliId: validIsraeliId, vitalLine: vitalLine,
    VITAL_LABELS: VITAL_LABELS, HISTORY_LABELS: HISTORY_LABELS, TX_LABELS: TX_LABELS, DEMO_LABELS: DEMO_LABELS, norm: norm
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BLSExtract = api;
})(typeof self !== 'undefined' ? self : this);
