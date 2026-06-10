---
description: Append or update today's BrainLift entry from this session's work
allowed-tools: Bash(git log:*), Bash(git diff:*), Bash(git status:*), Read, Edit, Write
---

Update `BRAINLIFT.md` (repo root) with today's entry. The file is a learning
log: one entry per working day, newest first, three sections per entry —
**Progress**, **AI interactions that accelerated learning**, and
**Challenges → solutions**. Read the header of `BRAINLIFT.md` for the format
and an existing entry for the voice.

Steps:

1. Run `git log --since=midnight --pretty="%h %ad %s" --date=format:"%H:%M"`
   to anchor Progress to what actually landed today. Also check
   `git status --short` for significant uncommitted work worth mentioning.
2. Reflect on the *current conversation* for the other two sections:
   - Which prompts, debugging techniques or AI workflows genuinely sped
     things up (or wasted time — those count too)?
   - What broke, why (root cause, not symptom), and what fixed it?
3. If an entry for today (`## YYYY-MM-DD`) already exists, merge the new
   material into it — do not duplicate bullets or create a second heading.
   Otherwise insert a new entry directly under the `---` separator, above
   the previous newest entry.
4. Keep it honest and specific. Short, true bullets; no filler, no
   achievements-speak. If a section has nothing new today, leave it out of
   the merge rather than padding it.

If extra context is passed as arguments, treat it as material the user wants
included: $ARGUMENTS
