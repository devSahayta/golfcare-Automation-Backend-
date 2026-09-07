// src/services/salesAgent/enrolmentQuestions.js
//
// The fixed Part A sequence, per GolfCare_Membership_Enrolment_Spec §2.
// Order matters — this is a one-time sequence, not the priority queue
// used for Part C progressive profiling (that stays in contextAssembler).

const ENROLMENT_QUESTIONS = [
  { fieldKey: "firstName", prompt: "What should I call you?", payoff: null },
  {
    fieldKey: "homeClub",
    prompt: "And where do you usually play?",
    payoff:
      "it helps us know when we're doing a fitting or a stock drop near you",
  },
  {
    fieldKey: "skillLevel",
    prompt:
      "Roughly where's your game at right now — just starting out, 20+ handicap, 10–20, single figures, or want to give me your exact number?",
    payoff: "so we're recommending the right kit, not the most expensive kit",
  },
  {
    fieldKey: "playFrequency",
    prompt:
      "How often do you get out at the moment — 2+ times a week, weekly, every couple of weeks, or once a month or less?",
    payoff:
      "we'll only nudge you about balls and gloves when you're actually likely to need them",
  },
  {
    fieldKey: "gloveHand",
    prompt: "Which hand do you wear your glove on — left or right?",
    payoff: "so anything we suggest is the right one first time",
  },
  {
    fieldKey: "gloveSize",
    prompt: "And what size — S, M, L, XL, cadet, or not sure?",
    payoff: null,
  },
  {
    fieldKey: "currentBallModel",
    prompt: "What ball are you playing right now?",
    payoff: "we'll keep your usual in stock for you",
  },
  {
    fieldKey: "marketingConsent",
    prompt:
      "Last thing — I'll drop you the occasional update on WhatsApp when something worth knowing comes up (restocks, new arrivals, offers) — that work for you?",
    payoff: null,
  },
];

// Map free-text answers to Prisma enums — the model will say
// "just starting out", not "BEGINNER", so this translation has to happen
// in code, not left to the model to guess the exact enum spelling.
const SKILL_LEVEL_MAP = [
  { re: /just start|beginner|new to/i, value: "BEGINNER" },
  { re: /20\s?\+|improver/i, value: "IMPROVER" },
  { re: /10\s?[-–]\s?20|intermediate/i, value: "INTERMEDIATE" },
  { re: /single figure|advanced/i, value: "ADVANCED" },
  { re: /pro\b/i, value: "PRO" },
];
function mapSkillLevel(answer) {
  const hit = SKILL_LEVEL_MAP.find((m) => m.re.test(answer || ""));
  return hit ? hit.value : null; // null = they likely gave an exact handicap number instead; caller falls back to handicap field
}

const PLAY_FREQ_MAP = [
  { re: /2\+|twice|multiple times a week/i, value: "WEEKLY_PLUS" },
  { re: /^weekly|once a week/i, value: "WEEKLY" },
  { re: /couple of weeks|fortnight/i, value: "FORTNIGHTLY" },
  { re: /once a month|monthly/i, value: "MONTHLY" },
  { re: /less|occasional|rarely/i, value: "OCCASIONAL" },
];
function mapPlayFrequency(answer) {
  const hit = PLAY_FREQ_MAP.find((m) => m.re.test(answer || ""));
  return hit ? hit.value : null;
}

function mapGloveHand(answer) {
  if (/left/i.test(answer || "")) return "LEFT";
  if (/right/i.test(answer || "")) return "RIGHT";
  return null;
}

// §2 Step 6 — declared budgetTier seed, keyword-matched against free text.
// Overwritten by revealed spend once ≥2 orders exist (main spec §M3.4) — not built yet.
const TOUR_BALL_KEYWORDS = [
  "pro v1",
  "chrome soft x",
  "chrome soft triple track",
  "tp5",
  "z-star",
];
const VALUE_BALL_KEYWORDS = [
  "supersoft",
  "velocity",
  "warbird",
  "q star",
  "distance",
];

function classifyBallBudgetTier(answer) {
  const text = (answer || "").toLowerCase();
  if (/whatever'?s in the bag|not sure|don'?t know/.test(text)) return null;
  if (TOUR_BALL_KEYWORDS.some((k) => text.includes(k))) return "PREMIUM";
  if (VALUE_BALL_KEYWORDS.some((k) => text.includes(k))) return "VALUE";
  return "MID"; // named a real model but not a recognized tour/value ball — safe middle default
}

// Consent stays a genuine yes/no gate (DPDP opt-in requirement), just asked
// last instead of upfront, and phrased as a natural question rather than a
// legal form. Ambiguous answers default to false — never assume consent.
function mapMarketingConsent(answer) {
  const text = (answer || "").toLowerCase();
  if (/\b(no|nah|nope|don'?t|stop|not really)\b/.test(text)) return false;
  if (
    /\b(yes|yea|yeah|yep|sure|ok(ay)?|fine|sounds good|go ahead|works)\b/.test(
      text,
    )
  )
    return true;
  return null; // ambiguous — caller treats as false, the safe default
}

module.exports = {
  ENROLMENT_QUESTIONS,
  mapSkillLevel,
  mapPlayFrequency,
  mapGloveHand,
  classifyBallBudgetTier,
  mapMarketingConsent,
};
