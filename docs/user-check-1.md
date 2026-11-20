# Early user check 1: "What's inside?" (phase 1 task 9)

**Goal:** watch 1–2 working developers install Binlight and answer one
question about a binary **without help**. Fix what confuses them before
starting recipe 2 ("Does it phone home?").

This is not the gate study (task 16). It is a cheap early look: one session per
person, about 30 minutes, notes on paper.

## Who

- Working developers who use the terminal daily and have **not** seen Binlight.
- A Mac (Apple Silicon or Intel) with Homebrew. They use **their own** machine:
  a clean install on a stranger's Mac is the point.
- Not security specialists (they are the second audience).

## Before the session (owner)

- [ ] **Repo access.** The repo is private: add them as a read-only
      collaborator on GitHub, or send a zip of `main` (then skip `git clone`).
- [ ] Ask them to have ready: Node.js 22+ (`node -v`) and Xcode Command Line
      Tools (`xcode-select -p`). Don't install anything else for them.
- [ ] Ask them to have at least one command-line tool from Homebrew
      (`kubectl`, `gh`, `go`, `ollama`, …). If they have none, use an app in
      `/Applications`.
- [ ] Remind them: only analyse software they own, open-source software, or
      software they are allowed to inspect.
- [ ] Print the notes sheet below, one per person. Have a timer.
- [ ] Decide how you'll watch: next to them, or screen share with their camera
      on their hands/screen. Record only if they agree.

## Rules for the observer

- Don't explain, don't point, don't touch the keyboard. Silence is fine.
- If they ask you something, answer: "What would you try?" and write the
  question down. It's a finding.
- If they are stuck for **3 minutes**, give the smallest hint that unblocks
  them, write down exactly what you said, and mark the task **assisted**.
- Ask them to think aloud. Write down their words, especially surprise,
  doubt and "I'd expect…".

## Script

Read this out:

> Thanks for helping. I'm testing the tool, not you; if something's confusing,
> that's the tool's fault and exactly what I need to find. Please think aloud.
> I won't help unless you're really stuck. You can stop at any time.

Then give one task at a time, on a card or in chat:

1. **Install.** "Here's the repository. Install it and get it running, using
   only its README."
   Done when the page is open at http://127.0.0.1:5173.
2. **Ask a question.** "Pick a command-line tool you use. Find out what it's
   built from, and whether it's current."
   Done when they read the verdict and can say it back in their own words.
3. **Trust a claim.** "Pick one sentence in the answer. Show me what it's
   based on."
   Done when they open the cited finding or the evidence behind it.
4. **Share it.** "Save something you could send to a colleague who doesn't
   have Binlight."
   Done when they have the downloaded HTML report and have opened it.
5. **Optional, if time allows.** "Try an app from your Applications folder."

## Debrief (5 minutes)

1. In one sentence, what does Binlight do?
2. What did the answer tell you that you didn't know?
3. Was there a moment you didn't trust what it said? Where?
4. What did you expect to see that wasn't there?
5. Would you use this again? For what?

## Notes sheet

Person: ____________ Date: ________ Mac: ____________ Node: ______

| Task             | Unaided / assisted / gave up | Time | Where they hesitated or went wrong | Their words |
| ---------------- | ---------------------------- | ---- | ---------------------------------- | ----------- |
| 1 Install        |                              |      |                                    |             |
| 2 Ask a question |                              |      |                                    |             |
| 3 Trust a claim  |                              |      |                                    |             |
| 4 Share it       |                              |      |                                    |             |
| 5 App (optional) |                              |      |                                    |             |

Also note: which binary they chose, the first-start wait ("Getting REA
ready…"), any red error and whether they understood it.

## Known rough edges (don't fix mid-session; note if they trip on them)

- **First start after install:** REA builds Swift helpers once, 30–90 s
  depending on the Mac. The page shows "Getting REA ready…" meanwhile.
- **Two terminals:** server and page are started separately.
- **Wording to watch:** "Ignore cached results", "ad-hoc signed",
  "hardened runtime", "evidence ID", "REA".
- **Scripts aren't analysed:** an app whose executable is a script (e.g.
  Anaconda-Navigator) fails at the first step with that reason.
- **"Is it current"** covers only the Go version (major release), offline. It
  does not check whether dependencies are outdated or vulnerable.

## After each session

- Within the hour, copy the notes into a "Findings" section at the end of this
  file: what happened, how often, and how bad (blocked / slowed / annoyed).
- Turn each blocker into a fix before the next person, if it's small.
- After both sessions, tick task 9 in `docs/phase-1-plan.md` with a short
  summary and what was changed.

## Prepared and checked (20 Nov 2026)

- A fresh clone with an empty home folder installs in about 10 s
  (`npm install`, warm npm cache) and runs "What's inside?" on kubectl.
- Found and fixed during prep:
  - The first job on a fresh install spent 35 s in its first step with no
    explanation (REA's one-time Swift build). Now the server does it at start,
    the page says so, and the 60 s limit that could have failed it on a slower
    Mac is now 5 min.
  - Starting only the page showed "HTTP 502" errors. It now says to start the
    server, and reloads when the server answers.
  - "no deep-analysis route on this machine" appeared on every "What's
    inside?" job, though that recipe never uses one. Removed for such recipes.
  - Docker Desktop's backend failed the Go step (replaced modules have no
    checksum), and so did Homebrew's `go` (no main module). Both fixed; Docker
    Desktop's 468 dependencies match `go version -m` exactly.
  - README: quick start added; Ghidra/Docker marked as needed only for Raw
    analysis; Xcode Command Line Tools listed.
- Swept every app in `/Applications` on this Mac (37) plus `gh`, `node`, `go`,
  `ssh` and `ls`: all finish, except Anaconda-Navigator (a Python script,
  refused with that reason).
