// The walkthrough as an optional guide.
//
// The guide is the reader's own Walkthrough.txt (copied into data/ by
// tools/extract.py), parsed here: a list of days, each a list of choices to
// take in order, with a quiz's answers on one day and two ways to end. Nothing
// of it is written into the code.
//
// While it is on, the game knows which day of the guide it is and which choice
// comes next; the choice is marked, never taken for the reader. Taking another
// choice puts the guide aside for the rest of that day, and the day is offered
// again next time. No DOM here, so it can be tested under Node.

const words = (s) => s.toLowerCase().replace(/^\s*\d+\s*[.)]\s*/, '').replace(/[`|^]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// 1 when the two say the same thing, less as their words differ
// The choices a script offers, in order: [{ key: where the options lead, texts }].
function choiceSets(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/(?:^|[:\s])sel(?:ect|gosub)\s+["`$]/.test(lines[i]) || /^\s*;/.test(lines[i])) continue;
    let stmt = lines[i];
    while (/,\s*$/.test(stmt) && i + 1 < lines.length) stmt += '\n' + lines[++i];
    const texts = [], labels = [];
    for (const m of stmt.matchAll(/(?:"([^"]*)"|`([^`]*)`)\s*,\s*\*([A-Za-z0-9_]+)/g)) {
      texts.push(m[1] !== undefined ? m[1] : m[2]);
      labels.push(m[3].toLowerCase());
    }
    if (texts.length) out.push({ key: labels.join(','), texts });
  }
  return out;
}
const squash = (texts) => texts.map((t) => String(t).replace(/\s+/g, '')).join('\u0001');

// For a story running in another language than the walkthrough's: its choices lead to the same
// places as the reference script's, so each set of options is paired with the reference's set that
// leads there (the n-th with the n-th, where several do). Gives a function that turns the options
// offered (and where they lead) into the reference's wording, or returns them as they are.
export function choiceTranslator(src, refSrc) {
  const byKey = new Map();
  for (const s of choiceSets(refSrc)) { if (!byKey.has(s.key)) byKey.set(s.key, []); byKey.get(s.key).push(s.texts); }
  const seen = new Map(), table = new Map();
  for (const s of choiceSets(src)) {
    const k = seen.get(s.key) || 0;
    seen.set(s.key, k + 1);
    const ref = (byKey.get(s.key) || [])[k];
    if (ref && ref.length === s.texts.length) table.set(s.key + '\u0002' + squash(s.texts), ref);
  }
  return (texts, labels) => (labels && table.get(labels.map((l) => String(l).toLowerCase()).join(',') + '\u0002' + squash(texts))) || texts;
}

// The other way round: the reference script's wording of a choice (as the flowchart has it), or the
// walkthrough's wording of it, in the words of the script that is running.
export function choiceBack(src, refSrc) {
  const byKey = new Map();
  for (const s of choiceSets(src)) { if (!byKey.has(s.key)) byKey.set(s.key, []); byKey.get(s.key).push(s.texts); }
  const seen = new Map(), exact = new Map(), all = [];
  const tidy = (x) => String(x).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  for (const s of choiceSets(refSrc)) {
    const k = seen.get(s.key) || 0;
    seen.set(s.key, k + 1);
    const own = (byKey.get(s.key) || [])[k];
    if (!own || own.length !== s.texts.length) continue;
    s.texts.forEach((ref, i) => {
      const key = squash([ref]);
      if (!exact.has(key)) exact.set(key, tidy(own[i]));
      all.push([ref, tidy(own[i])]);
    });
  }
  const near = new Map();
  return {
    exact: (text) => exact.get(squash([text])) || null,
    // the walkthrough writes a choice in its own words: the closest of the reference's
    near: (text) => {
      if (near.has(text)) return near.get(text);
      let best = null, score = 0.6;
      for (const [ref, own] of all) { const sc = similarity(text, ref); if (sc > score) { score = sc; best = own; } }
      near.set(text, best);
      return best;
    },
  };
}

export function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}
const optionNumber = (text) => { const m = /^\s*[`]?\s*(\d+)\s*[.)]/.exec(text); return m ? parseInt(m[1], 10) : 0; };

export function parseGuide(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const days = [];            // [{ n, entry, steps: [{ k, text }], notes: [], quiz: null | 'miss' | [{ name, answers: [{ k, text }] }] }]
  const endings = {};         // name -> [day, ...] (the last days, which differ by ending)
  let day = null, ending = null, quizSet = null, inQuiz = false;
  const start = (n, entry) => {
    day = { n, entry, steps: [], notes: [], quiz: null };
    inQuiz = false;
    quizSet = null;
    if (ending) endings[ending].push(day); else days.push(day);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^-{5,}$/.test(line)) continue;
    let m;
    if ((m = /^(Normal|True) End:/i.exec(line))) { ending = m[1].toLowerCase(); endings[ending] = []; day = null; continue; }
    if ((m = /^Day (\d+):\s*(.*)$/i.exec(line))) {
      const rest = m[2].toLowerCase();
      start(parseInt(m[1], 10), /select\s+"ep/.test(rest) ? 'ep' : /select\s+"op/.test(rest) ? 'op' : 'a day');
      continue;
    }
    if (!day) continue;
    if (/^answers:/i.test(line)) { inQuiz = true; day.quiz = []; continue; }
    if ((m = /^\((\d+)\)\s*(?:(\d+)\.\s*)?(.*)$/.exec(line))) {
      // "(03) 2. Text (a remark)"
      const step = { k: m[2] ? parseInt(m[2], 10) : 0, text: m[3].replace(/\s*\([^()]*\)\s*$/, '').trim() };
      if (inQuiz && quizSet) quizSet.answers.push(step); else day.steps.push(step);
      continue;
    }
    if (line[0] === '(') {
      const note = line.replace(/^\(|\)$/g, '');
      if (/key found/i.test(note)) inQuiz = false;        // the quiz is over; the day's own choices go on
      if (!/^yes, this is correct/i.test(note)) day.notes.push(note);
      continue;
    }
    if (inQuiz) { quizSet = { name: line, answers: [] }; day.quiz.push(quizSet); continue; }
    if (/miss at least one/i.test(line) && !day.quiz) day.quiz = 'miss';
  }
  return { days, endings };
}

export class Guide {
  // state: { on, day (1-based place in the list), ending: 'normal' | 'true' | null }
  constructor(text, state, save) {
    const g = parseGuide(text || '');
    this.common = g.days;
    this.endings = g.endings;
    this.state = Object.assign({ on: false, day: 1, ending: null }, state || {});
    this.save = save || (() => {});
    this.step = 0;
    this.lost = false;
    this.active = false;      // inside a day of the story
    this.dayLost = false;
  }
  get available() { return this.common.length > 0; }
  get on() { return this.state.on && this.available; }
  // every day in order, with the chosen ending's days at the end (the first of the two until one is chosen)
  get days() {
    const names = Object.keys(this.endings);
    const tail = this.endings[this.state.ending] || this.endings[names[0]] || [];
    return this.common.concat(tail);
  }
  get needsEnding() {
    return Object.keys(this.endings).length > 1 && !this.state.ending && this.state.day > this.common.length;
  }
  get finished() { return this.state.day > this.days.length; }
  get today() { return this.days[this.state.day - 1] || null; }

  setOn(on) { this.state.on = !!on; this.save(); }
  setDay(n) { this.state.day = Math.max(1, Math.min(this.days.length + 1, n)); this.step = 0; this.lost = false; this.save(); }
  setEnding(name) { this.state.ending = name; this.save(); }

  // Which entry of the story's page to take, of those it offers: today's ('a day', 'op' or 'ep'),
  // or 'op' when the day's own is not there yet (on a new save the opening has to be played once
  // before "a day" appears; the walkthrough takes that for granted).
  entryAmong(offered) {
    if (!this.on || !this.today) return null;
    if (offered.includes(this.today.entry)) return this.today.entry;
    return this.today.entry === 'a day' && offered.includes('op') ? 'op' : null;
  }

  // a day of the story begins (entry: what was chosen on the story's page)
  beginDay(entry) {
    this.active = true;
    this.step = 0;
    this.lost = !this.today || this.today.entry !== entry;
  }
  // the day is over: on to the next if every choice was the guide's
  endDay() {
    if (!this.active) return false;
    this.active = false;
    const t = this.today;
    const done = this.on && t && !this.lost && this.step >= t.steps.length;
    if (done) { this.state.day++; this.save(); }
    this.step = 0;
    return done;
  }

  // Which of these options the guide would take: its place in the list, or -1 when the guide
  // has nothing to say about this choice (not one of the day's, or the guide has been left).
  suggest(texts) {
    if (!this.on || !this.active || this.lost) return -1;
    const t = this.today;
    if (!t) return -1;
    if (Array.isArray(t.quiz)) {
      // A question of the quiz: the option that is one of the listed answers. The walkthrough gives
      // each answer with its number on the list, and the number has to agree too (two answers can
      // share a word: "Red" is right for one question and merely an option of another).
      let hit = -1, best = 0;
      texts.forEach((opt, i) => {
        const no = optionNumber(opt);
        for (const set of t.quiz) for (const a of set.answers) {
          if (a.k !== no) continue;
          const sc = similarity(a.text, opt);
          if (sc >= 0.5 && sc > best) { best = sc; hit = i; }
        }
      });
      if (hit >= 0) return hit;
    }
    const step = t.steps[this.step];
    if (!step) return -1;
    let best = -1, score = 0;
    texts.forEach((opt, i) => {
      let s = similarity(step.text, opt);
      if (step.k && optionNumber(opt) === step.k) s += 0.15;      // the same number on the list counts for a little
      if (s > score) { score = s; best = i; }
    });
    return score >= 0.6 ? best : -1;
  }
  // The reader has chosen. Returns 'kept', 'left' (another choice than the guide's) or null (not a guided choice).
  chose(texts, index) {
    if (!this.on || !this.active || this.lost) return null;
    const t = this.today;
    const want = this.suggest(texts);
    if (want < 0) return null;
    const isStep = t.steps[this.step] && similarity(t.steps[this.step].text, texts[want]) >= 0.45;
    if (index !== want) {
      if (!isStep) return null;                // a wrong answer in the quiz is the quiz's own business
      this.lost = true;
      return 'left';
    }
    if (isStep) this.step++;
    return 'kept';
  }
}
