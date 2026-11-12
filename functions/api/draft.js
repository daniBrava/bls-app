// Cloudflare Pages Function: POST /api/draft
// Turns the medic's free-text event notes into a structured report draft with Gemini.
//
// - The Gemini key lives only here (Pages secret GEMINI_API_KEY), never in the app.
// - Use of this function requires the app access code (Pages secret APP_ACCESS_CODE, sent by the app
//   in the x-app-code header). If no code is configured, a Cloudflare Access sign-in is required instead.
// - Long digit runs (ID-like numbers) are removed before anything is sent to Gemini.
// - The model is told to use only what the notes say and to cite the notes it used.
//   The app shows the result as a draft for the medic to review and edit.

const DEFAULT_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const MAX_CHARS = 20000;

const INSTRUCTIONS = `אתה עוזר לחובש רפואת חירום BLS בתרגול לסדר פתקים חופשיים לטיוטת דוח רפואי בעברית.
הפתקים נכתבו או הוכתבו במהלך אירוע, לא לפי סדר, לעיתים בלי פיסוק ועם שגיאות הכתבה.

כללים מחייבים:
1. השתמש רק במידע שכתוב בפתקים. אל תוסיף ממצאים, מדדים, טיפולים, אבחנות או פרטים שלא נכתבו. אם משהו לא נכתב, השאר את השדה ריק.
2. תלונה עיקרית: הסיבה שבגללה הוזעקו (למשל "כאבים בחזה", "חתך בשורש כף היד"). קצרה, מילים ספורות. "הוזמנו על ידי מד״א" אינו תלונה.
3. אנמנזה וסיפור המקרה: כל השאר – רקע רפואי והיסטוריה, מה קרה, ממצאים, פרטים חריגים, עדויות, תרופות קבועות, המשך טיפול – בטקסט רציף אחד, לפי סדר הכתיבה.
   בלי שם, בלי גיל ובלי מין (הם בפרטים הדמוגרפיים), ובלי ערכי מדידה (הם בבדיקות).
   מותר לתקן פיסוק ושגיאות הכתבה ברורות ולחבר למשפטים קריאים, בלי לשנות משמעות ובלי להוסיף מידע. אם מילה לא ברורה, השאר אותה כפי שהיא והוסף אזהרה.
4. בדיקות: כל סבב מדידה בנפרד, עם השעה (HH:MM) אם צוינה או שעת הפתק. דופק (מספר או תיאור) וסדירות, קצב נשימה ואופי הנשימה, לחץ דם בפורמט 120/80, סטורציה באוויר / עם חמצן / לא צוין, סוכר, חום, FAST.
   סטורציה תסווג "עם חמצן" או "באוויר" רק אם זה נאמר במפורש או ברור מההקשר המיידי; אחרת spo2.
5. טיפולים: רק מה שבוצע או ניתן בפועל בידי הצוות: חמצן (כולל ספיקה והתקן), חבישות, תרופות (כולל מינון ודרך מתן אם נכתבו), הליכים. תרופות שהמטופל נוטל באופן קבוע או לקח בעצמו לפני ההגעה – באנמנזה, לא כאן. "לא ניתן X" אינו טיפול.
6. המקרה שנמצא: בחר מזהה מתוך רשימת המקרים בלבד. אם מקרה אחד מתאים בבירור – case.id. אם יש כמה אפשרויות סבירות – השאר case.id ריק והחזר עד 3 מזהים ב-case.candidates, המתאים ביותר ראשון.
7. לכל שדה החזר src – מזהי הפתקים שמהם נלקח.
8. warnings: כל דבר שהחובש צריך לבדוק (סתירה בין פתקים, מילה לא ברורה, ערך חריג).
החזר JSON בלבד לפי הסכמה.`;

const textField = { type: 'object', properties: { text: { type: 'string' }, src: { type: 'array', items: { type: 'string' } } }, required: ['text', 'src'] };
const SCHEMA = {
  type: 'object',
  properties: {
    demo: { type: 'object', properties: { first: { type: 'string' }, last: { type: 'string' }, age: { type: 'string' }, sex: { type: 'string', enum: ['', 'זכר', 'נקבה'] }, hmo: { type: 'string' } } },
    complaint: textField,
    anamnesis: textField,
    vitals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: { type: 'string' }, pulse: { type: 'string' }, pulseRhythm: { type: 'string' }, rr: { type: 'string' }, rrQuality: { type: 'string' },
          bp: { type: 'string' }, spo2Air: { type: 'string' }, spo2O2: { type: 'string' }, spo2: { type: 'string' }, glucose: { type: 'string' },
          temp: { type: 'string' }, fast: { type: 'string' }, src: { type: 'array', items: { type: 'string' } }
        },
        required: ['time', 'src']
      }
    },
    treatments: { type: 'object', properties: { oxygen: textField, dressings: textField, meds: textField, procedures: textField } },
    case: { type: 'object', properties: { id: { type: 'string' }, candidates: { type: 'array', items: { type: 'string' } } } },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['complaint', 'anamnesis', 'vitals', 'treatments', 'case', 'warnings']
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const stripIds = (s) => String(s || '').replace(/\d[\d\- ]{3,12}\d/g, (m) => (m.replace(/\D/g, '').length >= 5 ? '[מספר הוסר]' : m));

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
}
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; // constant-time compare of the hashes
  return d === 0;
}
async function accessOk(request, env) {
  if (env.ALLOW_WITHOUT_ACCESS === '1') return true; // only for local testing
  if (env.APP_ACCESS_CODE) return sameSecret(request.headers.get('x-app-code') || '', env.APP_ACCESS_CODE);
  return Boolean(request.headers.get('cf-access-jwt-assertion'));
}
const accessMode = (env) => (env.APP_ACCESS_CODE ? 'code' : 'access');

async function callGemini(env, model, payload) {
  const url = `${env.GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent`;
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(payload) });
}

export async function onRequestPost({ request, env }) {
  if (!(await accessOk(request, env))) return json({ error: 'access_required', mode: accessMode(env) }, 401);
  if (!env.GEMINI_API_KEY) return json({ error: 'not_configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const notes = Array.isArray(body.notes) ? body.notes : [];
  if (!notes.length) return json({ error: 'no_notes' }, 400);
  const cases = Array.isArray(body.cases) ? body.cases.slice(0, 200) : [];

  const notesText = notes.map((n) => `[${String(n.id).slice(0, 40)}] ${String(n.time || '').slice(0, 5)} ${stripIds(n.text)}`).join('\n');
  if (notesText.length > MAX_CHARS) return json({ error: 'too_long' }, 413);
  const casesText = cases.map((c) => `${String(c.id).slice(0, 10)}: ${String(c.title).slice(0, 80)}`).join('\n');

  const prompt = `רשימת המקרים (מזהה: שם):\n${casesText || '(אין)'}\n\nהפתקים (מזהה, שעה, טקסט):\n${notesText}`;
  const payload = {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseJsonSchema: SCHEMA }
  };

  const models = [env.GEMINI_MODEL || DEFAULT_MODEL, FALLBACK_MODEL].filter((m, i, a) => a.indexOf(m) === i);
  let last = null;
  for (const model of models) {
    const r = await callGemini(env, model, payload);
    if (r.ok) {
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      try {
        return json({ model, draft: JSON.parse(text) });
      } catch {
        last = { status: 502, error: 'bad_model_output' };
        continue;
      }
    }
    last = { status: r.status, error: r.status === 429 ? 'rate_limited' : 'model_error', detail: (await r.text()).slice(0, 300) };
    if (![404, 429, 500, 503].includes(r.status)) break; // e.g. 400/403: a retry with another model will not help
  }
  return json(last, last.status === 429 ? 429 : 502);
}

export async function onRequestGet({ request, env }) {
  return json({ ok: true, ai: Boolean(env.GEMINI_API_KEY), access: await accessOk(request, env), mode: accessMode(env) });
}
