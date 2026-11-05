# PopQuiz — Claude writes the quiz, PopQuiz runs it

Your Claude writes a quiz. PopQuiz turns it into a live, shareable link that people take on any phone, auto-grades every answer, and shows you who passed and which questions tripped them up.

**No AI inside.** PopQuiz has no OpenAI/Anthropic keys. All thinking and writing happens in the customer's own Claude, via MCP. PopQuiz only stores, edits, hosts and grades.

## Connect to Claude
1. claude.ai → **Settings → Connectors → Add custom connector**
2. Name: `PopQuiz`. URL: `https://<your-app>/mcp`. Click **Add** (no sign-in).
3. In a new chat, turn PopQuiz on in the tools menu and ask:
   *"Use PopQuiz to make a 5-question quiz on our leave policy for new joiners."*
4. Open the edit link Claude returns. Test login: `demo` / `popquiz2026`.

## MCP tools
| Tool | What it does |
|---|---|
| `create_quiz` | Publish a quiz → share link + edit link |
| `list_quizzes` | All quizzes with response counts |
| `get_quiz` | Latest version, including human edits |
| `update_quiz` | Change questions, pass mark, open/close |
| `get_quiz_results` | Average, pass rate, % correct per question, per-person scores |

## Pages
- `/` — landing + connect steps
- `/dashboard` — all quizzes (login)
- `/edit/:id` — edit questions, answers, explanations, pass mark, status (login)
- `/results/:id` — live results, hardest questions first (login)
- `/q/:id` — public quiz page; correct answers are never sent to the browser before submit

## Run
```
npm install
npm start          # PORT, ADMIN_USER, ADMIN_PASS, SESSION_SECRET, DATA_DIR optional
```
Stack: Node + Express + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless). Storage: one JSON file.
