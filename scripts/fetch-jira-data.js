
/**
 * fetch-jira-data.js
 * Place this file at: scripts/fetch-jira-data.js in the GitHub repo.
 *
 * Pulls live delivery metrics from Jira and writes data.json for the
 * POD Delivery Dashboard (index.html) to read.
 *
 * Run by .github/workflows/update-dashboard-data.yml on a schedule.
 *
 * Env vars required (set as GitHub Actions secrets):
 *   JIRA_BASE_URL   e.g. https://apspayroll.atlassian.net
 *   JIRA_EMAIL      the Jira account email tied to the API token
 *   JIRA_API_TOKEN  Jira Cloud API token (id.atlassian.com/manage-profile/security/api-tokens)
 *
 * IMPORTANT / CURRENT STATE (July 2026):
 * There is no "Pod" or "Delivery Manager" field in Jira today, so this
 * script reports metrics per real Jira PROJECT (INV, APCOM, EMP, CORE,
 * MOBILE, BOA, EXP, HR). When Pods/DMs are introduced in Jira (e.g. as a
 * label or component convention), update PROJECTS below and the grouping
 * logic in main() -- the JQL, cycle time, quality, and AI-leverage math
 * all stay the same.
 *
 * NOTE: Uses Jira Cloud's newer POST /rest/api/3/search/jql endpoint
 * (the old GET /rest/api/3/search endpoint was retired by Atlassian --
 * see https://developer.atlassian.com/changelog/#CHANGE-2046). This new
 * endpoint paginates with nextPageToken instead of startAt.
 */
 
const PROJECTS = ["INV", "APCOM", "EMP", "CORE", "MOBILE", "BOA", "EXP", "HR"];
 
const BASE_URL = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
 
if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error("Missing JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN environment variables.");
  process.exit(1);
}
 
const AUTH = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
 
// Standard Jira status category order: To Do -> In Progress -> Done
const CATEGORY_ORDER = { 2: 0, 4: 1, 3: 2 }; // new=2, indeterminate=4, done=3
 
async function jiraFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: AUTH, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Jira API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
 
async function searchAll(jql, fields, expand, cap = 500) {
  const issues = [];
  let nextPageToken;
  while (issues.length < cap) {
    const body = {
      jql,
      maxResults: 100,
      fields,
      ...(expand ? { expand } : {}),
      ...(nextPageToken ? { nextPageToken } : {}),
    };
    const res = await fetch(`${BASE_URL}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    issues.push(...data.issues);
    if (data.isLast || !data.nextPageToken || !data.issues.length) break;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}
 
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
 
function isAiComponent(name) {
  return /claude|ai/i.test(name || "");
}
 
function isBlockedComponent(name) {
  return /blocked/i.test(name || "");
}
 
/** Analyze one issue's status changelog for cycle time + regressions. */
function analyzeIssue(issue, statusCategoryByName) {
  const created = new Date(issue.fields.created).getTime();
  const resolved = issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate).getTime() : null;
 
  const histories = (issue.changelog?.histories || [])
    .flatMap((h) =>
      h.items
        .filter((i) => i.field === "status")
        .map((i) => ({ ts: new Date(h.created).getTime(), from: i.fromString, to: i.toString }))
    )
    .sort((a, b) => a.ts - b.ts);
 
  let startInProgress = null;
  let regressions = 0;
 
  for (const t of histories) {
    const fromCat = statusCategoryByName[t.from];
    const toCat = statusCategoryByName[t.to];
    if (startInProgress === null && toCat === 4) startInProgress = t.ts;
    if (fromCat != null && toCat != null && CATEGORY_ORDER[toCat] < CATEGORY_ORDER[fromCat]) {
      regressions++;
    }
  }
 
  // Edge case: issue created directly into an in-progress/done status with no changelog.
  if (startInProgress === null && histories.length === 0) {
    const curCat = statusCategoryByName[issue.fields.status.name];
    if (curCat === 4 || curCat === 3) startInProgress = created;
  }
 
  let cycleTimeDays = null;
  if (resolved && startInProgress) {
    cycleTimeDays = (resolved - startInProgress) / 86400000;
  }
 
  const hadTransition = histories.length > 0;
  const isAiTagged = (issue.fields.components || []).some((c) => isAiComponent(c.name));
 
  return { cycleTimeDays, regressed: regressions > 0, hadTransition, isAiTagged, resolved };
}
 
async function fetchStatusCategoryMap() {
  const statuses = await jiraFetch("/rest/api/3/status");
  const map = {};
  for (const s of statuses) map[s.name] = s.statusCategory.id;
  return map;
}
 
async function analyzeProject(key, statusCategoryByName) {
  // WIP snapshot: all currently open issues, grouped by status.
  const wipIssues = await searchAll(`project = ${key} AND statusCategory != Done`, ["status"]);
  const wipByStatus = {};
  for (const issue of wipIssues) {
    const name = issue.fields.status.name;
    wipByStatus[name] = (wipByStatus[name] || 0) + 1;
  }
 
  // Recent activity window for cycle time / quality / AI-leverage / throughput.
  const recentIssues = await searchAll(
    `project = ${key} AND resolutiondate >= -30d`,
    ["created", "resolutiondate", "components", "status"],
    ["changelog"]
  );
 
  const analyzed = recentIssues.map((i) => analyzeIssue(i, statusCategoryByName));
  const withCycleTime = analyzed.filter((a) => a.cycleTimeDays !== null).map((a) => a.cycleTimeDays);
  const withTransitions = analyzed.filter((a) => a.hadTransition);
  const regressed = withTransitions.filter((a) => a.regressed);
  const resolved30d = analyzed.length;
  const resolved7d = analyzed.filter((a) => Date.now() - a.resolved <= 7 * 86400000).length;
  const aiTagged30d = analyzed.filter((a) => a.isAiTagged).length;
 
  // Open blockers: WIP issues tagged with a "Blocked" component.
  const blockerIssues = await searchAll(`project = ${key} AND statusCategory != Done AND component is not EMPTY`, ["components"]);
  const openBlockers = blockerIssues.filter((i) => (i.fields.components || []).some((c) => isBlockedComponent(c.name))).length;
 
  return {
    key,
    wipByStatus,
    wipTotal: wipIssues.length,
    cycleTimeDays: {
      avg: withCycleTime.length ? Number((withCycleTime.reduce((a, b) => a + b, 0) / withCycleTime.length).toFixed(1)) : null,
      median: withCycleTime.length ? Number(median(withCycleTime).toFixed(1)) : null,
      sampleSize: withCycleTime.length,
    },
    throughput7d: resolved7d,
    throughput30d: resolved30d,
    qualityLoopbackRatePct: withTransitions.length ? Number(((regressed.length / withTransitions.length) * 100).toFixed(1)) : null,
    aiLeverageRatePct: resolved30d ? Number(((aiTagged30d / resolved30d) * 100).toFixed(1)) : null,
    openBlockers,
  };
}
 
async function main() {
  const statusCategoryByName = await fetchStatusCategoryMap();
 
  const projects = [];
  for (const key of PROJECTS) {
    console.log(`Analyzing ${key}...`);
    try {
      projects.push(await analyzeProject(key, statusCategoryByName));
    } catch (err) {
      console.error(`Failed to analyze ${key}: ${err.message}`);
      projects.push({ key, error: err.message });
    }
  }
 
  const out = {
    generatedAt: new Date().toISOString(),
    groupingNote:
      "Metrics are grouped by real Jira project (no Pod/DM field exists yet). Update PROJECTS + grouping in fetch-jira-data.js once Pods/DMs are tracked in Jira.",
    projects,
    manual: {
      focusIntegrity: null,
      teamPulse: null,
      note: "Focus Integrity and Team Pulse are not derivable from Jira data. Populate manually (e.g. from a survey tool) until a data source is identified.",
    },
  };
 
  require("fs").writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("Wrote data.json");
}
 
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
