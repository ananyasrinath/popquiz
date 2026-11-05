// Tiny JSON-file store. No database needed for v1.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { quizzes: {}, responses: {} };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}

function save() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

const newId = () => crypto.randomBytes(4).toString('hex');

function cleanQuestions(questions) {
  return (questions || []).map((q) => {
    const options = (q.options || []).map(String).filter((o) => o.trim() !== '');
    let correct = Number(q.correct_option);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) correct = 0;
    return {
      id: q.id || newId(),
      question: String(q.question || '').trim(),
      options,
      correct_option: correct,
      explanation: String(q.explanation || '').trim(),
    };
  }).filter((q) => q.question && q.options.length >= 2);
}

function createQuiz({ title, description, questions, pass_mark, source }) {
  const id = newId();
  const now = new Date().toISOString();
  db.quizzes[id] = {
    id,
    title: String(title || 'Untitled quiz').trim(),
    description: String(description || '').trim(),
    pass_mark: Math.min(100, Math.max(0, Number(pass_mark) || 70)),
    questions: cleanQuestions(questions),
    status: 'live',
    source: source || 'claude',
    created_at: now,
    updated_at: now,
  };
  db.responses[id] = [];
  save();
  return db.quizzes[id];
}

function updateQuiz(id, patch) {
  const q = db.quizzes[id];
  if (!q) return null;
  if (patch.title !== undefined) q.title = String(patch.title).trim() || q.title;
  if (patch.description !== undefined) q.description = String(patch.description).trim();
  if (patch.pass_mark !== undefined) q.pass_mark = Math.min(100, Math.max(0, Number(patch.pass_mark) || 0));
  if (patch.status === 'live' || patch.status === 'closed') q.status = patch.status;
  if (Array.isArray(patch.questions)) q.questions = cleanQuestions(patch.questions);
  q.updated_at = new Date().toISOString();
  save();
  return q;
}

function deleteQuiz(id) {
  if (!db.quizzes[id]) return false;
  delete db.quizzes[id];
  delete db.responses[id];
  save();
  return true;
}

const getQuiz = (id) => db.quizzes[id] || null;
const listQuizzes = () =>
  Object.values(db.quizzes)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((q) => ({ ...q, response_count: (db.responses[q.id] || []).length }));

function addResponse(id, name, answers) {
  const quiz = db.quizzes[id];
  if (!quiz) return null;
  let score = 0;
  const graded = quiz.questions.map((q) => {
    const picked = answers[q.id];
    const correct = picked === q.correct_option;
    if (correct) score++;
    return { question_id: q.id, picked: picked === undefined ? null : picked, correct };
  });
  const total = quiz.questions.length;
  const percent = total ? Math.round((score / total) * 100) : 0;
  const r = {
    id: newId(),
    name: String(name || 'Anonymous').trim().slice(0, 80) || 'Anonymous',
    score, total, percent,
    passed: percent >= quiz.pass_mark,
    answers: graded,
    submitted_at: new Date().toISOString(),
  };
  (db.responses[id] = db.responses[id] || []).push(r);
  save();
  return r;
}

function results(id) {
  const quiz = db.quizzes[id];
  if (!quiz) return null;
  const rs = db.responses[id] || [];
  const per_question = quiz.questions.map((q) => {
    const ans = rs.map((r) => r.answers.find((a) => a.question_id === q.id)).filter(Boolean);
    const right = ans.filter((a) => a.correct).length;
    const option_counts = q.options.map((_, i) => ans.filter((a) => a.picked === i).length);
    return {
      question_id: q.id,
      question: q.question,
      correct_answer: q.options[q.correct_option],
      percent_correct: ans.length ? Math.round((right / ans.length) * 100) : null,
      option_counts,
    };
  });
  const avg = rs.length ? Math.round(rs.reduce((s, r) => s + r.percent, 0) / rs.length) : null;
  return {
    quiz_id: id,
    title: quiz.title,
    responses: rs.length,
    average_percent: avg,
    pass_rate: rs.length ? Math.round((rs.filter((r) => r.passed).length / rs.length) * 100) : null,
    per_question,
    people: rs.map((r) => ({ name: r.name, score: `${r.score}/${r.total}`, percent: r.percent, passed: r.passed, submitted_at: r.submitted_at })),
  };
}

// Seed one example so a fresh install (or a restarted free host) never looks empty.
if (Object.keys(db.quizzes).length === 0) {
  createQuiz({
    title: 'Expense Policy Check — New Joiners',
    description: 'A 4-question check on the company expense policy. Takes 2 minutes.',
    pass_mark: 75,
    source: 'claude',
    questions: [
      { question: 'Within how many days must an expense be submitted?', options: ['7 days', '30 days', '90 days', 'Any time before year end'], correct_option: 1, explanation: 'Expenses must be submitted within 30 days so they land in the right month’s books.' },
      { question: 'What do you need for any expense above ₹2,000?', options: ['Nothing', 'A verbal OK', 'An itemised receipt', 'A photo of the item'], correct_option: 2, explanation: 'Anything above ₹2,000 needs an itemised receipt attached.' },
      { question: 'Who approves team dinners?', options: ['Finance', 'Your manager', 'HR', 'No one'], correct_option: 1, explanation: 'Your manager approves team spends; Finance only audits.' },
      { question: 'Personal purchases on the company card are…', options: ['Fine if repaid', 'Fine under ₹500', 'Not allowed', 'Allowed on weekends'], correct_option: 2, explanation: 'The company card is for business spend only.' },
    ],
  });
}

module.exports = { createQuiz, updateQuiz, deleteQuiz, getQuiz, listQuizzes, addResponse, results };
