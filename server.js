// PopQuiz — Claude writes the quiz, PopQuiz runs it.
// No AI inside: this server only stores, edits, hosts and grades quizzes.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'demo';
const ADMIN_PASS = process.env.ADMIN_PASS || 'popquiz2026';
const SECRET = process.env.SESSION_SECRET || 'popquiz-dev-secret';
const SESSION = crypto.createHmac('sha256', SECRET).update(ADMIN_USER + ':' + ADMIN_PASS).digest('hex');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, f));

// ---------- auth (one shared demo account for v1) ----------
function loggedIn(req) {
  const c = req.headers.cookie || '';
  return c.split(';').some((p) => p.trim() === `pq_session=${SESSION}`);
}
function requireLogin(req, res, next) {
  if (loggedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.setHeader('Set-Cookie', `pq_session=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong username or password' });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'pq_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- pages ----------
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/dashboard', requireLogin, page('dashboard.html'));
app.get('/edit/:id', requireLogin, page('edit.html'));
app.get('/results/:id', requireLogin, page('results.html'));
app.get('/q/:id', page('take.html'));
app.get('/static/:f', (req, res) => (['style.css', 'app.js'].includes(req.params.f) ? res.sendFile(path.join(__dirname, req.params.f)) : res.sendStatus(404)));

// ---------- creator API (login) ----------
app.get('/api/quizzes', requireLogin, (req, res) => res.json(store.listQuizzes()));
app.get('/api/quizzes/:id', requireLogin, (req, res) => {
  const q = store.getQuiz(req.params.id);
  q ? res.json(q) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/quizzes', requireLogin, (req, res) => res.json(store.createQuiz({ ...req.body, source: 'manual' })));
app.put('/api/quizzes/:id', requireLogin, (req, res) => {
  const q = store.updateQuiz(req.params.id, req.body || {});
  q ? res.json(q) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/quizzes/:id', requireLogin, (req, res) => res.json({ ok: store.deleteQuiz(req.params.id) }));
app.get('/api/quizzes/:id/results', requireLogin, (req, res) => {
  const r = store.results(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Not found' });
});

// ---------- public API (quiz takers; answers are never sent to the browser) ----------
app.get('/api/public/:id', (req, res) => {
  const q = store.getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quiz not found' });
  res.json({
    id: q.id, title: q.title, description: q.description, status: q.status, pass_mark: q.pass_mark,
    questions: q.questions.map(({ id, question, options }) => ({ id, question, options })),
  });
});
app.post('/api/public/:id/submit', (req, res) => {
  const q = store.getQuiz(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quiz not found' });
  if (q.status !== 'live') return res.status(403).json({ error: 'This quiz is closed' });
  const r = store.addResponse(q.id, req.body.name, req.body.answers || {});
  res.json({
    ...r,
    pass_mark: q.pass_mark,
    review: q.questions.map((qq) => ({
      id: qq.id, question: qq.question, options: qq.options,
      correct_option: qq.correct_option, explanation: qq.explanation,
      picked: r.answers.find((a) => a.question_id === qq.id)?.picked ?? null,
    })),
  });
});

// ---------- MCP: the plug between the customer's Claude and PopQuiz ----------
const QuestionSchema = z.object({
  question: z.string().describe('The question text'),
  options: z.array(z.string()).min(2).max(6).describe('2–6 answer choices'),
  correct_option: z.number().int().min(0).describe('0-based index of the correct choice in options'),
  explanation: z.string().optional().describe('Shown to the learner after they submit: why the answer is right'),
});

function buildMcp(base) {
  const server = new McpServer({ name: 'popquiz', version: '1.0.0' });
  const links = (q) => ({ share_link: `${base}/q/${q.id}`, edit_link: `${base}/edit/${q.id}`, results_link: `${base}/results/${q.id}` });
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

  server.registerTool('create_quiz', {
    title: 'Create quiz',
    description:
      'Publish a multiple-choice quiz on PopQuiz. Returns a public share link people can take right away (auto-graded), ' +
      'plus an edit link for the creator. Write clear questions with one correct answer and a short explanation each. ' +
      'Always show the user the share_link and edit_link afterwards.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional().describe('One or two lines shown at the top of the quiz'),
      pass_mark: z.number().min(0).max(100).optional().describe('Pass mark in percent (default 70)'),
      questions: z.array(QuestionSchema).min(1).max(50),
    },
  }, async (args) => {
    const q = store.createQuiz(args);
    return text({ quiz_id: q.id, title: q.title, questions: q.questions.length, ...links(q), note: 'Quiz is live. Log in with the demo account to edit.' });
  });

  server.registerTool('list_quizzes', {
    title: 'List quizzes',
    description: 'List all quizzes on PopQuiz with their links and how many people have taken each.',
    inputSchema: {},
  }, async () => text(store.listQuizzes().map((q) => ({
    quiz_id: q.id, title: q.title, status: q.status, questions: q.questions.length, responses: q.response_count, ...links(q),
  }))));

  server.registerTool('get_quiz', {
    title: 'Get quiz',
    description: 'Get the full current content of a quiz, including any edits a person made in PopQuiz.',
    inputSchema: { quiz_id: z.string() },
  }, async ({ quiz_id }) => {
    const q = store.getQuiz(quiz_id);
    return q ? text({ ...q, ...links(q) }) : text({ error: 'Quiz not found' });
  });

  server.registerTool('update_quiz', {
    title: 'Update quiz',
    description: 'Change a quiz. Pass only the fields to change. Passing questions replaces the whole question list. status can be "live" or "closed".',
    inputSchema: {
      quiz_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      pass_mark: z.number().min(0).max(100).optional(),
      status: z.enum(['live', 'closed']).optional(),
      questions: z.array(QuestionSchema).optional(),
    },
  }, async ({ quiz_id, ...patch }) => {
    const q = store.updateQuiz(quiz_id, patch);
    return q ? text({ updated: true, ...links(q) }) : text({ error: 'Quiz not found' });
  });

  server.registerTool('get_quiz_results', {
    title: 'Get quiz results',
    description: 'Get results for a quiz: average score, pass rate, % correct per question and each person\'s score. Use it to find weak topics and suggest follow-ups.',
    inputSchema: { quiz_id: z.string() },
  }, async ({ quiz_id }) => {
    const r = store.results(quiz_id);
    return r ? text(r) : text({ error: 'Quiz not found' });
  });

  return server;
}

// Stateless Streamable HTTP: a fresh server per request.
app.post('/mcp', async (req, res) => {
  try {
    const server = buildMcp(baseUrl(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
const noSession = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
app.get('/mcp', noSession);
app.delete('/mcp', noSession);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`PopQuiz on :${PORT}`));
